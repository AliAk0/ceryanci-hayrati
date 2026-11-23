// Ceryancı Hayratı · Aydınlatma Rota
// Adım 3: canlı konum, sokak boyama, ilerleme kaydı, sıradaki kısım
"use strict";

// ================================================================ ayarlar
const VERI = "veri/";
const OK_ARALIK_M = 120;        // yön okları arası mesafe
const OK_MIN_ZOOM = 16;         // oklar bu zoom ve üstünde görünür
const PARCA_M = 10;             // sokaklar bu boyda parçacıklara bölünür
const YAKALAMA_M = 20;          // konuma bu kadar yakın parçacık boyanır
const MAX_HASSASIYET_M = 30;    // daha kötü GPS ölçümü yok sayılır
const TAMAM_ORANI = 0.8;        // sokağın bu kadarı boyanınca "tamam"
const YON_TOLERANS = 60;        // tek yön sokakta gidiş yönü farkı (derece)
const YON_MIN_M = 8;            // yön hesabı için en az hareket
const ARA_ORNEK_M = 5;          // iki ölçüm arası bu aralıkla doldurulur
const ARA_MAX_M = 80;           // daha büyük sıçramalar doldurulmaz
const ROTA_YAKIN_M = 40;        // rotada "buradayım" sayılma mesafesi
const SIRADAKI_YOL_MAX_M = 2000;// sıradakine giden yol bundan uzunsa çizilmez
const SIRADAKI_UZATMA_M = 300;  // sıradaki kısım ileriye bu kadar uzatılır
const GRID_M = 25;

// URL ?sim=40  -> rota üzerinde 40 km/sa sahte sürüş (PC'de test için)
const SIM_KMSA = Number(new URLSearchParams(location.search).get("sim")) || 0;

// ================================================================ harita
const harita = L.map("harita", { zoomControl: true }).setView([37.0, 35.32], 12);
for (const [ad, z] of [["rotaPane", 410], ["boyaPane", 420], ["siradakiPane", 430], ["konumPane", 640]]) {
  harita.createPane(ad).style.zIndex = z;
}
const cizici = {
  sokak: L.canvas({ padding: 0.3 }),
  rota: L.canvas({ pane: "rotaPane", padding: 0.3 }),
  boya: L.canvas({ pane: "boyaPane", padding: 0.3 }),
  siradaki: L.canvas({ pane: "siradakiPane", padding: 0.3 }),
};

const esri = (s) => `https://server.arcgisonline.com/ArcGIS/rest/services/${s}/MapServer/tile/{z}/{y}/{x}`;
const ATTR = "Tiles &copy; Esri | Yol verisi &copy; OpenStreetMap katkıcıları";
const altliklar = {
  "Harita": L.tileLayer(esri("World_Street_Map"), { maxZoom: 19, attribution: ATTR }),
  "Uydu": L.tileLayer(esri("World_Imagery"), { maxZoom: 19, attribution: ATTR }),
};
altliklar["Harita"].addTo(harita);

const katman = {
  sinir: L.layerGroup().addTo(harita),
  sokak: L.layerGroup().addTo(harita),
  rota: L.layerGroup().addTo(harita),
  boya: L.layerGroup().addTo(harita),
  siradaki: L.layerGroup().addTo(harita),
  ok: L.layerGroup(),
  konum: L.layerGroup().addTo(harita),
};
L.control.layers(altliklar, {
  "Sokaklar": katman.sokak, "Rota": katman.rota, "Boyanan": katman.boya,
}, { position: "topright", collapsed: true }).addTo(harita);

// ================================================================ yardımcılar
const $ = (id) => document.getElementById(id);
const fmt = (x, d = 1) => Number(x).toLocaleString("tr-TR", { minimumFractionDigits: d, maximumFractionDigits: d });

function mesaj(metin) {
  const m = $("mesaj");
  if (!metin) { m.classList.add("gizli"); return; }
  m.textContent = metin;
  m.classList.remove("gizli");
  clearTimeout(mesaj._t);
  mesaj._t = setTimeout(() => m.classList.add("gizli"), 8000);
}
function durum(metin, uyari = false) {
  $("durum").textContent = metin || "";
  $("durum").classList.toggle("uyari", uyari);
}
function hafizaOku(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
function hafizaYaz(k, v) { try { localStorage.setItem(k, v); return true; } catch (e) { return false; } }
function hafizaSil(k) { try { localStorage.removeItem(k); } catch (e) { /* yok say */ } }

const rad = (d) => d * Math.PI / 180;
function mesafe(a, b) {
  const dLat = rad(b[0] - a[0]), dLon = rad(b[1] - a[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(h));
}
function yon(a, b) {
  const y = Math.sin(rad(b[1] - a[1])) * Math.cos(rad(b[0]));
  const x = Math.cos(rad(a[0])) * Math.sin(rad(b[0])) - Math.sin(rad(a[0])) * Math.cos(rad(b[0])) * Math.cos(rad(b[1] - a[1]));
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}
const aciFark = (a, b) => Math.abs(((a - b + 540) % 360) - 180);
const ara = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];

// Mahalleye göre yerel düzlem (metre)
let P = null;
const xy = (ll) => [(ll[1] - P.lon0) * P.kx, (ll[0] - P.lat0) * P.ky];
function noktaDogruMesafe(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const L2 = dx * dx + dy * dy;
  let t = L2 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

async function jsonAl(yol) {
  const r = await fetch(yol, { cache: "no-cache" });
  if (!r.ok) throw new Error(`${yol}: ${r.status}`);
  return r.json();
}

// ================================================================ durum
let D = null;               // mahalle verisi
let aktifDosya = null;
let imza = "";
let parcacik = [];          // {sid, a, b, A, B, m, h}
let sokakParcacik = [];     // sid -> [parçacık indeksleri]
let sokakToplam = [];       // sid -> metre
let sokakGezilen = [];      // sid -> metre
let tamam = [];             // sid -> bool
let grid = new Map();
let gezilen = new Set();    // parçacık indeksleri
let toplamM = 0, gezilenM = 0;
let rotaXY = [];            // rota parçaları xy
let rotaM = [];             // rota parçası uzunlukları
let imlec = 0;              // rotada nerede olduğumuz
let boyaCizgi = [];         // sid -> L.polyline

let takipte = false, watchId = null, simZaman = null, wakeLock = null;
let sonXY = null, yonRef = null, sonYon = null, sonLL = null;
let takipEt = true;
let ilkKonum = false;
let kayitBekliyor = null;

// ================================================================ mahalle listesi
async function listeYukle() {
  let liste;
  try {
    liste = await jsonAl(VERI + "mahalleler.json");
  } catch (e) {
    mesaj(location.protocol === "file:"
      ? "Sayfa dosyadan açılmış. docs klasöründe 'python -m http.server 8000' çalıştırıp http://localhost:8000 adresini açın."
      : "Mahalle listesi yüklenemedi: " + e.message);
    return;
  }
  const sec = $("mahalleSec");
  const gruplar = {};
  for (const m of liste) {
    if (!gruplar[m.ilce]) {
      gruplar[m.ilce] = document.createElement("optgroup");
      gruplar[m.ilce].label = m.ilce;
      sec.appendChild(gruplar[m.ilce]);
    }
    const o = document.createElement("option");
    o.value = m.dosya;
    o.textContent = `${m.mahalle}  (${fmt(m.rota_km)} km)`;
    gruplar[m.ilce].appendChild(o);
  }
  sec.addEventListener("change", () => {
    if (sec.value) { hafizaYaz("sonMahalle", sec.value); mahalleYukle(sec.value); }
  });
  const son = hafizaOku("sonMahalle");
  if (son && liste.some((m) => m.dosya === son)) {
    sec.value = son;
    await mahalleYukle(son);
  }
}

// ================================================================ mahalle yükleme
async function mahalleYukle(dosya) {
  let d;
  try {
    d = await jsonAl(VERI + dosya);
  } catch (e) {
    mesaj("Mahalle verisi yüklenemedi: " + e.message);
    return;
  }
  kaydetHemen();
  D = d;
  aktifDosya = dosya;
  imza = `${d.sokaklar.length}|${d.ozet.sokak_km}|${d.ozet.rota_km}`;
  for (const k of ["sinir", "sokak", "rota", "boya", "siradaki", "ok"]) katman[k].clearLayers();

  const c = L.polygon(d.sinir.map((r) => [r])).getBounds().getCenter();
  P = { lat0: c.lat, lon0: c.lng, kx: 111320 * Math.cos(rad(c.lat)), ky: 110540 };

  parcacikYap(d);
  rotaHazirla(d);
  cizSabit(d);
  ilerlemeYukle();
  for (let sid = 0; sid < d.sokaklar.length; sid++) sokakBoya(sid);
  ilerlemeGoster();
  siradakiGuncelle();
  sonXY = yonRef = sonYon = sonLL = null;
}

function parcacikYap(d) {
  parcacik = []; sokakParcacik = []; sokakToplam = []; grid = new Map(); toplamM = 0;
  for (const s of d.sokaklar) {
    const liste = [];
    let top = 0;
    for (let i = 0; i < s.c.length - 1; i++) {
      const a = s.c[i], b = s.c[i + 1];
      const A = xy(a), B = xy(b);
      const L_ = Math.hypot(B[0] - A[0], B[1] - A[1]);
      if (L_ === 0) continue;
      const n = Math.max(1, Math.ceil(L_ / PARCA_M));
      const h = yon(a, b);
      for (let k = 0; k < n; k++) {
        const pa = ara(a, b, k / n), pb = ara(a, b, (k + 1) / n);
        const PA = ara(A, B, k / n), PB = ara(A, B, (k + 1) / n);
        const idx = parcacik.length;
        parcacik.push({ sid: s.id, a: pa, b: pb, A: PA, B: PB, m: L_ / n, h });
        liste.push(idx);
        const gx = Math.floor((PA[0] + PB[0]) / 2 / GRID_M), gy = Math.floor((PA[1] + PB[1]) / 2 / GRID_M);
        const key = gx + "," + gy;
        if (!grid.has(key)) grid.set(key, []);
        grid.get(key).push(idx);
      }
      top += L_;
    }
    sokakParcacik[s.id] = liste;
    sokakToplam[s.id] = top;
    toplamM += top;
  }
}

function yakinParcaciklar(p, r) {
  const gx = Math.floor(p[0] / GRID_M), gy = Math.floor(p[1] / GRID_M);
  const n = Math.ceil((r + PARCA_M) / GRID_M);
  const sonuc = [];
  for (let i = -n; i <= n; i++) for (let j = -n; j <= n; j++) {
    const l = grid.get((gx + i) + "," + (gy + j));
    if (!l) continue;
    for (const idx of l) {
      const q = parcacik[idx];
      if (noktaDogruMesafe(p, q.A, q.B) <= r) sonuc.push(idx);
    }
  }
  return sonuc;
}

function rotaHazirla(d) {
  rotaXY = d.rota.map((p) => p.c.map(xy));
  rotaM = rotaXY.map((c) => {
    let t = 0;
    for (let i = 0; i < c.length - 1; i++) t += Math.hypot(c[i + 1][0] - c[i][0], c[i + 1][1] - c[i][1]);
    return t;
  });
  imlec = 0;
}

function rotaParcaMesafe(i, p) {
  const c = rotaXY[i];
  let m = Infinity;
  for (let k = 0; k < c.length - 1; k++) m = Math.min(m, noktaDogruMesafe(p, c[k], c[k + 1]));
  return m;
}

function cizSabit(d) {
  const sinir = L.polygon(d.sinir.map((r) => [r]), {
    color: "#d32f2f", weight: 3, dashArray: "8 6", fillColor: "#d32f2f", fillOpacity: 0.04, interactive: false,
  }).addTo(katman.sinir);

  for (const s of d.sokaklar) {
    L.polyline(s.c, { renderer: cizici.sokak, color: "#546e7a", weight: 8, opacity: 0.3 })
      .bindTooltip(`${s.ad || "(isimsiz)"} · ${fmt(s.m, 0)} m${s.tek_yon ? " · tek yön" : ""}${s.sinir ? " · sınır yolu" : ""}`, { sticky: true })
      .addTo(katman.sokak);
  }
  for (const p of d.rota) if (p.s >= 0)
    L.polyline(p.c, { renderer: cizici.rota, color: "#1565c0", weight: 4, opacity: 0.9, interactive: false }).addTo(katman.rota);
  for (const p of d.rota) if (p.s < 0)
    L.polyline(p.c, { renderer: cizici.rota, color: "#ef6c00", weight: 3, opacity: 0.95, dashArray: "6 7", interactive: false }).addTo(katman.rota);

  oklariCiz(d.rota);
  okGorunurluk();

  L.circleMarker(d.rota[0].c[0], { renderer: cizici.siradaki, radius: 8, color: "#fff", weight: 3, fillColor: "#2e7d32", fillOpacity: 1 })
    .bindTooltip("Başlangıç / Bitiş").addTo(katman.rota);

  const o = d.ozet;
  $("bilgiBaslik").textContent = `${d.mahalle} (${d.ilce})`;
  $("bilgiSatir").textContent = `Rota ${fmt(o.rota_km)} km · tekrar ×${fmt(o.tekrar_orani, 2)}`;
  $("panel").classList.remove("gizli");

  if (!takipte) harita.fitBounds(sinir.getBounds(), { padding: [20, 20] });
}

function oklariCiz(rota) {
  let birikim = OK_ARALIK_M / 2;
  for (const p of rota) {
    const bos = p.s < 0;
    for (let i = 0; i < p.c.length - 1; i++) {
      const a = p.c[i], b = p.c[i + 1];
      const L_ = mesafe(a, b);
      if (L_ === 0) continue;
      let t = OK_ARALIK_M - birikim;
      while (t <= L_) {
        L.marker(ara(a, b, t / L_), {
          interactive: false, keyboard: false,
          icon: L.divIcon({
            className: "ok-ikon" + (bos ? " bos" : ""), iconSize: [14, 14],
            html: `<div style="transform:rotate(${yon(a, b).toFixed(0)}deg)">▲</div>`,
          }),
        }).addTo(katman.ok);
        t += OK_ARALIK_M;
      }
      birikim = (birikim + L_) % OK_ARALIK_M;
    }
  }
}
function okGorunurluk() {
  const goster = harita.getZoom() >= OK_MIN_ZOOM && harita.hasLayer(katman.rota);
  if (goster && !harita.hasLayer(katman.ok)) katman.ok.addTo(harita);
  if (!goster && harita.hasLayer(katman.ok)) harita.removeLayer(katman.ok);
}
harita.on("zoomend overlayadd overlayremove", okGorunurluk);

// ================================================================ boyama
function sokakDurumHesapla(sid) {
  let g = 0;
  for (const idx of sokakParcacik[sid]) if (gezilen.has(idx)) g += parcacik[idx].m;
  sokakGezilen[sid] = g;
  tamam[sid] = sokakToplam[sid] > 0 && g / sokakToplam[sid] >= TAMAM_ORANI;
}

function sokakBoya(sid) {
  sokakDurumHesapla(sid);
  if (boyaCizgi[sid]) { katman.boya.removeLayer(boyaCizgi[sid]); boyaCizgi[sid] = null; }
  let cizgiler;
  if (tamam[sid]) {
    cizgiler = [D.sokaklar[sid].c];
  } else {
    cizgiler = [];
    let akan = null;
    for (const idx of sokakParcacik[sid]) {
      const q = parcacik[idx];
      if (gezilen.has(idx)) {
        if (!akan) { akan = [q.a]; cizgiler.push(akan); }
        akan.push(q.b);
      } else {
        akan = null;
      }
    }
  }
  if (!cizgiler.length) return;
  boyaCizgi[sid] = L.polyline(cizgiler, {
    renderer: cizici.boya, color: tamam[sid] ? "#2e7d32" : "#43a047", weight: 7, opacity: 0.9, interactive: false,
  }).addTo(katman.boya);
}

function ilerlemeGoster() {
  gezilenM = 0;
  let nTamam = 0;
  for (let sid = 0; sid < sokakToplam.length; sid++) {
    gezilenM += sokakGezilen[sid] || 0;
    if (tamam[sid]) nTamam++;
  }
  const yuzde = toplamM ? (100 * gezilenM / toplamM) : 0;
  $("cubukDolu").style.width = yuzde.toFixed(1) + "%";
  $("ilerlemeMetin").textContent =
    `%${fmt(yuzde, 0)} · ${fmt(gezilenM / 1000)} / ${fmt(toplamM / 1000)} km · ${nTamam}/${sokakToplam.length} sokak`;
}

// ================================================================ konum işleme
function konumIsle(lat, lon, hassasiyet) {
  if (!D) return;
  const ll = [lat, lon];
  konumCiz(ll, hassasiyet);
  if (hassasiyet > MAX_HASSASIYET_M) {
    durum(`GPS zayıf (±${Math.round(hassasiyet)} m), boyama bekliyor…`, true);
    return;
  }
  const X = xy(ll);

  // Gidiş yönü (kendi hesabımız: son 8 m+ hareketten)
  if (!yonRef) yonRef = { X, ll };
  else if (Math.hypot(X[0] - yonRef.X[0], X[1] - yonRef.X[1]) >= YON_MIN_M) {
    sonYon = yon(yonRef.ll, ll);
    yonRef = { X, ll };
  }

  // İki ölçüm arasını doldur
  const ornek = [];
  const d = sonXY ? Math.hypot(X[0] - sonXY[0], X[1] - sonXY[1]) : 0;
  if (sonXY && d > ARA_ORNEK_M && d <= ARA_MAX_M) {
    const n = Math.ceil(d / ARA_ORNEK_M);
    for (let k = 1; k <= n; k++) ornek.push(ara(sonXY, X, k / n));
  } else {
    ornek.push(X);
  }
  sonXY = X;
  sonLL = ll;

  const degisen = new Set();
  for (const p of ornek) {
    for (const idx of yakinParcaciklar(p, YAKALAMA_M)) {
      if (gezilen.has(idx)) continue;
      const q = parcacik[idx];
      if (sonYon === null) continue;   // yön belli olana kadar (ilk 8 m) boyama yok
      if (D.sokaklar[q.sid].tek_yon) {
        if (aciFark(sonYon, q.h) > YON_TOLERANS) continue;            // tek yön: sadece doğru yönde
      } else if (Math.min(aciFark(sonYon, q.h), aciFark(sonYon, q.h + 180)) > YON_TOLERANS) {
        continue;                                                     // kavşakta dik sokak boyanmaz
      }
      gezilen.add(idx);
      degisen.add(q.sid);
    }
  }
  for (const sid of degisen) sokakBoya(sid);
  if (degisen.size) { ilerlemeGoster(); kaydetZamanla(); }

  imlecGuncelle(X);
  siradakiGuncelle();
  durum(`GPS ±${Math.round(hassasiyet)} m${sonYon !== null ? "" : " · yön bekleniyor"}`);
}

let konumIsaret = null, konumDaire = null;
function konumCiz(ll, hassasiyet) {
  const aci = sonYon ?? 0;
  const ikon = L.divIcon({
    className: "konum-ikon", iconSize: [28, 28],
    html: `<div style="transform:rotate(${aci.toFixed(0)}deg)"><svg width="26" height="26" viewBox="0 0 26 26">
      <circle cx="13" cy="13" r="9" fill="#1e88e5" stroke="#fff" stroke-width="3"/>
      ${sonYon !== null ? '<path d="M13 1 L18 9 L8 9 Z" fill="#0d47a1" stroke="#fff" stroke-width="1"/>' : ""}</svg></div>`,
  });
  if (!konumIsaret) {
    konumDaire = L.circle(ll, { radius: hassasiyet, color: "#1e88e5", weight: 1, fillOpacity: 0.08, interactive: false, pane: "konumPane" }).addTo(katman.konum);
    konumIsaret = L.marker(ll, { icon: ikon, interactive: false, pane: "konumPane" }).addTo(katman.konum);
  } else {
    konumDaire.setLatLng(ll).setRadius(hassasiyet);
    konumIsaret.setLatLng(ll).setIcon(ikon);
  }
  if (ilkKonum) { harita.setView(ll, Math.max(harita.getZoom(), 17)); ilkKonum = false; }
  else if (takipEt) harita.panTo(ll, { animate: true, duration: 0.5 });
}

// ================================================================ sıradaki kısım
function imlecGuncelle(X) {
  const n = rotaXY.length;
  let aday = -1;
  // önce imleçten ileriye doğru (rota aynı sokaktan birden fazla geçebilir)
  for (let k = 0; k < n; k++) {
    const i = (imlec + k) % n;
    if (rotaParcaMesafe(i, X) <= ROTA_YAKIN_M) { aday = i; break; }
  }
  if (aday >= 0) imlec = aday;
}

function bittiMi(i) {
  const s = D.rota[i].s;
  return s < 0 || tamam[s];
}

function siradakiGuncelle() {
  katman.siradaki.clearLayers();
  if (!D) return;
  const n = D.rota.length;
  let j = -1;
  for (let k = 0; k < n; k++) {
    const i = (imlec + k) % n;
    if (!bittiMi(i)) { j = i; break; }
  }
  if (j < 0) {
    $("siradaki").innerHTML = "✅ Tüm sokaklar tamamlandı";
    return;
  }

  // imleçten j'ye giden yol (çok uzun değilse)
  const parcalar = [];
  let yolM = 0;
  if (j >= imlec) {
    for (let i = imlec; i < j; i++) yolM += rotaM[i];
    if (yolM <= SIRADAKI_YOL_MAX_M) for (let i = imlec; i < j; i++) parcalar.push(i);
  }
  // j ve devamındaki bitmemiş kısımlar
  let ek = 0;
  for (let i = j; i < n && ek < SIRADAKI_UZATMA_M; i++) {
    if (i > j && bittiMi(i) && D.rota[i].s >= 0) break;
    parcalar.push(i);
    ek += rotaM[i];
  }

  for (const i of parcalar) {
    L.polyline(D.rota[i].c, { renderer: cizici.siradaki, color: "#000", weight: 13, opacity: 0.25, interactive: false }).addTo(katman.siradaki);
  }
  for (const i of parcalar) {
    L.polyline(D.rota[i].c, { renderer: cizici.siradaki, color: "#ffd600", weight: 9, opacity: 0.9, interactive: false }).addTo(katman.siradaki);
  }

  const s = D.sokaklar[D.rota[j].s];
  const uzak = (j >= imlec && yolM > 0) ? ` · ${yolM < 1000 ? fmt(yolM, 0) + " m" : fmt(yolM / 1000) + " km"} ileride` : "";
  $("siradaki").innerHTML = `Sıradaki: <b>${s.ad || "isimsiz sokak"}</b>${uzak}`;
}

// ================================================================ takip başlat/durdur
async function ekranAcikTut() {
  try {
    if ("wakeLock" in navigator) {
      wakeLock = await navigator.wakeLock.request("screen");
    } else {
      mesaj("Bu tarayıcı ekranı açık tutamıyor. Telefon ayarlarından ekran zaman aşımını uzatın.");
    }
  } catch (e) { /* izin verilmezse sessiz geç */ }
}

function takipBaslat() {
  if (!D) { mesaj("Önce mahalle seçin."); return; }
  takipte = true;
  takipEt = true;
  ilkKonum = true;
  $("baslaBtn").textContent = "■ Durdur";
  $("baslaBtn").classList.add("dur");
  ekranAcikTut();
  sonXY = yonRef = null; sonYon = null;

  if (SIM_KMSA) { simBaslat(); return; }
  if (!("geolocation" in navigator)) { mesaj("Bu tarayıcıda konum desteği yok."); takipDurdur(); return; }
  durum("Konum bekleniyor…");
  watchId = navigator.geolocation.watchPosition(
    (p) => konumIsle(p.coords.latitude, p.coords.longitude, p.coords.accuracy),
    (e) => {
      if (e.code === 1) {
        mesaj("Konum izni verilmedi. Tarayıcı ayarlarından bu siteye konum izni verin.");
        takipDurdur();
      } else {
        durum("Konum alınamıyor, bekleniyor…", true);
      }
    },
    { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 },
  );
}

function takipDurdur() {
  takipte = false;
  if (watchId !== null) { navigator.geolocation.clearWatch(watchId); watchId = null; }
  if (simZaman) { clearInterval(simZaman); simZaman = null; }
  if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
  $("baslaBtn").textContent = "▶ Başla";
  $("baslaBtn").classList.remove("dur");
  durum("Durduruldu");
  kaydetHemen();
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    if (takipte) ekranAcikTut();
  } else {
    kaydetHemen();
  }
});
window.addEventListener("pagehide", kaydetHemen);

// ================================================================ simülasyon (?sim=40)
function simBaslat() {
  const noktalar = [];
  for (const p of D.rota) for (const c of p.c) {
    if (!noktalar.length || mesafe(noktalar[noktalar.length - 1], c) > 0) noktalar.push(c);
  }
  const adimM = SIM_KMSA / 3.6;     // saniyede metre
  let i = 0, kalan = 0, konum = noktalar[0];
  durum(`Simülasyon: ${SIM_KMSA} km/sa`);
  simZaman = setInterval(() => {
    let git = adimM;
    while (git > 0 && i < noktalar.length - 1) {
      const seg = mesafe(konum, noktalar[i + 1]);
      if (seg <= git) { git -= seg; konum = noktalar[++i]; }
      else { konum = ara(konum, noktalar[i + 1], git / seg); git = 0; }
    }
    const gurultu = () => (Math.random() - 0.5) * 2 * 4 / 111000;   // ±4 m
    konumIsle(konum[0] + gurultu(), konum[1] + gurultu(), 8);
    if (i >= noktalar.length - 1) { takipDurdur(); durum("Simülasyon bitti"); }
  }, 1000);
}

// ================================================================ kayıt / yükleme
function anahtar() { return "ilerleme:" + aktifDosya; }

function ilerlemeYukle() {
  gezilen = new Set();
  tamam = []; sokakGezilen = []; boyaCizgi = [];
  const ham = hafizaOku(anahtar());
  if (!ham) return;
  try {
    const o = JSON.parse(ham);
    if (o.imza === imza && o.n === parcacik.length) {
      gezilen = new Set(o.v);
      imlec = Math.min(o.imlec || 0, rotaXY.length - 1);
    } else {
      mesaj("Bu mahallenin verisi güncellenmiş; eski ilerleme kullanılamadı.");
    }
  } catch (e) { /* bozuk kayıt */ }
}

function kayitNesnesi() {
  return { dosya: aktifDosya, imza, n: parcacik.length, imlec, v: [...gezilen], tarih: new Date().toISOString() };
}

function kaydetHemen() {
  if (!aktifDosya) return;
  clearTimeout(kayitBekliyor); kayitBekliyor = null;
  if (!hafizaYaz(anahtar(), JSON.stringify(kayitNesnesi()))) durum("İlerleme kaydedilemedi (tarayıcı hafızası kapalı)", true);
}
function kaydetZamanla() {
  if (kayitBekliyor) return;
  kayitBekliyor = setTimeout(kaydetHemen, 3000);
}

function disaAktar() {
  if (!aktifDosya) return;
  const blob = new Blob([JSON.stringify(kayitNesnesi())], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `ilerleme_${aktifDosya.replace(".json", "")}_${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

function iceAktar(dosya) {
  const r = new FileReader();
  r.onload = () => {
    let o;
    try { o = JSON.parse(r.result); } catch (e) { mesaj("Dosya okunamadı."); return; }
    if (o.dosya !== aktifDosya) { mesaj(`Bu dosya başka mahalleye ait (${o.dosya}). Önce o mahalleyi seçin.`); return; }
    if (o.imza !== imza || o.n !== parcacik.length) { mesaj("Dosya, mahalle verisinin farklı bir sürümüne ait."); return; }
    const once = gezilen.size;
    for (const idx of o.v) gezilen.add(idx);
    for (let sid = 0; sid < D.sokaklar.length; sid++) sokakBoya(sid);
    ilerlemeGoster(); siradakiGuncelle(); kaydetHemen();
    mesaj(`Birleştirildi: ${gezilen.size - once} yeni parça eklendi.`);
  };
  r.readAsText(dosya);
}

function sifirla() {
  if (!aktifDosya) return;
  if (!confirm(`${D.mahalle} için tüm ilerleme silinsin mi?`)) return;
  gezilen = new Set(); imlec = 0;
  hafizaSil(anahtar());
  for (let sid = 0; sid < D.sokaklar.length; sid++) sokakBoya(sid);
  ilerlemeGoster(); siradakiGuncelle();
}

// ================================================================ butonlar
$("baslaBtn").addEventListener("click", () => (takipte ? takipDurdur() : takipBaslat()));
$("ortalaBtn").addEventListener("click", () => {
  takipEt = true;
  if (sonLL) harita.setView(sonLL, Math.max(harita.getZoom(), 17));
  else if (!takipte) mesaj("Konum için önce Başla'ya basın.");
});
$("menuBtn").addEventListener("click", () => $("menu").classList.toggle("gizli"));
$("disaBtn").addEventListener("click", disaAktar);
$("iceBtn").addEventListener("click", () => $("iceDosya").click());
$("iceDosya").addEventListener("change", (e) => { if (e.target.files[0]) iceAktar(e.target.files[0]); e.target.value = ""; });
$("sifirlaBtn").addEventListener("click", sifirla);
harita.on("dragstart", () => { takipEt = false; });

listeYukle();
