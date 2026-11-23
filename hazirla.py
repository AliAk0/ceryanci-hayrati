# -*- coding: utf-8 -*-
"""
Aydınlatma Denetim Rotası - Adım 1: Mahalle rotası hazırlama

Kullanım:
    python hazirla.py --mahalle "Beyazevler" --ilce "Çukurova"
    python hazirla.py --mahalle "Beyazevler" --ilce "Çukurova" --sinir sinir.geojson

Çıktı (cikti/ klasörü):
    <ilce>_<mahalle>.json   -> web uygulamasının kullanacağı veri
    <ilce>_<mahalle>.html   -> bilgisayarda kontrol haritası
"""
import argparse
import json
import math
import sys
from pathlib import Path

import networkx as nx
import osmnx as ox
from shapely.geometry import LineString, Point, shape
from shapely.ops import unary_union

CIKTI = Path(__file__).parent / "cikti"         # kontrol haritaları (yerel)
WEB_VERI = Path(__file__).parent / "docs" / "veri"  # web uygulamasının verisi (GitHub Pages)
SINIRLAR = Path(__file__).parent / "sinirlar"   # elle çizilmiş sınırlar (<ilce>_<mahalle>.geojson)
TR_MAP = str.maketrans("çğıİöşüÇĞÖŞÜ ", "cgiiosucgosu_")


def slug(s):
    return s.strip().translate(TR_MAP).lower()


# ----------------------------------------------------------------------------
# 1) Sınır
# ----------------------------------------------------------------------------
def sinir_bul(mahalle, ilce, sinir_dosyasi=None):
    if sinir_dosyasi:
        with open(sinir_dosyasi, encoding="utf-8") as f:
            gj = json.load(f)
        feats = gj["features"] if gj.get("type") == "FeatureCollection" else [gj]
        geoms = [shape(ft["geometry"] if "geometry" in ft else ft) for ft in feats]
        poly = unary_union(geoms)
        print(f"[sınır] dosyadan okundu: {sinir_dosyasi}")
        return poly

    sorgular = [
        f"{mahalle} Mahallesi, {ilce}, Adana, Türkiye",
        f"{mahalle}, {ilce}, Adana, Türkiye",
    ]
    for q in sorgular:
        try:
            gdf = ox.geocode_to_gdf(q)
        except Exception as e:
            print(f"[sınır] bulunamadı: '{q}' ({e.__class__.__name__})")
            continue
        geom = gdf.geometry.iloc[0]
        if geom.geom_type not in ("Polygon", "MultiPolygon"):
            print(f"[sınır] '{q}' poligon değil ({geom.geom_type}), atlanıyor")
            continue
        r = gdf.iloc[0]
        print(f"[sınır] bulundu: {r.get('display_name', q)}")
        print(f"        osm: {r.get('osm_type')}/{r.get('osm_id')}  "
              f"tip: {r.get('class')}/{r.get('type')}")
        return geom

    sys.exit("[HATA] Mahalle sınırı OSM'de bulunamadı. geojson.io'da çizip "
             "--sinir dosya.geojson ile verin.")


def tampon(poly, metre):
    p_proj, crs = ox.projection.project_geometry(poly)
    buf, _ = ox.projection.project_geometry(p_proj.buffer(metre), crs=crs, to_latlong=True)
    return buf


# ----------------------------------------------------------------------------
# 2) Yardımcılar
# ----------------------------------------------------------------------------
def kenar_cizgisi(G, u, v, k):
    """u->v yönünde LineString (lon, lat) döndürür."""
    d = G.edges[u, v, k]
    if "geometry" in d:
        coords = list(d["geometry"].coords)
        ux, uy = G.nodes[u]["x"], G.nodes[u]["y"]
        if (coords[0][0] - ux) ** 2 + (coords[0][1] - uy) ** 2 > \
           (coords[-1][0] - ux) ** 2 + (coords[-1][1] - uy) ** 2:
            coords.reverse()
        return LineString(coords)
    return LineString([(G.nodes[u]["x"], G.nodes[u]["y"]),
                       (G.nodes[v]["x"], G.nodes[v]["y"])])


def en_kisa_anahtar(G, u, v):
    return min(G[u][v], key=lambda k: G[u][v][k].get("length", 1))


def ad_al(d):
    n = d.get("name")
    if isinstance(n, list):
        n = " / ".join(dict.fromkeys(n))
    return n or ""


SINIR_MESAFE = 30  # metre
SINIR_HARIC = {"motorway", "motorway_link", "trunk", "trunk_link"}


def _liste(x):
    if x is None:
        return []
    return x if isinstance(x, list) else [x]


def tek_yon_mu(d):
    o = d.get("oneway", False)
    if isinstance(o, list):
        o = any(o)
    return o in (True, "yes", "true", "1", -1, "-1")


# ----------------------------------------------------------------------------
# 3) Rota çözümü (karışık graf - kırsal postacı sezgiseli)
# ----------------------------------------------------------------------------
def _coz_ilp(G, tek_yonler, iki_yon, yay_sokak):
    """
    Tam sayılı programlama (HiGHS) ile en kısa kapsama:
      değişken x_a  = a yayından kaç kez geçileceği
      tek yön zorunlu : x_a >= 1
      iki yön zorunlu : x_uv + x_vu >= 1
      her düğümde     : giren = çıkan
      amaç            : toplam uzunluk en küçük
    """
    import numpy as np
    from scipy.optimize import milp, LinearConstraint, Bounds
    from scipy.sparse import coo_matrix

    yaylar = list(G.edges(keys=True))
    idx = {a: i for i, a in enumerate(yaylar)}
    dugum = {n: i for i, n in enumerate(G.nodes)}
    n_y, n_d = len(yaylar), len(dugum)
    c = np.array([max(G.edges[a].get("length", 1), 0.1) for a in yaylar])

    # Denge kısıtları
    r, cc, v = [], [], []
    for i, (a, b, _) in enumerate(yaylar):
        r += [dugum[a], dugum[b]]; cc += [i, i]; v += [1, -1]
    A_denge = coo_matrix((v, (r, cc)), shape=(n_d, n_y)).tocsr()
    kisitlar = [LinearConstraint(A_denge, 0, 0)]

    # İki yönlü kapsama kısıtları
    if iki_yon:
        r, cc = [], []
        for j, yonler in enumerate(iki_yon.values()):
            for (x, y), kk in yonler.items():
                r.append(j); cc.append(idx[(x, y, kk)])
        A_kap = coo_matrix((np.ones(len(r)), (r, cc)), shape=(len(iki_yon), n_y)).tocsr()
        kisitlar.append(LinearConstraint(A_kap, 1, np.inf))

    alt = np.zeros(n_y)
    for a in tek_yonler:
        alt[idx[a]] = 1
    ust = np.full(n_y, 4.0)

    sonuc = milp(c, constraints=kisitlar, integrality=np.ones(n_y),
                 bounds=Bounds(alt, ust), options={"time_limit": 120, "mip_rel_gap": 0.02})
    if sonuc.x is None:
        print(f"[uyarı] ILP çözüm bulamadı ({sonuc.message}), yaklaşık yönteme geçiliyor")
        return None
    if sonuc.status != 0:
        print(f"[uyarı] ILP: {sonuc.message} (en iyi bulunan çözüm kullanılıyor)")
    x = np.rint(sonuc.x).astype(int)

    E = nx.MultiDiGraph()
    kapsanan = set()
    for i, (a, b, k) in enumerate(yaylar):
        for _ in range(x[i]):
            sid = yay_sokak.get((a, b, k), -1)
            if sid in kapsanan:
                sid = -1
            elif sid >= 0:
                kapsanan.add(sid)
            E.add_edge(a, b, gk=k, sid=sid)
    return E


def _coz_sezgisel(G, tek_yonler, iki_yon, yay_sokak):
    """Yaklaşık yöntem: iki yönlüleri dengeli yönlendir + min-maliyet akış."""
    U = nx.MultiGraph()
    for anahtar, yonler in iki_yon.items():
        (a, b) = next(iter(yonler))
        U.add_edge(a, b, yonler=yonler)
    tekler = [n for n, deg in U.degree() if deg % 2 == 1]
    SAHTE = "__sahte__"
    for n in tekler:
        U.add_edge(SAHTE, n, yonler=None)

    zorunlu = list(tek_yonler)  # yönlü zorunlu yaylar
    for bilesen in nx.connected_components(U):
        alt = U.subgraph(bilesen)
        if alt.number_of_edges() == 0:
            continue
        for x, y, kk in nx.eulerian_circuit(alt, keys=True):
            yonler = U.edges[x, y, kk]["yonler"]
            if yonler is None:
                continue
            zorunlu.append((x, y, yonler[(x, y)]))

    denge = {}
    for u, v, _ in zorunlu:
        denge[u] = denge.get(u, 0) + 1   # çıkış
        denge[v] = denge.get(v, 0) - 1   # giriş
    H = nx.DiGraph()
    for u, v, k, d in G.edges(keys=True, data=True):
        w = max(1, int(round(d.get("length", 1))))
        if H.has_edge(u, v):
            H[u][v]["weight"] = min(H[u][v]["weight"], w)
        else:
            H.add_edge(u, v, weight=w)
    for n in H.nodes:
        # demand = çıkış - giriş ; giriş fazlası olan düğüm kaynak olur (negatif)
        H.nodes[n]["demand"] = denge.get(n, 0)
    akis = nx.min_cost_flow(H, demand="demand", weight="weight")

    E = nx.MultiDiGraph()
    for u, v, k in zorunlu:
        E.add_edge(u, v, gk=k, sid=yay_sokak[(u, v, k)])
    for u, hedefler in akis.items():
        for v, f in hedefler.items():
            for _ in range(f):
                E.add_edge(u, v, gk=en_kisa_anahtar(G, u, v), sid=-1)
    return E


def rota_coz(G, poly, yontem="ilp", sinir_mesafe=SINIR_MESAFE):
    """
    G   : osmnx MultiDiGraph (tamponlu alan, en büyük güçlü bağlı bileşen)
    poly: mahalle sınırı (lon/lat)

    Zorunlu sokak = orta noktası sınır içinde olan VEYA sınır çizgisi boyunca
    uzanan (uzunluğunun %70'i sınıra sinir_mesafe metreden yakın) yol.
    Otoyol/devlet yolu tipleri (SINIR_HARIC) sınır kuralıyla eklenmez.

    Dönüş: (sokaklar, rota_parcalari, ozet)
    """
    import numpy as np
    import shapely
    from pyproj import Transformer
    _, utm = ox.projection.project_geometry(poly)
    _tr = Transformer.from_crs("EPSG:4326", utm, always_xy=True).transform

    def projekte(g):
        return shapely.transform(g, lambda c: np.column_stack(_tr(c[:, 0], c[:, 1])))

    serit = projekte(poly.boundary).buffer(sinir_mesafe)

    def sinirda_mi(line, d):
        if set(_liste(d.get("highway"))) & SINIR_HARIC:
            return False
        lp = projekte(line)
        return lp.length > 0 and lp.intersection(serit).length >= 0.7 * lp.length

    # --- 3a) Zorunlu sokakları belirle
    tek_yonler = []          # [(u,v,k)]
    iki_yon = {}             # fiziksel_anahtar -> {(u,v):k, (v,u):k}
    sinir_yay = set()        # sınır kuralıyla eklenen yaylar
    for u, v, k, d in G.edges(keys=True, data=True):
        line = kenar_cizgisi(G, u, v, k)
        if not poly.contains(line.interpolate(0.5, normalized=True)):
            if not sinirda_mi(line, d):
                continue
            sinir_yay.add((u, v, k))
        elif sinirda_mi(line, d):
            sinir_yay.add((u, v, k))
        if tek_yon_mu(d):
            tek_yonler.append((u, v, k))
        else:
            anahtar = (min(u, v), max(u, v), round(d.get("length", 0)))
            iki_yon.setdefault(anahtar, {})[(u, v)] = k

    # İki yönlü olup bir yönü eksik kalanlar (nadiren) -> tek yön gibi davran
    for anahtar, yonler in list(iki_yon.items()):
        if len(yonler) < 2:
            (a, b), k = next(iter(yonler.items()))
            tek_yonler.append((a, b, k))
            del iki_yon[anahtar]

    if not tek_yonler and not iki_yon:
        sys.exit("[HATA] Sınır içinde araç yolu bulunamadı.")

    # Sokak kayıtları
    sokaklar = []
    yay_sokak = {}  # (u,v,k) -> sokak_id
    for (u, v, k) in tek_yonler:
        sid = len(sokaklar)
        d = G.edges[u, v, k]
        sokaklar.append({"id": sid, "ad": ad_al(d), "tek_yon": True,
                         "sinir": (u, v, k) in sinir_yay,
                         "uzunluk": round(d.get("length", 0), 1),
                         "cizgi": kenar_cizgisi(G, u, v, k)})
        yay_sokak[(u, v, k)] = sid
    for anahtar, yonler in iki_yon.items():
        sid = len(sokaklar)
        (a, b), k = next(iter(yonler.items()))
        d = G.edges[a, b, k]
        sokaklar.append({"id": sid, "ad": ad_al(d), "tek_yon": False,
                         "sinir": (a, b, k) in sinir_yay,
                         "uzunluk": round(d.get("length", 0), 1),
                         "cizgi": kenar_cizgisi(G, a, b, k)})
        for (x, y), kk in yonler.items():
            yay_sokak[(x, y, kk)] = sid

    # --- 3b) Hangi yaydan kaç kez geçileceğini hesapla
    E = _coz_ilp(G, tek_yonler, iki_yon, yay_sokak) if yontem == "ilp" else None
    if E is None:
        E = _coz_sezgisel(G, tek_yonler, iki_yon, yay_sokak)

    # --- 3c) Kopuk parçaları gidiş-dönüş yollarla bağla
    cx, cy = poly.centroid.x, poly.centroid.y
    baslangic = min((u for u, v, _ in yay_sokak),
                    key=lambda n: (G.nodes[n]["x"] - cx) ** 2 + (G.nodes[n]["y"] - cy) ** 2)
    while True:
        bilesenler = list(nx.weakly_connected_components(E))
        if len(bilesenler) == 1:
            break
        ana = next(b for b in bilesenler if baslangic in b)
        diger = set().union(*(b for b in bilesenler if b is not ana))
        mesafe, yollar = nx.multi_source_dijkstra(G, ana, weight="length")
        hedef = min((n for n in diger if n in mesafe), key=mesafe.get)
        git = yollar[hedef]
        don = nx.shortest_path(G, hedef, git[0], weight="length")
        for yol in (git, don):
            for a, b in zip(yol[:-1], yol[1:]):
                E.add_edge(a, b, gk=en_kisa_anahtar(G, a, b), sid=-1)

    if not nx.is_eulerian(E):
        sys.exit("[HATA] Rota kapatılamadı (graf Euler değil).")

    # --- 3d) Euler turu -> rota parçaları
    parcalar = []
    for u, v, ek in nx.eulerian_circuit(E, source=baslangic, keys=True):
        d = E.edges[u, v, ek]
        coords = list(kenar_cizgisi(G, u, v, d["gk"]).coords)
        uz = G.edges[u, v, d["gk"]].get("length", 0)
        son = parcalar[-1] if parcalar else None
        if son and son["s"] == -1 and d["sid"] == -1:
            son["c"].extend(coords[1:])
            son["m"] += uz
        else:
            parcalar.append({"s": d["sid"], "c": coords, "m": uz})

    sokak_m = sum(s["uzunluk"] for s in sokaklar)
    rota_m = sum(p["m"] for p in parcalar)
    sinir_s = [s for s in sokaklar if s["sinir"]]
    ozet = {"sokak_sayisi": len(sokaklar),
            "sinir_sokak_sayisi": len(sinir_s),
            "sinir_sokak_km": round(sum(s["uzunluk"] for s in sinir_s) / 1000, 2),
            "sokak_km": round(sokak_m / 1000, 2),
            "rota_km": round(rota_m / 1000, 2),
            "tekrar_orani": round(rota_m / sokak_m, 2) if sokak_m else None}
    return sokaklar, parcalar, ozet


# ----------------------------------------------------------------------------
# 4) Çıktılar
# ----------------------------------------------------------------------------
def latlon(coords, nd=5):
    return [[round(y, nd), round(x, nd)] for x, y in coords]


def poly_latlon(poly):
    polys = [poly] if poly.geom_type == "Polygon" else list(poly.geoms)
    return [latlon(p.exterior.coords) for p in polys]


def json_yaz(yol, mahalle, ilce, poly, sokaklar, parcalar, ozet):
    veri = {
        "mahalle": mahalle, "ilce": ilce, "ozet": ozet,
        "sinir": poly_latlon(poly),
        "sokaklar": [{"id": s["id"], "ad": s["ad"], "tek_yon": s["tek_yon"],
                      "sinir": s["sinir"],
                      "m": s["uzunluk"], "c": latlon(s["cizgi"].coords)}
                     for s in sokaklar],
        "rota": [{"s": p["s"], "c": latlon(p["c"])} for p in parcalar],
    }
    yol.write_text(json.dumps(veri, ensure_ascii=False, separators=(",", ":")),
                   encoding="utf-8")


def indeks_guncelle():
    """docs/veri içindeki tüm mahalle dosyalarından mahalleler.json üretir."""
    liste = []
    for f in sorted(WEB_VERI.glob("*.json")):
        if f.name == "mahalleler.json":
            continue
        try:
            d = json.loads(f.read_text(encoding="utf-8"))
        except Exception:
            print(f"[uyarı] okunamadı: {f.name}")
            continue
        liste.append({"dosya": f.name, "mahalle": d["mahalle"], "ilce": d["ilce"],
                      "sokak_km": d["ozet"]["sokak_km"], "rota_km": d["ozet"]["rota_km"]})
    tr = str.maketrans("çğıöşüÇĞİÖŞÜ", "cgiosuCGIOSU")
    liste.sort(key=lambda x: (x["ilce"].translate(tr), x["mahalle"].translate(tr)))
    (WEB_VERI / "mahalleler.json").write_text(
        json.dumps(liste, ensure_ascii=False, indent=1), encoding="utf-8")
    return len(liste)


def html_yaz(yol, mahalle, ilce, poly, sokaklar, parcalar, ozet):
    import folium
    from folium.plugins import AntPath

    c = poly.centroid
    m = folium.Map(location=[c.y, c.x], zoom_start=15, tiles=None)
    esri = "https://server.arcgisonline.com/ArcGIS/rest/services/{}/MapServer/tile/{{z}}/{{y}}/{{x}}"
    folium.TileLayer(esri.format("World_Street_Map"), name="Harita",
                     attr="Tiles &copy; Esri | Yol verisi &copy; OpenStreetMap katkıcıları").add_to(m)
    folium.TileLayer(esri.format("World_Imagery"), name="Uydu",
                     attr="Tiles &copy; Esri").add_to(m)
    for ring in poly_latlon(poly):
        folium.PolyLine(ring, color="#d00", weight=3, dash_array="8,6",
                        tooltip="Mahalle sınırı").add_to(m)

    fg_s = folium.FeatureGroup(name="Zorunlu sokaklar (mavi, kesikli = sınır yolu)")
    for s in sokaklar:
        folium.PolyLine(latlon(s["cizgi"].coords), color="#1565c0", weight=6,
                        opacity=0.7, dash_array="10,6" if s["sinir"] else None,
                        tooltip=f"{s['ad'] or '(isimsiz)'} - {s['uzunluk']:.0f} m"
                                f"{' - TEK YÖN' if s['tek_yon'] else ''}"
                                f"{' - SINIR YOLU' if s['sinir'] else ''}").add_to(fg_s)
    fg_s.add_to(m)

    fg_b = folium.FeatureGroup(name="Boş geçişler (turuncu)")
    for p in parcalar:
        if p["s"] == -1:
            folium.PolyLine(latlon(p["c"]), color="#ff8f00", weight=4,
                            opacity=0.9).add_to(fg_b)
    fg_b.add_to(m)

    tum = []
    for p in parcalar:
        pts = latlon(p["c"])
        tum.extend(pts if not tum else pts[1:])
    fg_r = folium.FeatureGroup(name="Rota yönü (animasyon)")
    AntPath(tum, color="#000", weight=2, opacity=0.6, delay=1500).add_to(fg_r)
    fg_r.add_to(m)

    folium.Marker(tum[0], tooltip="Başlangıç / Bitiş",
                  icon=folium.Icon(color="green", icon="play")).add_to(m)
    folium.LayerControl(collapsed=False).add_to(m)

    baslik = (f"<div style='position:fixed;top:10px;left:50px;z-index:9999;"
              f"background:white;padding:8px 12px;border-radius:6px;"
              f"box-shadow:0 1px 4px #0005;font:14px sans-serif'>"
              f"<b>{mahalle} ({ilce})</b><br>"
              f"Sokak: {ozet['sokak_sayisi']} adet, {ozet['sokak_km']} km<br>"
              f"(sınır yolu: {ozet['sinir_sokak_sayisi']} adet, {ozet['sinir_sokak_km']} km)<br>"
              f"Rota: {ozet['rota_km']} km (tekrar oranı {ozet['tekrar_orani']})</div>")
    m.get_root().html.add_child(folium.Element(baslik))
    m.save(str(yol))


# ----------------------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser(description="Mahalle aydınlatma denetim rotası")
    ap.add_argument("--mahalle", required=True)
    ap.add_argument("--ilce", required=True)
    ap.add_argument("--sinir", help="Elle çizilmiş sınır (GeoJSON)")
    ap.add_argument("--tampon", type=int, default=500,
                    help="Bağlantı için sınır dışına taşma payı (metre)")
    a = ap.parse_args()

    ox.settings.log_console = False
    ad = f"{slug(a.ilce)}_{slug(a.mahalle)}"
    sinir_dosyasi = a.sinir
    elle = SINIRLAR / f"{ad}.geojson"
    if not sinir_dosyasi and elle.exists():
        sinir_dosyasi = elle
    poly = sinir_bul(a.mahalle, a.ilce, sinir_dosyasi)
    print(f"[yol] araç yolları indiriliyor (tampon {a.tampon} m)...")
    G = ox.graph_from_polygon(tampon(poly, a.tampon), network_type="drive",
                              truncate_by_edge=True)
    scc = max(nx.strongly_connected_components(G), key=len)
    atilan = G.number_of_nodes() - len(scc)
    G = G.subgraph(scc).copy()
    print(f"[yol] {G.number_of_nodes()} düğüm, {G.number_of_edges()} yay "
          f"(ulaşılamayan {atilan} düğüm atıldı)")

    print("[rota] hesaplanıyor...")
    sokaklar, parcalar, ozet = rota_coz(G, poly)
    print(f"[sınır yolu] {ozet['sinir_sokak_sayisi']} adet, {ozet['sinir_sokak_km']} km eklendi: "
          + ", ".join(sorted({s['ad'] for s in sokaklar if s['sinir'] and s['ad']}))[:300])
    print(f"[rota] {ozet['sokak_sayisi']} sokak, {ozet['sokak_km']} km  ->  "
          f"rota {ozet['rota_km']} km (tekrar oranı {ozet['tekrar_orani']})")

    CIKTI.mkdir(exist_ok=True)
    WEB_VERI.mkdir(parents=True, exist_ok=True)
    json_yaz(WEB_VERI / f"{ad}.json", a.mahalle, a.ilce, poly, sokaklar, parcalar, ozet)
    html_yaz(CIKTI / f"{ad}.html", a.mahalle, a.ilce, poly, sokaklar, parcalar, ozet)
    n = indeks_guncelle()
    print(f"[tamam] docs\\veri\\{ad}.json ve cikti\\{ad}.html yazıldı "
          f"(web'de toplam {n} mahalle)")


if __name__ == "__main__":
    main()
