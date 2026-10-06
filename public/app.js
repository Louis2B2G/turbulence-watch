// Turbulence Watch (client). Everything specific to a flight runs here, in the browser: route, position, projected path,
// the forecast along it, the g-force simulation and your bump reports (kept on this device only).
// The server publishes global forecast fields (GitHub Action -> data branch) and proxies live feeds under /api.

const $ = (id) => document.getElementById(id);
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const MIN = 60e3, HOUR = 3600e3, DEG = Math.PI / 180;
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/* ------------------------------------------------------------------ storage (best effort) */
const store = {
  get(k, d = null) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) {
    try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch {
      try { // out of space: drop other flights' saved forecasts and retry
        for (let i = localStorage.length - 1; i >= 0; i--) { const kk = localStorage.key(i); if (kk && kk.startsWith("tw:f:") && kk !== k) localStorage.removeItem(kk); }
        localStorage.setItem(k, JSON.stringify(v)); return true;
      } catch { return false; }
    }
  },
};

/* ------------------------------------------------------------------ appearance */
function applyTheme(t) { const r = document.documentElement; if (t) r.dataset.theme = t; else delete r.dataset.theme; }
applyTheme(store.get("tw:theme", ""));

/* ------------------------------------------------------------------ turbulence levels (peak jolt, extra g) */
const LEVELS = [
  { max: 0.2, key: "smooth", name: "Smooth", c: "--green", hex: "#34c759" },
  { max: 0.5, key: "light", name: "Light", c: "--yellow", hex: "#ffd60a" },
  { max: 1.0, key: "moderate", name: "Moderate", c: "--orange", hex: "#ff9500" },
  { max: 2.0, key: "severe", name: "Severe", c: "--red", hex: "#ff3b30" },
  { max: Infinity, key: "extreme", name: "Extreme", c: "--purple", hex: "#bf5af2" },
];
const level = (g) => LEVELS.find((l) => g < l.max);
const col = (g) => `var(${level(g).c})`;

/* ------------------------------------------------------------------ aircraft */
// k = peak extra g per unit EDR at mid-flight weight. Wide-body reference: A350 at 250 t ~ 1.5 (gust-load formula).
// Smaller aircraft have lower wing loading and respond more; the factors are deliberately modest.
const CLS = {
  heavy: { name: "Wide-body", k: 1.5, v: 880, fl: 370 },
  narrow: { name: "Narrow-body", k: 1.72, v: 830, fl: 360 },
  regional: { name: "Regional jet", k: 1.95, v: 780, fl: 340 },
  turboprop: { name: "Turboprop", k: 2.25, v: 500, fl: 240 },
  bizjet: { name: "Business jet", k: 2.1, v: 800, fl: 410 },
};
const TYPES = {};
const addTypes = (cls, s) => s.split(",").forEach((x) => { const [code, name] = x.split(":"); TYPES[code] = [name || code, cls]; });
addTypes("heavy", "A359:A350-900,A35K:A350-1000,A388:A380,A332:A330-200,A333:A330-300,A338:A330-800neo,A339:A330-900neo,A342:A340-200,A343:A340-300,A345:A340-500,A346:A340-600,A306:A300,A310:A310,B788:787-8,B789:787-9,B78X:787-10,B772:777-200,B77L:777-200LR,B773:777-300,B77W:777-300ER,B778:777-8,B779:777-9,B744:747-400,B748:747-8,B762:767-200,B763:767-300,B764:767-400,MD11:MD-11,IL96:Il-96");
addTypes("narrow", "A318,A319,A320,A321,A19N:A319neo,A20N:A320neo,A21N:A321neo,B733:737-300,B734:737-400,B735:737-500,B736:737-600,B737:737-700,B738:737-800,B739:737-900,B37M:737 MAX 7,B38M:737 MAX 8,B39M:737 MAX 9,B3XM:737 MAX 10,B752:757-200,B753:757-300,BCS1:A220-100,BCS3:A220-300,C919,B712:717,MD82:MD-82,MD83:MD-83,MD88:MD-88,MD90:MD-90,T204:Tu-204");
addTypes("regional", "E170,E75L:E175,E75S:E175,E190,E195,E290:E190-E2,E295:E195-E2,E135:ERJ-135,E145:ERJ-145,CRJ2:CRJ-200,CRJ7:CRJ-700,CRJ9:CRJ-900,CRJX:CRJ-1000,SU95:Superjet 100,AR85:ARJ21,F100:Fokker 100,F70:Fokker 70,RJ85:Avro RJ85,RJ1H:Avro RJ100,B461:BAe 146");
addTypes("turboprop", "AT43:ATR 42,AT45:ATR 42,AT46:ATR 42,AT72:ATR 72,AT75:ATR 72,AT76:ATR 72,DH8A:Dash 8-100,DH8B:Dash 8-200,DH8C:Dash 8-300,DH8D:Dash 8-400,SF34:Saab 340,SB20:Saab 2000,JS41:Jetstream 41,D328:Do 328,B190:Beech 1900,DHC6:Twin Otter,AN24:An-24,MA60,L410:L-410");
addTypes("bizjet", "GLF4,GLF5,GLF6,GL5T,GL7T,GLEX,CL30,CL35,CL60,C25A,C25B,C25C,C510,C525,C550,C560,C56X,C680,C68A,C700,C750,E50P,E55P,E545,E550,F2TH,F900,FA7X,FA8X,LJ35,LJ45,LJ60,LJ75,H25B,PC24,HDJT,G280");

/* ------------------------------------------------------------------ geometry */
const R_E = 6371;
function hav(a, b, c, d) { const x = Math.sin(((c - a) * DEG) / 2), y = Math.sin(((d - b) * DEG) / 2); return 2 * R_E * Math.asin(Math.min(1, Math.sqrt(x * x + Math.cos(a * DEG) * Math.cos(c * DEG) * y * y))); }
function brg(a, b, c, d) { const p1 = a * DEG, p2 = c * DEG, dl = (d - b) * DEG; return ((Math.atan2(Math.sin(dl) * Math.cos(p2), Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl)) / DEG) + 360) % 360; }
const wrap = (x) => ((((x + 180) % 360) + 360) % 360) - 180;
function move(a, b, h, km) {
  const d = km / R_E, p1 = a * DEG, l1 = b * DEG, t = h * DEG;
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(t));
  const l2 = l1 + Math.atan2(Math.sin(t) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
  return [p2 / DEG, wrap(l2 / DEG)];
}
function xtrack(lat, lon, A, B) { // signed cross-track and along-track distance (km) from great circle A->B
  const d13 = hav(A.lat, A.lon, lat, lon) / R_E, t13 = brg(A.lat, A.lon, lat, lon) * DEG, t12 = brg(A.lat, A.lon, B.lat, B.lon) * DEG;
  const xt = Math.asin(clamp(Math.sin(d13) * Math.sin(t13 - t12), -1, 1));
  const at = Math.acos(clamp(Math.cos(d13) / Math.cos(xt), -1, 1)) * Math.sign(Math.cos(t13 - t12) || 1);
  return { xt: xt * R_E, at: at * R_E };
}
const unwrapTo = (lon, ref) => ref + wrap(lon - ref);

/* ------------------------------------------------------------------ time formatting */
let TZ = store.get("tw:tz", "phone");
const tzOf = () => (TZ === "utc" ? "UTC" : TZ === "origin" ? F?.origin?.tz : TZ === "dest" ? F?.dest?.tz : undefined) || undefined;
function fmtT(t, tz = tzOf()) {
  try { return new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", timeZone: tz }); }
  catch { return new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }); }
}
function fmtR(a, b, tz = tzOf()) { // "2:37 – 2:57 PM" / "14:37–14:57"
  try {
    const day = (x) => new Date(x).toLocaleDateString("en-CA", { timeZone: tz });
    const f = new Intl.DateTimeFormat([], { hour: "numeric", minute: "2-digit", timeZone: tz });
    if (f.formatRange && day(a) === day(b)) return f.formatRange(new Date(a), new Date(Math.max(a, b)));
  } catch { /* old browser */ }
  return fmtT(a, tz) + " – " + fmtT(b, tz);
}
function dayTag(t, tz = tzOf()) {
  try {
    const f = (x) => new Date(x).toLocaleDateString("en-CA", { timeZone: tz });
    if (f(t) === f(Date.now())) return "";
    return " " + new Date(t).toLocaleDateString([], { weekday: "short", timeZone: tz });
  } catch { return ""; }
}
const tzLabel = () => (TZ === "utc" ? "UTC" : TZ === "origin" && F?.origin ? (F.origin.city || F.origin.iata) + " time" : TZ === "dest" && F?.dest ? (F.dest.city || F.dest.iata) + " time" : "your phone's time");
const ago = (t) => { const m = Math.round((Date.now() - t) / MIN); return m < 1 ? "just now" : m < 60 ? `${m} min ago` : `${Math.floor(m / 60)} h ${m % 60} min ago`; };
const dur = (min) => (min < 60 ? `${Math.max(0, Math.round(min))} min` : `${Math.floor(min / 60)} h ${String(Math.round(min % 60)).padStart(2, "0")}`);
const isoMin = (t) => new Date(t).toISOString().slice(0, 16);
function localInput(t) { const d = new Date(t), p = (n) => String(n).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; }

/* ------------------------------------------------------------------ network */
async function api(path, opts = {}, timeoutMs = 25000) {
  const ctl = new AbortController(), to = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(path, { method: opts.body ? "POST" : "GET", signal: ctl.signal, headers: opts.body ? { "Content-Type": "application/json" } : undefined, body: opts.body ? JSON.stringify(opts.body) : undefined });
    const js = await r.json().catch(() => null);
    if (!r.ok) { const e = new Error(js?.error || `HTTP ${r.status}`); e.status = r.status; throw e; }
    return js;
  } finally { clearTimeout(to); }
}
function loadImg(url) {
  return new Promise((res, rej) => { const im = new Image(); im.crossOrigin = "anonymous"; im.onload = () => res(im); im.onerror = () => rej(new Error("image")); im.src = url; });
}
function pixels(im) {
  const c = document.createElement("canvas"); c.width = im.naturalWidth; c.height = im.naturalHeight;
  const x = c.getContext("2d", { willReadFrequently: true }); x.drawImage(im, 0, 0);
  return { w: c.width, h: c.height, d: x.getImageData(0, 0, c.width, c.height).data };
}

/* ------------------------------------------------------------------ airports */
let AP = null;
async function loadAirports() {
  if (AP) return AP;
  try {
    const rows = await (await fetch("/airports.json")).json();
    const by = new Map(), list = rows.map((r) => ({ iata: r[0], icao: r[1], name: r[2], city: r[3], cc: r[4], lat: r[5], lon: r[6], tz: r[7], big: r[8] }));
    for (const a of list) { if (a.iata) by.set(a.iata, a); if (a.icao && !by.has(a.icao)) by.set(a.icao, a); }
    AP = { list, by };
  } catch { AP = { list: [], by: new Map() }; }
  return AP;
}
const apFind = (code) => (code && AP ? AP.by.get(String(code).toUpperCase()) || null : null);
function apNorm(a) {
  if (!a || a.lat == null) return null;
  const m = apFind(a.icao) || apFind(a.iata);
  return { iata: a.iata || m?.iata || null, icao: a.icao || m?.icao || null, name: m?.name || a.name || "", city: m?.city || a.city || a.name || "", lat: +a.lat, lon: +a.lon, tz: m?.tz || null };
}
const apCode = (a) => (a ? a.iata || a.icao || "?" : "?");
const apCity = (a) => (a ? a.city || a.name || apCode(a) : "");

/* ------------------------------------------------------------------ state */
let F = null;          // the open flight: {q, key, st (saved), info, origin, dest, routeSrc, routeWarn, fix, D}
let N = clamp(store.get("tw:N", 30), 5, 180);
let tab = store.get("tw:tab", "now");
let busy = false, lastTry = 0, errMsg = "";
const saveF = () => F && store.set(F.key, F.st);
const normQ = (q) => String(q || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 10);

function classFor() {
  const forced = F.st.cls;
  if (forced && CLS[forced]) return { key: forced, ...CLS[forced], auto: false };
  const ty = F.info?.aircraft?.type, t = ty && TYPES[ty];
  if (t) return { key: t[1], ...CLS[t[1]], auto: true, type: ty, typeName: t[0] };
  const L = F.origin && F.dest ? hav(F.origin.lat, F.origin.lon, F.dest.lat, F.dest.lon) : 3000;
  const key = L > 5500 ? "heavy" : "narrow";
  return { key, ...CLS[key], auto: true, guessed: true };
}

/* ------------------------------------------------------------------ route */
function resolveRoute() {
  const st = F.st, info = F.info || {}, p = info.position;
  const cands = [];
  for (const r of info.routes || []) {
    const o = apNorm(r.origin), d = apNorm(r.destination);
    if (o && d) { cands.push({ o, d, src: r.src }); cands.push({ o: d, d: o, src: r.src + " (reversed)" }); }
  }
  F.routeWarn = null;
  if (st.route && (st.route.from || st.route.to)) {
    const db = cands[0];
    F.origin = apFind(st.route.from) || db?.o || null;
    F.dest = apFind(st.route.to) || db?.d || null;
    F.routeSrc = "you";
    return;
  }
  if (!cands.length) { F.origin = F.dest = null; F.routeSrc = null; F.routeWarn = "unknown"; return; }
  const fresh = p && Date.now() - Date.parse(p.t) < 30 * MIN && (p.alt_ft ?? 0) > 3000;
  if (!fresh) { // can't check against the plane: trust the flight-number database as listed
    const c = cands[0]; F.origin = c.o; F.dest = c.d; F.routeSrc = c.src; return;
  }
  const score = (c) => {
    const L = hav(c.o.lat, c.o.lon, c.d.lat, c.d.lon), { xt, at } = xtrack(p.lat, p.lon, c.o, c.d);
    const dd = hav(p.lat, p.lon, c.d.lat, c.d.lon);
    const hd = p.track != null && dd > 300 ? Math.abs(wrap(p.track - brg(p.lat, p.lon, c.d.lat, c.d.lon))) : 0;
    const bad = Math.abs(xt) > Math.max(350, 0.15 * L) || at < -300 || at > L + 300 || hd > 100;
    return { s: Math.abs(xt) + Math.max(0, -at) + Math.max(0, at - L) + hd * 8, bad };
  };
  let best = null;
  for (const c of cands) { const s = score(c); if (!best || s.s < best.s.s) best = { c, s }; }
  F.origin = best.c.o; F.dest = best.c.d; F.routeSrc = best.c.src;
  if (best.s.bad) F.routeWarn = "mismatch";
}

/* ------------------------------------------------------------------ position */
function recordFix(p) {
  if (!p || p.lat == null) return;
  const t = Date.parse(p.t), tr = F.st.track;
  if (tr.length && Math.abs(tr[tr.length - 1][2] - t) < 15e3) return;
  if (tr.length && t < tr[tr.length - 1][2]) return;
  tr.push([+p.lat.toFixed(4), +p.lon.toFixed(4), t, p.alt_ft ?? null, p.gs_kmh ?? null, p.track ?? null]);
  if (tr.length > 800) F.st.track = tr.filter((_, i) => i % 2 === 0 || i > tr.length - 200);
}
function positionNow() {
  const st = F.st, now = Date.now(), c = [];
  const p = F.info?.position;
  if (p && now - Date.parse(p.t) < 14 * HOUR) c.push({ lat: p.lat, lon: p.lon, t: Date.parse(p.t), alt: p.alt_ft, gs: p.gs_kmh, trk: p.track, src: p.src, kind: "fix" });
  const tr = st.track[st.track.length - 1];
  if (tr && now - tr[2] < 14 * HOUR) c.push({ lat: tr[0], lon: tr[1], t: tr[2], alt: tr[3], gs: tr[4], trk: tr[5], src: "earlier fix", kind: "fix" });
  if (st.manual && now - st.manual.t < 14 * HOUR) c.push({ ...st.manual, src: "you", kind: "manual" });
  c.sort((a, b) => b.t - a.t);
  const f = c[0];
  if (f) {
    const ground = f.kind !== "manual" && f.alt != null && f.alt < 400 && (f.gs == null || f.gs < 150);
    if (ground) {
      if (F.dest && hav(f.lat, f.lon, F.dest.lat, F.dest.lon) < 40) return { ...f, kind: "landed" };
      const o = F.origin || f;
      return { lat: o.lat, lon: o.lon, t: Math.max(now, st.dep || now), alt: 0, gs: 0, trk: null, kind: "ground", src: f.src };
    }
    if (f.kind !== "manual") f.kind = now - f.t < 5 * MIN ? "live" : "dr";
    return f;
  }
  if (!F.origin) return null;
  if (st.dep && st.dep <= now) return { lat: F.origin.lat, lon: F.origin.lon, t: st.dep, alt: 0, gs: 0, trk: null, kind: "takeoff", src: "your takeoff time" };
  return { lat: F.origin.lat, lon: F.origin.lon, t: Math.max(now, st.dep || 0), alt: 0, gs: 0, trk: null, kind: st.dep ? "planned" : "unknown", src: "" };
}
const airborneKind = (k) => k === "live" || k === "dr" || k === "manual" || k === "takeoff";

/* ------------------------------------------------------------------ projected path */
// Minute-by-minute: from the current fix, turning from the present heading onto the great circle to the destination,
// cruise speed relaxing from the measured ground speed to typical, climb and descent profiles at the ends.
function buildPath(fx, dest, cls) {
  const lat = [], lon = [], fl = [], ph = [], dist = [];
  const flying = fx.kind === "live" || fx.kind === "dr" || fx.kind === "manual";
  const flCr = flying && fx.alt > 24000 ? Math.round(fx.alt / 1000) * 10 : cls.fl;
  let a = fx.lat, b = fx.lon;
  if (!dest) {
    const h = fx.trk ?? 0, v = flying && fx.gs > 250 ? fx.gs : cls.v;
    for (let m = 0; m <= 180; m++) { lat.push(a); lon.push(b); fl.push(flCr); ph.push(0); dist.push(null); [a, b] = move(a, b, h, v / 60); }
    return { lat, lon, fl, ph, dist, M: lat.length, straight: true, D0: null, flCr };
  }
  const D0 = hav(a, b, dest.lat, dest.lon);
  const climbFrom = flying ? (fx.alt ?? flCr * 100) / 100 : 0;
  const climbMin = flying ? (D0 > 400 && climbFrom < flCr - 15 ? (flCr - climbFrom) / 20 : 0) : 22;
  const v0 = flying && fx.gs > 250 ? fx.gs : null;
  const b0 = brg(a, b, dest.lat, dest.lon), dth = flying && fx.trk != null ? wrap(fx.trk - b0) : 0;
  const desc = Math.min(230, D0);
  for (let m = 0; m < 30 * 60; m++) {
    const d = hav(a, b, dest.lat, dest.lon);
    let v, f, p = 0;
    const vc = cls.v + ((v0 ?? cls.v) - cls.v) * Math.exp(-m / 120);
    if (m < climbMin) { const x = (m + 0.5) / climbMin; v = (v0 ?? 380) + (vc - (v0 ?? 380)) * x; f = climbFrom + (flCr - climbFrom) * x; p = 1; }
    else { v = vc; f = flCr; }
    if (d < desc) { const x = d / desc; v = 420 + (v - 420) * x; f = Math.min(f, flCr * x); p = 2; }
    lat.push(a); lon.push(b); fl.push(Math.round(f)); ph.push(p); dist.push(d);
    if (d < 2) break;
    const h = brg(a, b, dest.lat, dest.lon) + dth * Math.exp(-m / 8);
    [a, b] = move(a, b, h, Math.min(v / 60, d));
  }
  return { lat, lon, fl, ph, dist, M: lat.length, straight: false, D0, flCr };
}
// Cross-track spread (km, 1 sigma): grows from the plane, peaks mid-way, pinches to zero at the destination
// (a Brownian-bridge-like corridor). Real routes stray ~3% of the distance from the great circle.
function corridor(path, fx) {
  const M = path.M, age = Math.max(0, (Date.now() - fx.t) / MIN);
  const s0 = fx.kind === "dr" ? clamp(2 + 0.3 * age, 2, 60) : fx.kind === "manual" ? 25 : 2;
  if (path.straight) return path.lat.map((_, m) => s0 + (m * (CLS.heavy.v / 60)) * Math.tan(6 * DEG));
  const mid = clamp(0.03 * path.D0, 8, 150);
  return path.lat.map((_, m) => { const s = m / Math.max(1, M - 1); return s0 * (1 - s) + mid * 4 * s * (1 - s); });
}
const headingAt = (path, m) => {
  const i = clamp(m, 0, path.M - 2);
  return path.M > 1 ? brg(path.lat[i], path.lon[i], path.lat[i + 1], path.lon[i + 1]) : 0;
};

/* ------------------------------------------------------------------ live satellite storms along the next 3 hours */
// Meteosat (Europe, Africa, Atlantic): EUMETSAT storm objects (RDT) and lightning (MTG LI).
// GOES-East/West and Himawari: cloud tops colder than -58 C on the enhanced infrared from NASA GIBS.
const SATS = [{ id: "msg", lon: 0 }, { id: "GOES-East", lon: -75.2 }, { id: "GOES-West", lon: -137.2 }, { id: "Himawari", lon: 140.7 }];
const satFor = (lat, lon) => SATS.find((s) => hav(0, s.lon, lat, lon) < 7000) || null;
const radiusKm = (leadH) => 45 + 35 * clamp(leadH, 0, 3);
// Brightness temperature from NASA GIBS "Clean Infrared" tiles (enhanced colour scale: colours below -19 C, greys above;
// a grey ring at -70..-79 C inside storm cores is told apart from warm greys by its cold neighbours).
const IR_HEX = "ffffff7f007f8c0d8799198ea52696b2339dbf40a5cc4cadd959b4e566bcf272c3ff7fcbe6e6e6ccccccb1b1b19b9b9b8181816666664c4c4c3636361b1b1b0505051a00003300004d0000660000800000990000b30000cc0000e60000ff0000ff1a00ff3300ff4d00ff6600ff8000ff9900ffb300ffcc00ffe600ffff00e6ff00ccff00b3ff0099ff0080ff0066ff004dff0033ff001aff0000ff0000ea0a00d41300bf1d00aa2600953000803a006a4300554d004056002a6000156900007300007d000d7a001a8100268800338f004096004c9d0059a40066ab0073b20080b9008cc00099c700a6ce00b2d500bfdc00cce300d9ea00e6f100f2f800ffff";
const IR_T = [-91.6, -90.6, -89.6, -88.6, -87.6, -86.6, -85.6, -84.6, -83.6, -82.6, -81.6, -80.6, -79.6, -78.6, -77.6, -76.6, -75.6, -74.6, -73.6, -72.6, -71.6, -70.6, -69.6, -68.6, -67.6, -66.6, -65.6, -64.6, -63.6, -62.6, -61.6, -60.6, -59.6, -58.6, -57.6, -56.6, -55.6, -54.6, -53.6, -52.6, -51.6, -50.6, -49.6, -48.6, -47.6, -46.6, -45.6, -44.6, -43.6, -42.6, -41.6, -40.6, -39.6, -38.6, -37.6, -36.6, -35.6, -34.6, -33.6, -32.6, -31.6, -30.9, -30.4, -29.9, -29.4, -28.9, -28.4, -27.9, -27.4, -26.9, -26.4, -25.9, -25.4, -24.9, -24.4, -23.9, -23.4, -22.9, -22.4, -21.9, -21.4, -20.9, -20.4, -19.9, -19.4];
const IR_PATH = IR_T.map((t, i) => [parseInt(IR_HEX.substr(i * 6, 2), 16), parseInt(IR_HEX.substr(i * 6 + 2, 2), 16), parseInt(IR_HEX.substr(i * 6 + 4, 2), 16), t]);
const irCache = new Map();
// Project a colour onto the colour scale (a path through RGB space, coldest first); tiles are resampled, so most
// pixels are blends of neighbouring scale colours. Colours far from the scale are blends at cloud edges: call them mid-level cloud.
function irColorT(r, g, b) {
  const k = (r << 16) | (g << 8) | b;
  let T = irCache.get(k);
  if (T !== undefined) return T;
  let best = 1e9, bt = 0;
  for (let i = 0; i < IR_PATH.length - 1; i++) {
    const A = IR_PATH[i], B = IR_PATH[i + 1], ax = B[0] - A[0], ay = B[1] - A[1], az = B[2] - A[2], L2 = ax * ax + ay * ay + az * az || 1;
    let t = ((r - A[0]) * ax + (g - A[1]) * ay + (b - A[2]) * az) / L2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const dx = r - A[0] - t * ax, dy = g - A[1] - t * ay, dz = b - A[2] - t * az, d = dx * dx + dy * dy + dz * dz;
    if (d < best) { best = d; bt = A[3] + (B[3] - A[3]) * t; }
  }
  T = best > 900 ? -18 : bt;
  if (irCache.size > 60000) irCache.clear();
  irCache.set(k, T);
  return T;
}
// Temperatures (C) for a w*h RGBA tile; 999 = no data. Meteosat (EUMETView) tiles are plain grey, calibrated against GOES.
function tileTemps(d, w, h, meteosat) {
  const n = w * h, T = new Float32Array(n);
  for (let p = 0, i = 0; p < n; p++, i += 4) {
    if (d[i + 3] < 128) { T[p] = 999; continue; }
    if (meteosat) { T[p] = 25 - 0.39 * d[i]; continue; }
    const r = d[i], g = d[i + 1], b = d[i + 2];
    if (Math.max(r, g, b) - Math.min(r, g, b) < 10) T[p] = r > 245 ? -91 : r > 200 ? -79 : 1000 + r;
    else T[p] = irColorT(r, g, b);
  }
  if (!meteosat) {
    const seed = new Uint8Array(n);
    for (let p = 0; p < n; p++) seed[p] = T[p] < -60 ? 1 : 0;
    for (let p = 0; p < n; p++) {
      if (T[p] < 1000) continue;
      const x = p % w, y = (p / w) | 0;
      let cold = false;
      for (let dy = -3; dy <= 3 && !cold; dy++) for (let dx = -3; dx <= 3; dx++) {
        const yy = y + dy, xx = x + dx;
        if (yy >= 0 && yy < h && xx >= 0 && xx < w && seed[yy * w + xx]) { cold = true; break; }
      }
      T[p] = cold ? -75 : 57.31 - 0.3866 * (T[p] - 1000);
    }
  }
  return T;
}

async function nowcast(pts) {
  const out = pts.map(() => ({ sat: null }));
  const groups = {};
  pts.forEach((p, i) => { const s = satFor(p.lat, p.lon); if (s) (groups[s.id] ||= []).push(i); });
  const jobs = [];
  if (groups.msg) jobs.push(meteosat(pts, groups.msg, out).catch(() => {}));
  for (const id of ["GOES-East", "GOES-West", "Himawari"]) if (groups[id]) jobs.push(gibsCold(pts, groups[id], id, out).catch(() => {}));
  await Promise.all(jobs);
  return out;
}
async function meteosat(pts, idx, out) {
  let la0 = 90, la1 = -90, lo0 = 180, lo1 = -180;
  for (const i of idx) { const p = pts[i], r = radiusKm(p.lead) / 111 + 0.3; la0 = Math.min(la0, p.lat - r); la1 = Math.max(la1, p.lat + r); lo0 = Math.min(lo0, p.lon - r * 1.6); lo1 = Math.max(lo1, p.lon + r * 1.6); }
  la0 = Math.max(-80, la0); la1 = Math.min(80, la1); lo0 = Math.max(-80, lo0); lo1 = Math.min(80, lo1);
  if (lo1 <= lo0 || la1 <= la0) return;
  const res = 0.05, w = clamp(Math.round((lo1 - lo0) / res), 16, 1000), h = clamp(Math.round((la1 - la0) / res), 16, 1000);
  const url = (layer) => `https://view.eumetsat.int/geoserver/wms?service=WMS&version=1.1.1&request=GetMap&layers=${layer}&styles=&srs=EPSG:4326&bbox=${lo0.toFixed(2)},${la0.toFixed(2)},${lo1.toFixed(2)},${la1.toFixed(2)}&width=${w}&height=${h}&format=image/png&transparent=true`;
  const [rdt, li] = await Promise.all(["msg_fes:rdt", "mtg_fd:li_afa"].map((l) => loadImg(url(l)).then(pixels).catch(() => null)));
  const frac = (img, p) => {
    if (!img) return null;
    const r = radiusKm(p.lead), ci = ((la1 - p.lat) / (la1 - la0)) * img.h, cj = ((p.lon - lo0) / (lo1 - lo0)) * img.w;
    const di = (r / 111 / (la1 - la0)) * img.h, dj = (r / (111 * Math.max(0.25, Math.cos(p.lat * DEG))) / (lo1 - lo0)) * img.w;
    let n = 0, k = 0;
    for (let i = Math.max(0, Math.floor(ci - di)); i <= Math.min(img.h - 1, Math.ceil(ci + di)); i++)
      for (let j = Math.max(0, Math.floor(cj - dj)); j <= Math.min(img.w - 1, Math.ceil(cj + dj)); j++) {
        const y = (i - ci) / di, x = (j - cj) / dj; if (x * x + y * y > 1) continue;
        n++; if (img.d[(i * img.w + j) * 4 + 3] > 40) k++;
      }
    return n ? k / n : null;
  };
  for (const i of idx) out[i] = { sat: "Meteosat", rdt: frac(rdt, pts[i]), li: frac(li, pts[i]) };
}
async function gibsCold(pts, idx, id, out) {
  const z = 4, n = 1 << z, S = 256 * n;
  const X = (lon) => ((lon + 180) / 360) * S, Y = (lat) => ((1 - Math.log(Math.tan(Math.PI / 4 + (clamp(lat, -85, 85) * DEG) / 2)) / Math.PI) / 2) * S;
  const need = new Map();
  for (const i of idx) {
    const p = pts[i], r = radiusKm(p.lead), x = X(p.lon), y = Y(p.lat), pxPerKm = S / (2 * Math.PI * R_E * Math.cos(p.lat * DEG));
    const rp = r * pxPerKm;
    for (let tx = Math.floor((x - rp) / 256); tx <= Math.floor((x + rp) / 256); tx++)
      for (let ty = Math.floor((y - rp) / 256); ty <= Math.floor((y + rp) / 256); ty++)
        if (ty >= 0 && ty < n) need.set(`${(tx + n) % n},${ty}`, null);
  }
  if (need.size > 12) return;
  const layer = `${id}_${id === "Himawari" ? "AHI" : "ABI"}_Band13_Clean_Infrared`;
  await Promise.all([...need.keys()].map(async (k) => {
    const [tx, ty] = k.split(",");
    try { const px = pixels(await loadImg(`https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/${layer}/default/default/GoogleMapsCompatible_Level6/${z}/${ty}/${tx}.png`)); need.set(k, tileTemps(px.d, px.w, px.h, false)); } catch { /* tile missing */ }
  }));
  for (const i of idx) {
    const p = pts[i], r = radiusKm(p.lead), x0 = X(p.lon), y0 = Y(p.lat), rp = r * (S / (2 * Math.PI * R_E * Math.cos(p.lat * DEG)));
    let cnt = 0, cold = 0, seen = 0;
    for (let y = Math.floor(y0 - rp); y <= Math.ceil(y0 + rp); y += 1)
      for (let x = Math.floor(x0 - rp); x <= Math.ceil(x0 + rp); x += 1) {
        if ((x - x0) ** 2 + (y - y0) ** 2 > rp * rp) continue;
        const tx = (((Math.floor(x / 256)) % n) + n) % n, ty = Math.floor(y / 256), t = need.get(`${tx},${ty}`);
        cnt++; if (!t) continue;
        const px = ((((x % 256) + 256) % 256) | 0), py = (((y % 256) + 256) % 256) | 0, tt = t[py * 256 + px];
        if (tt > 500) continue;
        seen++; if (tt <= -58) cold++;
      }
    out[i] = { sat: id, cold: seen > cnt * 0.5 ? cold / seen : null };
  }
}

/* ------------------------------------------------------------------ combining the forecasts */
const SIG_FLOOR = (s) => s.hazard === "TURB" ? (/SEV/.test(s.qualifier) ? 0.35 : 0.24) : s.hazard === "MTW" ? (/SEV/.test(s.qualifier) ? 0.3 : 0.2) : ["TS", "CB", "TC"].includes(s.hazard) ? 0.22 : 0;
const CB_FLOOR = (cb) => (cb != null && cb >= 34 ? Math.min(0.26, 0.16 + 0.006 * (cb - 34)) : 0);
const PIREP_EDR = [0.03, 0.12, 0.18, 0.25, 0.32, 0.4, 0.55];
const TB_NAME = ["smooth", "light", "light to moderate", "moderate", "moderate to severe", "severe", "extreme"];
const HAZ_NAME = { TURB: "turbulence", TS: "thunderstorms", CB: "storm clouds", MTW: "mountain waves", TC: "tropical cyclone", VA: "volcanic ash" };
const GH = [2 / 3, 1 / 6, 1 / 6]; // Gauss-Hermite weights for the path and +-sqrt(3) sigma either side
const MEMBERS = ["wafs", "ifs", "gfs", "aifs"];

function combine(path, plan, smp, nc, fx) {
  const W = smp.weights || { wafs: 0.4, ifs: 0.25, gfs: 0.2, aifs: 0.15 };
  const sig = new Map((smp.sigmets || []).map((s) => [s.id, s]));
  const now = Date.now();
  const steps = plan.map((st, k) => {
    const nodes = [0, 1, 2].map((j) => smp.points[3 * k + j] || {});
    const lead = (st.t - now) / HOUR, flags = [];
    let obs = 0.03;
    // pilot reports within 80 km, at a similar level, recent (decays with age + lead time)
    for (const r of smp.pireps || []) {
      if (r.lvl < 1) continue;
      if (Math.abs(r.lat - st.lat) > 1 || hav(st.lat, st.lon, r.lat, r.lon) > 80) continue;
      if (r.fl != null && Math.abs(r.fl - st.fl) > 40) continue;
      const age = Math.max(0, (now - r.t) / HOUR), w = 0.7 * Math.exp(-(age + Math.max(0, lead)) / 1.5);
      const e = 0.03 + (PIREP_EDR[r.lvl] - 0.03) * w;
      if (e > obs) obs = e;
      if (w > 0.2) flags.push(`Pilot report: ${TB_NAME[r.lvl]} turbulence ${Math.round(age * 60)} min ago${r.fl ? " at FL" + r.fl : ""}${r.ac ? " (" + r.ac + ")" : ""}`);
    }
    // live satellite storms, moved nowhere but searched in a radius that grows with lead time; weight fades over ~2.5 h
    const s = st.nci != null ? nc?.[st.nci] : null;
    if (s && lead <= 3.2) {
      const w = Math.exp(-Math.max(0, lead) / 2.5);
      if (s.li != null && s.li > 0.01) { obs = Math.max(obs, 0.03 + 0.21 * w); flags.push(`Lightning near the path now (Meteosat)`); }
      if (s.rdt != null && s.rdt > 0.03) { obs = Math.max(obs, 0.03 + 0.17 * w * clamp(s.rdt / 0.15, 0.4, 1)); flags.push(`Storm cells on satellite now (Meteosat)`); }
      if (s.cold != null && s.cold > 0.03) { obs = Math.max(obs, 0.03 + 0.19 * w * clamp(s.cold / 0.15, 0.3, 1)); flags.push(`Storm tops colder than −58 °C on satellite now (${s.sat})`); }
    }
    const low = st.fl < 250;
    const ev = nodes.map((n) => {
      let ws = 0, s1 = 0;
      for (const m of MEMBERS) if (n[m] != null) { ws += W[m]; s1 += W[m] * n[m]; }
      let cat = ws ? s1 / ws : 0.05;
      if (low) cat = 0.5 * cat + 0.03;
      let storm = Math.max(n.conv || 0, CB_FLOOR(n.cb), obs);
      for (const id of n.w || []) { const x = sig.get(id); if (x) storm = Math.max(storm, SIG_FLOOR(x)); }
      if (n.sw && n.sw[0] === 2) storm = Math.max(storm, 0.22);
      if (n.cbx) storm = Math.max(storm, (n.cbx[0].includes("FREQ") ? 0.2 : n.cbx[0].includes("OCNL") ? 0.16 : 0.12) + (n.cbx[0].includes("EMBD") ? 0.02 : 0));
      return { cat, storm, e: Math.max(cat, storm) };
    });
    const c = nodes[0];
    const med = ev.reduce((a, x, j) => a + GH[j] * x.e, 0);
    const mem = {};
    for (const m of MEMBERS) if (c[m] != null) mem[m] = nodes.reduce((a, n, j) => a + GH[j] * (n[m] ?? c[m]), 0);
    mem.storm = ev.reduce((a, x, j) => a + GH[j] * x.storm, 0);
    const lv = MEMBERS.filter((m) => c[m] != null).map((m) => Math.log(Math.max(0.02, c[m])));
    const mean = lv.length ? lv.reduce((a, b) => a + b, 0) / lv.length : 0;
    const sd = lv.length > 1 ? Math.sqrt(lv.reduce((a, b) => a + (b - mean) ** 2, 0) / lv.length) : 0.4;
    const hi = Math.max(...ev.map((x) => x.e), ...MEMBERS.map((m) => c[m] ?? 0), med * Math.exp(1.28 * Math.max(0.35, sd + 0.3)));
    // descriptive flags
    const ids = new Set(nodes.flatMap((n) => n.w || []));
    for (const id of ids) { const x = sig.get(id); if (x) flags.push(`Official warning: ${x.qualifier ? x.qualifier.toLowerCase() + " " : ""}${HAZ_NAME[x.hazard] || x.hazard} (${x.fir.trim()})`); }
    const sw = nodes.find((n) => n.sw)?.sw;
    if (sw) flags.push(`Forecast chart: ${sw[0] === 2 ? "severe" : "moderate"} turbulence FL${sw[1]}–${sw[2]}`);
    const cbx = nodes.find((n) => n.cbx)?.cbx;
    if (cbx) flags.push(`Forecast chart: ${cbx[0].toLowerCase()} storm clouds, tops FL${cbx[1]}`);
    if (c.cb != null && c.cb >= 34) flags.push(`Forecast storm tops ${Math.round(c.cb)},000 ft`);
    const stormC = ev[0].storm;
    return { m: st.m, t: st.t, lat: st.lat, lon: st.lon, fl: st.fl, ph: st.ph, med, hi, mem, drv: ev[0].cat >= stormC ? "jet" : "storm", flags };
  });
  return steps;
}

/* ------------------------------------------------------------------ the whole forecast for this flight */
async function compute() {
  const fx = positionNow();
  F.fix = fx;
  if (!fx) { F.D = null; return; }
  if (fx.kind === "landed") { F.D = { landed: true, at: Date.now() }; return; }
  const cls = classFor();
  const path = buildPath(fx, F.dest, cls), sigma = corridor(path, fx);
  const t0 = fx.t, M = path.M, now = Date.now();
  // sampling plan: every 5 min for the next 4 h, then every 10 min; centre + both sides of the corridor
  const m0 = clamp(Math.floor((now - t0) / MIN) - 5, 0, M - 1), ms = [];
  for (let m = m0; m < M; m += m - m0 < 240 ? 5 : 10) ms.push(m);
  if (ms[ms.length - 1] !== M - 1) ms.push(M - 1);
  while (ms.length > 200) for (let i = ms.length - 2; i > 0; i -= 2) ms.splice(i, 1);
  const plan = ms.map((m) => ({ m, t: t0 + m * MIN, lat: path.lat[m], lon: path.lon[m], fl: Math.max(path.fl[m], 100), ph: path.ph[m] }));
  const points = [];
  for (const p of plan) {
    const h = headingAt(path, p.m), off = Math.sqrt(3) * sigma[p.m];
    const L = move(p.lat, p.lon, h - 90, off), R = move(p.lat, p.lon, h + 90, off);
    const fl = Math.max(250, p.fl);
    points.push([+p.lat.toFixed(3), +p.lon.toFixed(3), p.t, fl], [+L[0].toFixed(3), +L[1].toFixed(3), p.t, fl], [+R[0].toFixed(3), +R[1].toFixed(3), p.t, fl]);
  }
  const ncPts = [];
  plan.forEach((p) => { const lead = (p.t - now) / HOUR; if (lead > -0.2 && lead <= 3.2) { p.nci = ncPts.length; ncPts.push({ lat: p.lat, lon: p.lon, lead: Math.max(0, lead) }); } });
  const [smp, nc] = await Promise.all([api("/api/sample", { body: { points } }, 40000), nowcast(ncPts).catch(() => null)]);
  const steps = combine(path, plan, smp, nc, fx);
  // per-minute median and upper EDR
  const med = new Array(M).fill(0), hi = new Array(M).fill(0);
  let j = 0;
  for (let m = 0; m < M; m++) {
    while (j < steps.length - 2 && steps[j + 1].m <= m) j++;
    const a = steps[j], b = steps[Math.min(j + 1, steps.length - 1)];
    const w = b.m > a.m ? clamp((m - a.m) / (b.m - a.m), 0, 1) : 0;
    med[m] = +(a.med + (b.med - a.med) * w).toFixed(4); hi[m] = +(a.hi + (b.hi - a.hi) * w).toFixed(4);
  }
  const L = F.origin && F.dest ? hav(F.origin.lat, F.origin.lon, F.dest.lat, F.dest.lon) : null;
  F.D = {
    at: now, t0, M, arr: path.straight ? null : t0 + (M - 1) * MIN, straight: path.straight,
    lat: path.lat.map((x) => +x.toFixed(3)), lon: path.lon.map((x) => +x.toFixed(3)), fl: path.fl, ph: path.ph,
    dist: path.dist.map((x) => (x == null ? null : Math.round(x))), sig: sigma.map((x) => Math.round(x)), L,
    med, hi, steps, sigmets: smp.sigmets || [], pireps: smp.pireps || [], sources: smp.sources, updated: smp.updated, range: smp.range,
    nc: nc ? { n: ncPts.length, sats: [...new Set(nc.filter((x) => x.sat).map((x) => x.sat))] } : null,
    cls: cls.key, fixKind: fx.kind,
  };
  logForecast();
}

/* ------------------------------------------------------------------ g-force model */
// Peak extra g per unit EDR rises as fuel burns off (lighter plane, same wing): k(t) = k_mid * 0.94 / (1 - burn * progress).
function kAt(m) {
  const D = F.D, cls = CLS[D?.cls] || CLS.heavy;
  if (!D || D.straight || !D.L) return cls.k;
  const burn = clamp(0.035 * (D.L / 800 + 0.5), 0.05, 0.32);
  const d = D.dist[clamp(Math.round(m), 0, D.M - 1)];
  const prog = d == null ? 0.5 : clamp(1 - d / D.L, 0, 1);
  return (cls.k * 0.94) / (1 - burn * prog);
}
const nowMin = () => (F?.D?.t0 ? (Date.now() - F.D.t0) / MIN : 0);

// Gaussian-process correction from your bump reports (log-g residuals vs. forecast, time in minutes):
// constant term (this aircraft/day feels rougher or smoother) + Matern-3/2 local term with a 40 min length scale.
const GPL = { smooth: [Math.log(0.08), 0.6], light: [Math.log(0.32), 0.38], moderate: [Math.log(0.7), 0.3], severe: [Math.log(1.35), 0.3] };
const GSC = 0.35, GSL = 0.5, GELL = 40, GSUBJ = 0.15;
const kern = (a, b) => { const d = (Math.sqrt(3) * Math.abs(a - b)) / GELL; return GSC * GSC + GSL * GSL * (1 + d) * Math.exp(-d); };
let GP = null;
function fitGP() {
  GP = null;
  const D = F?.D;
  if (!D || D.landed || !D.med) return;
  const X = [], y = [], nv = [];
  for (const r of F.st.reports) {
    const f = F.st.flog[isoMin(r.t)];
    if (f == null || !GPL[r.level]) continue;
    const m = (r.t - D.t0) / MIN, g = 0.7 * kAt(Math.max(0, m)) * f;
    X.push(m); y.push(GPL[r.level][0] - Math.log(Math.max(g, 0.03))); nv.push(GPL[r.level][1] ** 2 + GSUBJ ** 2);
  }
  const prior = Math.sqrt(GSC ** 2 + GSL ** 2);
  if (!X.length) return;
  const n = X.length, K = X.map((a, i) => X.map((b, j) => kern(a, b) + (i === j ? nv[i] : 0)));
  const Lc = K.map(() => new Array(n).fill(0)); // Cholesky
  for (let i = 0; i < n; i++) for (let j = 0; j <= i; j++) {
    let s = K[i][j]; for (let k = 0; k < j; k++) s -= Lc[i][k] * Lc[j][k];
    Lc[i][j] = i === j ? Math.sqrt(Math.max(s, 1e-9)) : s / Lc[j][j];
  }
  const fwd = (b) => { const z = new Array(n); for (let i = 0; i < n; i++) { let s = b[i]; for (let k = 0; k < i; k++) s -= Lc[i][k] * z[k]; z[i] = s / Lc[i][i]; } return z; };
  const bwd = (z) => { const x = new Array(n); for (let i = n - 1; i >= 0; i--) { let s = z[i]; for (let k = i + 1; k < n; k++) s -= Lc[k][i] * x[k]; x[i] = s / Lc[i][i]; } return x; };
  const alpha = bwd(fwd(y));
  const mean = new Float32Array(D.M), sd = new Float32Array(D.M);
  for (let m = 0; m < D.M; m++) {
    const ks = X.map((x) => kern(m, x));
    mean[m] = clamp(ks.reduce((a, k, i) => a + k * alpha[i], 0), -0.9, 0.9);
    const v = fwd(ks);
    sd[m] = Math.sqrt(Math.max(prior * prior - v.reduce((a, x) => a + x * x, 0), 1e-4));
  }
  const glob = clamp(GSC * GSC * alpha.reduce((a, b) => a + b, 0), -0.9, 0.9);
  const mNow = clamp(Math.round(nowMin()), 0, D.M - 1);
  GP = { mean, sd, prior, factor: Math.exp(glob), now: Math.exp(mean[mNow]), n };
}
const gpFactor = () => (GP ? GP.factor : 1);

function randn() { let u = 0, v = 0; while (!u) u = Math.random(); while (!v) v = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
// Monte Carlo of the biggest jolt in the next n minutes: per-minute peak g = k * 0.55 * EDR * lognormal patchiness (AR(1),
// ~6 min memory) * forecast-error term; spread widens where the forecasts disagree.
function simulate(n) {
  const D = F.D, start = Math.max(0, nowMin()), S = 4000, rho = Math.exp(-1 / 6), sq = Math.sqrt(1 - rho * rho), R = 0.55, PF = 0.15;
  const Fm = [], SIG = [], K = [];
  for (let i = 0; i < n; i++) {
    const m = clamp(Math.round(start + i), 0, D.M - 1);
    let f = D.med[m], s = 0.45 + 0.25 * clamp(Math.log(Math.max(D.hi[m], f) / Math.max(f, 1e-3)), 0, 1);
    if (GP) { f *= Math.exp(GP.mean[m]); s *= Math.sqrt(0.5 + 0.5 * Math.min(1, (GP.sd[m] * GP.sd[m]) / (GP.prior * GP.prior))); }
    Fm.push(f); SIG.push(s); K.push(kAt(m));
  }
  const out = new Float64Array(S);
  for (let s = 0; s < S; s++) {
    let z = randn(), mx = 0;
    for (let i = 0; i < n; i++) { z = rho * z + sq * randn(); const g = K[i] * R * Fm[i] * Math.exp(SIG[i] * z + PF * randn()); if (g > mx) mx = g; }
    out[s] = mx;
  }
  out.sort();
  const q = (p) => out[Math.min(S - 1, Math.floor(p * S))];
  const frac = (t) => { let lo = 0, hi = S; while (lo < hi) { const md = (lo + hi) >> 1; if (out[md] < t) lo = md + 1; else hi = md; } return (S - lo) / S; };
  return { out, med: q(0.5), p90: q(0.9), p99: q(0.99), pMod: frac(0.5), pSev: frac(1) };
}
const pct = (p) => (p < 0.001 ? "<0.1%" : p < 0.01 ? (p * 100).toFixed(1) + "%" : Math.round(p * 100) + "%");
// Typical biggest jolt over a ~20 min stretch at minute m: the simulation's median in closed form
// (median of the 20-min max of the lognormal process = exp(1.232 SIG + 0.095)), so the timeline, the map and the
// "next 20 min" headline all speak the same language.
const STRETCH = (sig) => 0.55 * Math.exp(1.232 * sig + 0.095);
function gStretch(m) {
  const D = F.D;
  m = clamp(Math.round(m), 0, D.M - 1);
  const f = D.med[m] * (GP ? Math.exp(GP.mean[m]) : 1);
  const sig = 0.45 + 0.25 * clamp(Math.log(Math.max(D.hi[m], D.med[m]) / Math.max(D.med[m], 1e-3)), 0, 1);
  return kAt(m) * f * STRETCH(sig);
}
const gAtStep = (s) => gStretch(s.m);
const gPerEdr = (m) => gpFactor() * kAt(m) * STRETCH(0.6);   // for single EDR numbers (map layer, forecast bars)

/* ------------------------------------------------------------------ forecast log (to score your reports later) */
function logForecast() {
  const D = F.D, fl = F.st.flog, now = Date.now();
  for (let m = Math.floor(nowMin()) - 5; m <= nowMin() + 90; m++) {
    if (m < 0 || m >= D.M) continue;
    const t = D.t0 + m * MIN, key = isoMin(t);
    if (!(key in fl) || t - now < 5 * MIN) fl[key] = D.med[m];
  }
  for (const k of Object.keys(fl)) if (now - Date.parse(k + "Z") > 30 * HOUR) delete fl[k];
}

/* ------------------------------------------------------------------ rarity: how often a flight sees a jolt this big */
// Per-minute exceedance from a lognormal EDR climatology (cruise, NCAR in-situ EDR statistics), scaled by this aircraft's k.
const MU = -2.839, SG = 0.5696;
function erf(x) { const t = 1 / (1 + 0.3275911 * Math.abs(x)); const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x); return x >= 0 ? y : -y; }
const Phi = (z) => 0.5 * (1 + erf(z / Math.SQRT2));
const kRef = () => (F?.D && !F.D.landed ? gpFactor() * kAt(nowMin()) : CLS.heavy.k);
const exceedPerMinute = (g) => 1 - Phi((Math.log(g / kRef()) - MU) / SG);
function flightMinutes() { // whole flight, including the part already flown
  const D = F?.D;
  if (!D || !D.arr) return 720;
  const pre = ["planned", "unknown", "ground", "takeoff"].includes(D.fixKind);
  const flown = pre || !D.L || D.dist[0] == null ? 0 : Math.max(0, (D.L - D.dist[0]) / 14);
  return clamp((D.arr - D.t0) / MIN + flown, 40, 1200);
}
const perFlight = (g) => 1 - Math.pow(1 - exceedPerMinute(g), Math.max(1, (flightMinutes() - 30) / 5));
function niceN(n) { for (const x of [2, 3, 4, 5, 7, 10, 15, 20, 30, 50, 70, 100, 150, 200, 300, 500, 700, 1000, 1500, 2000, 3000, 5000, 7000, 10000, 20000, 50000, 100000]) if (n <= x * 1.2) return x; return null; }
function flightText(P) { if (P >= 0.97) return "Almost every flight"; if (P >= 0.55) return `About ${Math.round(P * 10)} in 10 flights`; const n = niceN(1 / P); return n ? `About 1 in ${n.toLocaleString("en-US")} flights` : "Fewer than 1 in 100,000 flights"; }
function timeText(g) { const p = exceedPerMinute(g), pc = 100 * (1 - p); if (p > 0.3) return "Typical of normal cruise"; if (p < 1e-5) return "Rougher than 99.999% of cruise time"; return `Rougher than ${pc < 99 ? Math.round(pc) : pc < 99.9 ? pc.toFixed(1) : pc < 99.99 ? pc.toFixed(2) : pc.toFixed(3)}% of cruise time`; }
const RUNGS = [[0.1, "Gentle ripples. Drinks barely move."], [0.2, "Light chop. Seatbelt sign may come on."], [0.3, "Noticeable jolts. Drinks slosh."], [0.5, "Strong jolts. Hard to walk. You feel the belt."], [1.0, "Loose objects fly. Unbelted people lifted."], [2.0, "Essentially never happens to airliners."]];
let nowMed = null;
function renderLadder() {
  const ref = Math.max(nowMed || 0.05, 0.05);
  const here = nowMed == null ? -1 : RUNGS.reduce((bi, [g], i) => (Math.abs(Math.log(g) - Math.log(ref)) < Math.abs(Math.log(RUNGS[bi][0]) - Math.log(ref)) ? i : bi), 0);
  $("ladder").innerHTML = RUNGS.map(([g, feel], i) => {
    const L = level(g + 1e-9), P = perFlight(g), w = Math.max(2, Math.min(100, ((Math.log10(Math.max(P, 1e-6)) + 6) / 6) * 100));
    return `<div class="rung${i === here ? " here" : ""}"><div><b class="g num">±${g.toFixed(1)} g</b><small class="num">${(1 - g).toFixed(1)} to ${(1 + g).toFixed(1)} g</small>${i === here ? `<div class="here-tag">Your next ${N} min</div>` : ""}</div><div><div class="lv"><i class="dot" style="background:var(${L.c})"></i>${L.name}</div><small>${feel}</small><div class="bar"><i style="width:${w}%;background:var(${L.c})"></i></div><div class="often">${flightText(P)}</div><small>${timeText(g)}</small></div></div>`;
  }).join("");
  const D = F?.D, cls = D && CLS[D.cls];
  $("ladderNote").textContent = `How often a ${dur(flightMinutes())} flight${cls ? ` on a ${cls.name.toLowerCase()}` : ""} gets at least one jolt this big. Bars are on a log scale; full means every flight.`;
}

/* ------------------------------------------------------------------ screens and tabs */
function showHome() {
  F = null; stopTimers();
  $("home").hidden = false; $("flight").hidden = true; $("tabbar").hidden = true;
  document.title = "Turbulence Watch";
  renderRecent();
}
function showTab(t) {
  tab = t; store.set("tw:tab", t);
  document.querySelectorAll("#flight [data-tab]").forEach((s) => (s.hidden = s.dataset.tab !== t));
  document.querySelectorAll(".tabbar button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.t === t)));
  if (t === "map") requestAnimationFrame(() => { initMap(); if (MAP) { MAP.map.invalidateSize(); drawMap(); } });
  window.scrollTo({ top: 0 });
}
function renderRecent() {
  const r = store.get("tw:recent", []);
  $("recentHdr").hidden = $("recent").hidden = !r.length;
  $("recent").innerHTML = r.map((x) => `<button class="row" type="button" data-q="${esc(x.q)}"><span class="k"><b>${esc(x.q)}</b>${x.route ? `<br><small>${esc(x.route)}</small>` : ""}</span><span class="v"><small>${esc(new Date(x.t).toLocaleDateString([], { month: "short", day: "numeric" }))}</small><span class="chev">›</span></span></button>`).join("");
  $("recent").querySelectorAll("button").forEach((b) => b.addEventListener("click", () => go(b.dataset.q)));
}
function addRecent() {
  const r = store.get("tw:recent", []).filter((x) => x.q !== F.q);
  r.unshift({ q: F.q, route: F.origin && F.dest ? `${apCity(F.origin)} → ${apCity(F.dest)}` : "", t: Date.now() });
  store.set("tw:recent", r.slice(0, 8));
}
function go(q, extra = "") { q = normQ(q); if (!q) return; history.pushState(null, "", `?f=${q}${extra}`); route(); }

function openFlight(q, url = {}) {
  const key = "tw:f:" + q;
  let st = store.get(key);
  const fresh = (o = {}) => ({ q, route: o.route || null, cls: o.cls || "", track: [], reports: [], flog: {}, manual: null, dep: null, last: null, info: null, seen: Date.now() });
  if (!st || !Array.isArray(st.track) || Date.now() - (st.seen || 0) > 20 * HOUR) st = fresh(st || {});
  if (url.from || url.to) st.route = { from: (url.from || "").toUpperCase(), to: (url.to || "").toUpperCase() };
  if (url.dep) { const t = Date.parse(url.dep); if (t) st.dep = t; }
  st.seen = Date.now();
  F = { q, key, st, info: st.info, D: st.last, origin: null, dest: null, fix: null };
  GP = null; drawn = null;
  $("home").hidden = true; $("flight").hidden = false; $("tabbar").hidden = false;
  $("fTitle").textContent = q; $("fSub").innerHTML = "&nbsp;"; document.title = `${q} · Turbulence Watch`;
  $("banner").hidden = true;
  showTab(["now", "map", "trip", "guide"].includes(tab) ? tab : "now");
  loadAirports().then(() => {
    if (F?.q !== q) return;
    if (F.info) resolveRoute();
    if (F.D) { F.fix = positionNow(); fitGP(); renderAll(); setStatus(`Showing the forecast from ${fmtT(F.D.at)} · updating…`); }
  });
  refresh();
  startTimers();
}
function route() {
  const p = new URLSearchParams(location.search), f = normQ(p.get("f"));
  if (f) openFlight(f, { from: p.get("from"), to: p.get("to"), dep: p.get("dep") }); else showHome();
}

/* ------------------------------------------------------------------ refresh cycle */
const setStatus = (t) => { $("status").textContent = t; };
async function refresh() {
  if (!F || busy) return;
  busy = true; lastTry = Date.now(); errMsg = "";
  const q = F.q;
  $("refreshBtn").classList.add("spin");
  setStatus(F.D ? `Updating… (last ${fmtT(F.D.at)})` : "Finding the plane and the latest forecasts…");
  try {
    await loadAirports();
    let info = null;
    try { info = await api(`/api/flight?q=${encodeURIComponent(q)}`, {}, 20000); } catch (e) { info = null; errMsg = "Couldn't reach the flight-tracking service."; }
    if (F?.q !== q) return;
    if (info) { F.info = info; F.st.info = info; recordFix(info.position); }
    resolveRoute();
    try { await compute(); }
    catch (e) {
      errMsg = e.status === 503 ? "The forecast fields aren't published yet (first data build still running). Try again in a few minutes." : navigator.onLine === false ? "You're offline." : "Couldn't load the forecast (" + (e.message || "error") + ").";
    }
    if (F?.q !== q) return;
    if (F.D) { F.st.last = F.D; }
    F.st.seen = Date.now();
    saveF(); addRecent();
  } finally {
    busy = false;
    $("refreshBtn").classList.remove("spin");
    if (F?.q === q) { fitGP(); renderAll(); }
  }
}
let timers = [];
function startTimers() {
  stopTimers();
  timers.push(setInterval(() => { if (F && document.visibilityState === "visible" && Date.now() - lastTry > (F.fix?.kind === "live" ? 2 : 5) * MIN) refresh(); }, 20e3));
  timers.push(setInterval(() => { if (F && F.D && document.visibilityState === "visible") { renderNow(); updatePlane(); } }, 30e3));
}
function stopTimers() { timers.forEach(clearInterval); timers = []; }
document.addEventListener("visibilitychange", () => { if (F && document.visibilityState === "visible" && Date.now() - lastTry > MIN) refresh(); });

/* ------------------------------------------------------------------ rendering */
function renderAll() {
  if (!F) return;
  renderHeader(); renderBanner(); renderNow(); renderTrip(); renderLadder();
  if (MAP && tab === "map") drawMap();
}
function renderHeader() {
  const cls = F.D && !F.D.landed ? classFor() : null, ty = F.info?.aircraft?.type, tn = ty && TYPES[ty] ? TYPES[ty][0] : ty;
  const al = F.info?.airline?.name;
  $("fTitle").textContent = F.info?.flight || F.q;
  const parts = [];
  if (F.origin && F.dest) parts.push(`${esc(apCity(F.origin))} → ${esc(apCity(F.dest))}`);
  if (tn) parts.push(esc(tn)); else if (al) parts.push(esc(al)); else if (cls) parts.push(esc(cls.name));
  $("fSub").innerHTML = parts.join(" · ") || "&nbsp;";
  const D = F.D;
  if (busy) return;
  if (errMsg) setStatus(errMsg + (D && D.at ? ` Showing the forecast from ${fmtT(D.at)}.` : ""));
  else if (D && D.at) setStatus(`Updated ${fmtT(D.at)} (${ago(D.at)}) · times in ${tzLabel()}`);
}
function renderBanner() {
  const b = $("banner"), fx = F.fix, D = F.D;
  let html = "", info = false;
  const posBtns = `<div class="btns"><button class="pill" type="button" data-act="dep">Set takeoff time</button><button class="pill gray" type="button" data-act="tap">Tap my position</button></div>`;
  if (F.routeWarn === "unknown") html = `<div><b>We couldn't find ${esc(F.q)}'s route.</b> Tell us where it flies and the forecast follows.</div><div class="btns"><button class="pill" type="button" data-act="from">Set departure</button><button class="pill" type="button" data-act="to">Set destination</button></div>`;
  else if (F.routeWarn === "mismatch") html = `<div><b>The route looks wrong.</b> The flight database says ${esc(apCode(F.origin))} → ${esc(apCode(F.dest))}, but the plane isn't on that path. Set the right one.</div><div class="btns"><button class="pill" type="button" data-act="to">Set destination</button><button class="pill gray" type="button" data-act="from">Set departure</button></div>`;
  else if (fx?.kind === "unknown") { info = true; html = `<div><b>Can't see ${esc(F.q)} right now.</b> If you're already flying (planes vanish from trackers over oceans), set your takeoff time or tap where you are. Until then this assumes takeoff now.</div>${posBtns}`; }
  else if (fx?.kind === "dr" && Date.now() - fx.t > 20 * MIN) { info = true; html = `<div><b>Last seen ${fmtT(fx.t)}</b> (${esc(fx.src)}). Trackers lose planes over oceans, so your position is estimated along the path. If you know better, tap where you are.</div><div class="btns"><button class="pill gray" type="button" data-act="tap">Tap my position</button></div>`; }
  else if (fx?.kind === "landed") { info = true; html = `<div><b>Landed</b> at ${esc(apCity(F.dest))}.</div>`; }
  b.hidden = !html; b.className = "banner" + (info ? " info" : ""); b.innerHTML = html;
  b.querySelectorAll("[data-act]").forEach((x) => x.addEventListener("click", () => act(x.dataset.act)));
}
function act(a) {
  if (a === "from" || a === "to") openSheet(a);
  else if (a === "dep") { showTab("trip"); setTimeout(() => { $("depRow").scrollIntoView({ block: "center" }); $("depInput").focus(); }, 60); }
  else if (a === "tap") startTap();
}

function renderNow() {
  const D = F.D, fx = F.fix;
  if (!D || D.landed || !D.med) {
    $("hero").innerHTML = D?.landed ? `<div class="lvl"><i class="dot" style="background:var(--green)"></i><span>Landed</span></div><div class="small">Welcome to ${esc(apCity(F.dest))}.</div>` : `<div class="lvl"><i class="dot" style="background:var(--label3)"></i><span>${busy ? "Loading" : "No forecast yet"}</span></div><div class="small">${busy ? "Getting the plane's position and the latest forecasts." : esc(errMsg || "Set the route in the Flight tab.")}</div>`;
    $("tiles").innerHTML = ""; $("stats").innerHTML = ""; $("hist").innerHTML = ""; $("feelBox").hidden = true;
    return;
  }
  const flying = airborneKind(D.fixKind), el = Math.max(0, nowMin()), at = (m) => fmtT(D.t0 + m * MIN);
  $("feelBox").hidden = !flying;
  const segs = segments();
  if (flying) {
    const r20 = simulate(20), L = level(r20.med);
    let calmAt = null, nextBump = null;
    const gm = gStretch;
    for (let m = Math.round(el); m < D.M; m++) { let ok = true; for (let j = m; j < Math.min(D.M, m + 25); j++) if (gm(j) >= 0.2) { ok = false; break; } if (ok) { calmAt = m; break; } }
    const left = D.M - el;
    for (let m = Math.round(el) + 1; m < D.M; m++) if (gm(m) >= 0.2) { nextBump = m; break; }
    const calm = calmAt === null ? (left < 40 ? "Bumpy into landing, as descents often are." : "No long smooth stretch ahead.") : calmAt <= el + 2 ? (nextBump ? `Smooth until about ${at(nextBump)}.` : "Smooth for the rest of the flight.") : `Smooth again from about ${at(calmAt)}.`;
    $("hero").innerHTML = `<div class="lvl"><i class="dot" style="background:var(${L.c})"></i><span>${L.name}</span></div><div>Biggest jolt in the next 20 min: most likely <b class="num">±${r20.med.toFixed(2)} g</b></div><div class="small">${calm} Chance of anything moderate in the next 20 min: ${pct(r20.pMod)}.</div>`;
  } else {
    const worst = segs.reduce((a, s) => (!a || s.peakG > a.peakG ? s : a), null);
    const L = level(worst ? worst.peakG : 0);
    const when = D.fixKind === "unknown" ? "if you take off now" : `for takeoff at ${fmtT(D.t0)}${dayTag(D.t0)}`;
    $("hero").innerHTML = `<div class="lvl"><i class="dot" style="background:var(${L.c})"></i><span>${worst && L.key !== "smooth" ? "Mostly smooth, some " + L.name.toLowerCase() : "Smooth flight"}</span></div><div>Forecast ${when}.</div><div class="small">${worst && L.key !== "smooth" ? `Bumpiest stretch: ${fmtR(worst.start, worst.end)}, up to ±${worst.peakG.toFixed(2)} g, ${worst.why.toLowerCase()}.` : "No bumpy stretches in the forecast."} The details are in the Flight tab.</div>`;
  }
  // tiles
  const tiles = [];
  const arr = D.arr;
  if (flying) {
    const pos = { live: "Live", dr: "Estimated", manual: "Your tap", takeoff: "Estimated" }[D.fixKind] || "—";
    const sub = !fx ? "" : fx.kind === "live" ? `${fmtT(fx.t)} · ${fx.src}` : fx.kind === "dr" ? `last seen ${fmtT(fx.t)} · ${fx.src}` : fx.kind === "manual" ? `your tap at ${fmtT(fx.t)}` : `from takeoff at ${fmtT(fx.t)}`;
    tiles.push(["Position", pos, sub]);
    const alt = fx?.alt && fx.alt > 1000 ? Math.round(fx.alt / 100) * 100 : D.fl[clamp(Math.round(el), 0, D.M - 1)] * 100;
    tiles.push(["Altitude", alt ? alt.toLocaleString("en-US") + " ft" : "—", fx?.trk != null ? `heading ${Math.round(fx.trk)}°` : ""]);
    tiles.push(["Ground speed", fx?.gs ? `${Math.round(fx.gs)} km/h` : "—", fx?.gs ? `${Math.round(fx.gs / 1.852)} kt` : ""]);
  } else {
    tiles.push(["Takeoff", fmtT(D.t0) + dayTag(D.t0), D.fixKind === "unknown" ? "assumed now" : "your setting"]);
    tiles.push(["Flight time", arr ? dur((arr - D.t0) / MIN) : "—", "estimated"]);
    tiles.push(["Distance", D.L ? Math.round(D.L).toLocaleString("en-US") + " km" : "—", D.L ? Math.round(D.L / 1.852).toLocaleString("en-US") + " nm" : ""]);
  }
  tiles.push(["Landing", arr ? fmtT(arr) + dayTag(arr) : "—", arr && F.dest?.tz ? `${fmtT(arr, F.dest.tz)} in ${apCity(F.dest)}` : arr ? `in ${dur((arr - Date.now()) / MIN)}` : "route unknown"]);
  $("tilesHdr").textContent = flying ? "Right now" : "Your flight";
  $("tiles").innerHTML = tiles.map(([a, b, c]) => `<div class="tile"><span>${esc(a)}</span><b>${esc(b)}</b><small>${esc(c) || "&nbsp;"}</small></div>`).join("");
  renderHist();
  renderFelt();
}
function renderHist() {
  const D = F?.D;
  if (!D || !D.med) return;
  const r = simulate(N);
  const W = 520, H = 220, L = 36, B = 36, T = 10, Rt = 8, xmax = Math.max(0.6, Math.min(1.6, Math.ceil(r.p99 * 1.15 * 10) / 10));
  const bins = 44, bw = xmax / bins, cnt = new Array(bins).fill(0);
  for (const v of r.out) cnt[Math.min(bins - 1, Math.floor(v / bw))]++;
  const cm = Math.max(...cnt), X = (v) => L + ((W - L - Rt) * v) / xmax, Y = (c) => H - B - ((H - B - T) * c) / cm;
  let s = "";
  cnt.forEach((c, i) => { if (!c) return; const v = (i + 0.5) * bw; s += `<rect x="${X(i * bw) + 0.6}" y="${Y(c)}" width="${Math.max(1, X(bw) - X(0) - 1.2)}" height="${H - B - Y(c)}" rx="1.5" style="fill:${col(v)}"/>`; });
  s += `<line class="ax" x1="${L}" y1="${H - B}" x2="${W - Rt}" y2="${H - B}"/>`;
  const st = xmax > 1 ? 0.2 : 0.1;
  for (let v = 0; v <= xmax + 1e-9; v += st) { const x = X(v); s += `<text class="lab" x="${x}" y="${H - B + 16}" text-anchor="${x > W - Rt - 14 ? "end" : x < L + 6 ? "start" : "middle"}">±${v.toFixed(1)}</text>`; }
  s += `<text class="lab" x="${(L + W - Rt) / 2}" y="${H - 4}" text-anchor="middle">biggest jolt, extra g on top of the normal 1 g</text>`;
  [[r.med, "most likely", 0], [r.p90, "9 in 10 below", 14]].forEach(([v, lab, dy]) => { if (v <= xmax) s += `<line class="mk" x1="${X(v)}" y1="${T + 4}" x2="${X(v)}" y2="${H - B}"/><text class="mkt" x="${Math.min(X(v) + 4, W - 80)}" y="${T + 14 + dy}">${lab}</text>`; });
  $("hist").innerHTML = s; nowMed = r.med;
  $("stats").innerHTML = `<div class="tile"><span>Most likely</span><b class="num">±${r.med.toFixed(2)} g</b><small>${level(r.med).name}</small></div><div class="tile"><span>9 in 10 below</span><b class="num">±${r.p90.toFixed(2)} g</b><small>${level(r.p90).name}</small></div><div class="tile"><span>Moderate ±0.5 g</span><b class="num">${pct(r.pMod)}</b><small>chance</small></div><div class="tile"><span>Severe ±1 g</span><b class="num">${pct(r.pSev)}</b><small>chance</small></div>`;
  $("nLabel").textContent = N >= 60 && N % 60 === 0 ? N / 60 + (N === 60 ? " hour" : " hours") : N + " min";
  renderLadder();
}
function setN(n) {
  N = n; store.set("tw:N", n); $("nSlider").value = n;
  document.querySelectorAll("#nSeg button").forEach((b) => b.setAttribute("aria-pressed", String(+b.dataset.n === n)));
  renderHist();
}

/* bump reports */
function forecastGAt(t) { const D = F.D, f = F.st.flog[isoMin(t)]; if (!D || f == null) return null; return 0.7 * kAt(Math.max(0, (t - D.t0) / MIN)) * f; }
function renderFelt() {
  $("feltNote").textContent = GP && GP.n ? `Tuned on ${GP.n} report${GP.n > 1 ? "s" : ""}: overall the bumps run ${GP.factor.toFixed(2)}× the raw forecast, and ${GP.now.toFixed(2)}× right around now. The odds on this page include both.` : "Tap what you feel. Your reports tune the forecast for the next stretch (they stay on this device).";
  const items = F.st.reports.slice(-5).reverse(), box = $("feltList");
  box.hidden = !items.length;
  box.innerHTML = items.map((f) => { const g = forecastGAt(f.t), lv = LEVELS.find((l) => l.key === f.level) || LEVELS[0]; return `<div class="row"><span class="k" style="display:flex;align-items:center;gap:10px"><i class="dot" style="background:var(${lv.c})"></i>${lv.name}</span><span class="v num">${fmtT(f.t)}${g != null ? ` · forecast ±${g.toFixed(2)} g` : ""}</span></div>`; }).join("");
}
function report(lv) {
  if (!F?.D || F.D.landed) return;
  const m = clamp(Math.round(nowMin()), 0, F.D.M - 1);
  F.st.reports.push({ t: Date.now(), level: lv, lat: F.D.lat[m], lon: F.D.lon[m] });
  if (!(isoMin(Date.now()) in F.st.flog)) F.st.flog[isoMin(Date.now())] = F.D.med[m];
  saveF(); fitGP(); renderNow(); renderTrip();
  $("feltNote").textContent = `Logged ${lv} at ${fmtT(Date.now())}. ` + $("feltNote").textContent;
  document.querySelectorAll("#feelBtns button").forEach((x) => (x.disabled = true));
  setTimeout(() => document.querySelectorAll("#feelBtns button").forEach((x) => (x.disabled = false)), 2000);
}

/* stretches of the flight with the same level */
function segments() {
  const D = F.D;
  if (!D?.steps?.length) return [];
  const now = Date.now(), out = [];
  const steps = D.steps.filter((s, i) => i === D.steps.length - 1 || D.steps[i + 1].t > now);
  let cur = null;
  steps.forEach((s, i) => {
    const g = gAtStep(s), end = i < steps.length - 1 ? steps[i + 1].t : D.arr || s.t + 5 * MIN, last = out[out.length - 1];
    // hysteresis: only change level once the jolt estimate is clearly (10%) across the boundary, so the list doesn't flicker
    let li = LEVELS.findIndex((l) => g < l.max);
    if (cur != null && li !== cur) { const thr = li > cur ? LEVELS[cur].max : LEVELS[li].max; if (li > cur ? g < thr * 1.1 : g > thr * 0.9) li = cur; }
    cur = li;
    const lv = LEVELS[li];
    if (last && last.key === lv.key) {
      last.end = end; last.drv.add(s.drv); s.flags.forEach((f) => last.flags.add(f));
      if (g > last.peakG) { last.peakG = g; last.peakE = s.med; }
      for (const [k, v] of Object.entries(s.mem)) last.mem[k] = Math.max(last.mem[k] ?? 0, v);
    } else out.push({ key: lv.key, name: lv.name, c: lv.c, start: Math.max(s.t, now), end, peakG: g, peakE: s.med, drv: new Set([s.drv]), flags: new Set(s.flags), mem: { ...s.mem } });
  });
  for (const s of out) s.why = s.drv.has("storm") && s.drv.has("jet") ? "Storms and jet-stream shear" : s.drv.has("storm") ? "Storm clouds near the route" : "Jet-stream wind shear";
  return out;
}

function renderTrip() {
  const D = F.D;
  // settings card
  $("vFrom").textContent = F.origin ? `${apCode(F.origin)} · ${apCity(F.origin)}` : "Set";
  $("vTo").textContent = F.dest ? `${apCode(F.dest)} · ${apCity(F.dest)}` : "Set";
  const cls = classFor();
  $("selCls").innerHTML = `<option value="">Automatic (${esc(cls.auto ? (cls.typeName ? cls.typeName + ", " : "") + cls.name.toLowerCase() : "…")})</option>` + Object.entries(CLS).map(([k, c]) => `<option value="${k}">${c.name}</option>`).join("");
  $("selCls").value = F.st.cls || "";
  const flying = D && !D.landed && (D.fixKind === "live" || D.fixKind === "dr");
  $("depRow").hidden = flying;
  $("depLabel").textContent = F.fix?.kind === "planned" || F.fix?.kind === "unknown" || F.fix?.kind === "ground" ? "Takeoff (planned)" : "Took off at";
  $("depInput").value = F.st.dep ? localInput(F.st.dep) : "";
  $("vPos").textContent = F.st.manual ? `set ${fmtT(F.st.manual.t)}` : "";
  $("selTz").value = TZ;
  $("routeNote").textContent = F.routeSrc === "you" ? "Route set by you. Clear both airports to go back to the flight database." : F.routeSrc ? `Route from the ${F.routeSrc.replace(" (reversed)", "")} flight database${F.routeSrc.includes("reversed") ? ", reversed to match the plane" : ""}. Fix it here if it's wrong.` : "Set the route so the forecast can follow it.";
  // data card
  const dl = [];
  const fx = F.fix;
  if (fx && fx.src) dl.push(["Position", `${esc(fx.src)}, ${fmtT(fx.t)}`]);
  if (D?.sources) {
    const run = (k) => (D.sources[k] ? new Date(D.sources[k]).toISOString().slice(11, 13) + "Z " + new Date(D.sources[k]).toISOString().slice(5, 10) : "missing");
    dl.push(["Official WAFS forecast", run("wafs")], ["ECMWF IFS", run("ifs")], ["NOAA GFS", run("gfs")], ["ECMWF AI (AIFS)", run("aifs")]);
    dl.push(["Fields published", fmtT(Date.parse(D.updated)) + dayTag(Date.parse(D.updated))]);
  }
  if (D?.nc) dl.push(["Satellite storms", D.nc.sats.length ? D.nc.sats.join(", ") : "no coverage on this stretch"]);
  $("dataList").innerHTML = dl.map(([a, b]) => `<div class="row"><span class="k">${a}</span><span class="v">${b}</span></div>`).join("") || `<div class="row"><span class="k" style="color:var(--label2)">Loading…</span></div>`;

  if (!D || D.landed || !D.med) { $("timeline").innerHTML = ""; $("segList").innerHTML = ""; $("agree").innerHTML = ""; $("warnList").innerHTML = ""; return; }
  const segs = segments(), now = Date.now();
  const t0 = Math.min(now, D.t0 + (D.steps[0]?.m || 0) * MIN), t1 = D.arr || D.t0 + (D.M - 1) * MIN, X = (t) => 6 + (348 * (t - t0)) / Math.max(1, t1 - t0);
  let s = `<rect class="track" x="6" y="16" width="348" height="16" rx="8"/>`;
  for (const g of segs) { const lv = LEVELS.find((l) => l.key === g.key); s += `<rect x="${X(g.start)}" y="16" width="${Math.max(1.5, X(g.end) - X(g.start))}" height="16" style="fill:var(${lv.c});opacity:${lv.key === "smooth" ? 0.5 : 0.95}"/>`; }
  const span = t1 - t0, stepH = span > 10 * HOUR ? 3 : span > 5 * HOUR ? 2 : 1;
  for (let h = Math.ceil(t0 / (stepH * HOUR)) * stepH * HOUR; h <= t1; h += stepH * HOUR) { const x = X(h); if (x > 22 && x < 330) s += `<text class="t" x="${x}" y="46" text-anchor="middle">${fmtT(h)}</text>`; }
  const nx = X(now);
  if (nx >= 6 && nx <= 354) s += `<line class="now" x1="${nx}" y1="11" x2="${nx}" y2="37" stroke-width="2.5" stroke-linecap="round"/><text class="nowt" x="${clamp(nx - 8, 2, 330)}" y="9">now</text>`;
  s += `<text class="t" x="354" y="61" text-anchor="end">${D.arr ? "landing " + fmtT(t1) : "next 3 hours (route unknown)"}</text>`;
  $("timeline").innerHTML = s;
  $("segList").innerHTML = segs.map((m) => `<div class="row"><span class="k" style="display:flex;align-items:center;gap:10px"><i class="dot" style="background:var(${m.c})"></i><span>${m.name}${m.key !== "smooth" ? `<br><small>${m.why}</small>` : ""}</span></span><span class="v num">${fmtR(m.start, m.end)}<br><small>up to ±${m.peakG.toFixed(2)} g</small></span></div>`).join("") || `<div class="row"><span class="k" style="color:var(--label2)">Nothing left to forecast.</span></div>`;
  const NAME = { wafs: "Official WAFS", ifs: "ECMWF", gfs: "NOAA GFS", aifs: "ECMWF AI", storm: "Storms" };
  const ag = segs.filter((x) => x.key !== "smooth").slice(0, 4);
  $("agree").innerHTML = ag.length ? ag.map((x, i) => `<div style="font-size:15px;font-weight:600;margin:${i ? 14 : 0}px 0 8px">${fmtR(x.start, x.end)}</div><div class="mem">${Object.entries(x.mem).sort((a, b) => (a[0] === "storm") - (b[0] === "storm")).map(([k, v]) => `<span>${NAME[k] || k}</span><span class="b"><i style="width:${Math.min(100, (v / 0.5) * 100)}%;background:${col(gPerEdr(nowMin()) * v)}"></i></span><span class="num">${v.toFixed(2)}</span>`).join("")}</div>`).join("") : `<div style="color:var(--label2);font-size:15px">No bumpy stretches left to compare.</div>`;
  // warnings and pilot reports
  // each warning/report once, with the stretch of the flight it applies to
  const fspan = new Map(), fsteps = D.steps.filter((x, i) => i === D.steps.length - 1 || D.steps[i + 1].t > now);
  fsteps.forEach((x, i) => {
    const end = i < fsteps.length - 1 ? fsteps[i + 1].t : D.arr || x.t + 5 * MIN;
    for (const f of x.flags) {
      if (!(/^(Official|Pilot|Forecast chart)/.test(f) || /satellite/.test(f))) continue;
      const sp = fspan.get(f);
      if (!sp) fspan.set(f, [Math.max(x.t, now), end]); else sp[1] = Math.max(sp[1], end);
    }
  });
  const rank = (f) => (/^Official/.test(f) ? 0 : /satellite/.test(f) ? 1 : /^Pilot/.test(f) ? 2 : 3);
  const rows = [...fspan.entries()].sort((a, b) => rank(a[0]) - rank(b[0]) || a[1][0] - b[1][0]).slice(0, 12);
  $("warnList").innerHTML = rows.map(([f, [a, b]]) => `<div class="row"><span class="k" style="font-size:15px">${esc(f)}</span><span class="v"><small>${fmtR(a, b)}</small></span></div>`).join("") || `<div class="row"><span class="k" style="color:var(--label2);font-size:15px">No official warnings or pilot reports on your path for when you'll be there.</span></div>`;
}

/* ------------------------------------------------------------------ map */
// Live infrared clouds, one rendering everywhere: Meteosat over Europe/Africa/Atlantic (EUMETView), GOES-East/West and
// Himawari elsewhere (NASA GIBS). Only mid and high cloud is drawn; the colder (higher) the top, the brighter.
const cloudSat = (lon, lat) => { if (Math.abs(lat) > 72) return null; lon = wrap(lon); return lon >= -60 && lon < 70 ? "msg" : lon >= -115 && lon < -60 ? "GOES-East" : lon >= 70 && lon < 175 ? "Himawari" : "GOES-West"; };
let CloudLayer = null;
function defineCloudLayer() {
  if (CloudLayer || !window.L) return;
  CloudLayer = L.GridLayer.extend({
    createTile(c, done) {
      const cv = document.createElement("canvas"); cv.width = cv.height = 256;
      const n = 1 << c.z, x = ((c.x % n) + n) % n;
      const lon = ((x + 0.5) / n) * 360 - 180, lat = Math.atan(Math.sinh(Math.PI * (1 - (2 * (c.y + 0.5)) / n))) / DEG, s = cloudSat(lon, lat);
      if (!s || c.y < 0 || c.y >= n) { setTimeout(() => done(null, cv), 0); return cv; }
      let url, crop = null;
      if (s === "msg") {
        const R = 20037508.342789244, x0 = -R + (x / n) * 2 * R, x1 = -R + ((x + 1) / n) * 2 * R, y1 = R - (c.y / n) * 2 * R, y0 = R - ((c.y + 1) / n) * 2 * R;
        url = `https://view.eumetsat.int/geoserver/wms?service=WMS&version=1.1.1&request=GetMap&layers=msg_fes:ir108&styles=&srs=EPSG:3857&bbox=${x0},${y0},${x1},${y1}&width=256&height=256&format=image/png`;
      } else {
        const dz = Math.max(0, c.z - 6), px = x >> dz, py = c.y >> dz, sz = 256 >> dz;
        if (dz) crop = [(x - (px << dz)) * sz, (c.y - (py << dz)) * sz, sz];
        url = `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/${s}_${s === "Himawari" ? "AHI" : "ABI"}_Band13_Clean_Infrared/default/default/GoogleMapsCompatible_Level6/${c.z - dz}/${py}/${px}.png`;
      }
      loadImg(url).catch(() => new Promise((r) => setTimeout(r, 1200)).then(() => loadImg(url))).then((im) => {   // one retry: EUMETView sometimes 500s
        const ctx = cv.getContext("2d", { willReadFrequently: true });
        ctx.imageSmoothingEnabled = !crop;   // keep GIBS palette colours exact when enlarging
        if (crop) ctx.drawImage(im, crop[0], crop[1], crop[2], crop[2], 0, 0, 256, 256); else ctx.drawImage(im, 0, 0, 256, 256);
        const img = ctx.getImageData(0, 0, 256, 256), d = img.data, T = tileTemps(d, 256, 256, s === "msg");
        for (let p = 0, i = 0; p < T.length; p++, i += 4) {
          const t = T[p];
          if (!(t < -15)) { d[i + 3] = 0; continue; }
          const f = clamp((-t - 15) / 45, 0, 1), v = 140 + 115 * f;   // brighter and more opaque the higher (colder) the top
          d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = Math.round(255 * (0.16 + 0.72 * f));
        }
        ctx.putImageData(img, 0, 0); done(null, cv);
      }).catch(() => done(null, cv));
      return cv;
    },
  });
}
let MAP = null, drawn = null, tapMode = false;
const LAYERS = store.get("tw:layers", { turb: true, clouds: true, storms: true, warn: true });
function initMap() {
  if (MAP || !window.L || $("flight").hidden) return;
  defineCloudLayer();
  const map = L.map("map", { zoomControl: true, minZoom: 2, maxZoom: 10, worldCopyJump: false, attributionControl: true, zoomSnap: 0.5 });
  map.zoomControl.setPosition("bottomright");
  map.createPane("base").style.zIndex = 150;
  map.getPane("base").classList.add("basepane");
  const gibsT = (layer, lvl, ext, o = {}) => L.tileLayer(`https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/${layer}/default/default/GoogleMapsCompatible_Level${lvl}/{z}/{y}/{x}.${ext}`, { maxNativeZoom: lvl, maxZoom: 12, ...o });
  gibsT("BlueMarble_ShadedRelief_Bathymetry", 8, "jpg", { pane: "base", attribution: '<a href="https://earthdata.nasa.gov/gibs">NASA GIBS</a>' }).addTo(map);
  gibsT("Coastlines_15m", 13, "png", { opacity: 0.35 }).addTo(map);
  const wms = (layers, o = {}) => L.tileLayer.wms("https://view.eumetsat.int/geoserver/wms", { layers, format: "image/png", transparent: true, version: "1.3.0", attribution: '<a href="https://view.eumetsat.int">EUMETSAT</a>', ...o });
  const groups = {
    clouds: L.layerGroup([new CloudLayer({ maxNativeZoom: 8, maxZoom: 12, opacity: 0.9, attribution: "Clouds: EUMETSAT, NOAA, JMA via NASA GIBS" })]),
    storms: L.layerGroup([wms("msg_fes:rdt", { opacity: 0.85 }), wms("mtg_fd:li_afa", { opacity: 0.9 })]),
    turb: L.layerGroup(), warn: L.layerGroup(), route: L.layerGroup(),
  };
  for (const [k, g] of Object.entries(groups)) if (k === "route" || LAYERS[k]) g.addTo(map);
  map.createPane("planePane").style.zIndex = 650;
  MAP = { map, groups, plane: null, view: store.get("tw:view", "30"), turbKey: null };
  map.on("click", (e) => {
    if (!tapMode || !F) return;
    tapMode = false; $("mapWrap").classList.remove("tapmode");
    const cls = classFor(), ll = e.latlng.wrap();
    F.st.manual = { lat: ll.lat, lon: ll.lng, t: Date.now(), alt: (F.D?.fl?.[0] || cls.fl) * 100, gs: cls.v, trk: F.dest ? brg(ll.lat, ll.lng, F.dest.lat, F.dest.lon) : null };
    saveF(); MAP.view = "30"; refresh();
  });
  document.querySelectorAll("#layerChips .chip").forEach((b) => b.setAttribute("aria-pressed", String(!!LAYERS[b.dataset.l])));
  setView(MAP.view, false);
}
function startTap() {
  tapMode = true; showTab("map");
  setTimeout(() => $("mapWrap").classList.add("tapmode"), 80);
}
// path in continuous longitudes (no jumps at the date line), from minute a to b
function pathLL(a, b, step = 1) {
  const D = F.D, out = [];
  let ref = D.lon[clamp(Math.round(nowMin()), 0, D.M - 1)];
  for (let m = Math.max(0, a); m <= Math.min(D.M - 1, b); m += step) { const lo = unwrapTo(D.lon[m], ref); ref = lo; out.push([D.lat[m], lo, m]); }
  return out;
}
function planeLL() {
  const D = F.D, m = clamp(nowMin(), 0, D.M - 1), i = Math.floor(m), f = m - i, j = Math.min(D.M - 1, i + 1);
  const lat = D.lat[i] + (D.lat[j] - D.lat[i]) * f, lon = D.lon[i] + wrap(D.lon[j] - D.lon[i]) * f;
  return [lat, lon, headingAt({ lat: D.lat, lon: D.lon, M: D.M }, i)];
}
const planeSvg = (h, est) => `<svg width="34" height="34" viewBox="0 0 24 24" style="transform:rotate(${h}deg)"><path d="M12 2c.8 0 1.3.9 1.3 2v5.2l7.7 4.6v2l-7.7-2.4v4.4l2.2 1.7V21L12 20l-3.5 1v-1.5l2.2-1.7v-4.4L3 15.8v-2l7.7-4.6V4c0-1.1.5-2 1.3-2z" fill="${est ? "#bfefff" : "#4fd1ff"}" stroke="#062a3a" stroke-width=".8"/></svg>`;
function updatePlane() {
  if (!MAP || !F?.D || F.D.landed || !F.D.lat) return;
  const [la, lo, h] = planeLL(), est = F.fix?.kind !== "live";
  const ref = MAP.lonRef ?? lo, ll = [la, unwrapTo(lo, ref)];
  const icon = L.divIcon({ className: "plane", html: planeSvg(h, est) + (est ? `<div class="planeLab" style="position:absolute;left:36px;top:9px">estimated now</div>` : ""), iconSize: [34, 34], iconAnchor: [17, 17] });
  if (!MAP.plane) MAP.plane = L.marker(ll, { icon, pane: "planePane", interactive: false }).addTo(MAP.groups.route);
  else { MAP.plane.setLatLng(ll); MAP.plane.setIcon(icon); }
}
function drawMap() {
  if (!MAP || !F) return;
  const D = F.D, gR = MAP.groups.route, gW = MAP.groups.warn;
  if (!D || D.landed || !D.lat) { gR.clearLayers(); MAP.plane = null; return; }
  const key = D.at + ":" + Math.round(nowMin() / 5);
  if (drawn !== key) {
    drawn = key;
    gR.clearLayers(); gW.clearLayers(); MAP.plane = null;
    const mNow = clamp(Math.round(nowMin()), 0, D.M - 1);
    const ahead = pathLL(mNow, D.M - 1);
    MAP.lonRef = ahead.length ? ahead[0][1] : D.lon[0];
    // flown track (saved fixes) and the line from the last fix to "now"
    const tr = F.st.track.filter((p) => D.t0 - p[2] < 16 * HOUR);
    if (tr.length) {
      let ref = MAP.lonRef; const pts = [];
      for (let i = tr.length - 1; i >= 0; i--) { const lo = unwrapTo(tr[i][1], ref); ref = lo; pts.unshift([tr[i][0], lo]); }
      L.polyline(pts, { color: "#4fd1ff", weight: 3, opacity: 0.9 }).addTo(gR);
    }
    const firstFix = tr.length ? tr[0] : null;
    if (F.origin && D.fixKind !== "planned" && D.fixKind !== "unknown" && D.fixKind !== "ground" && D.fixKind !== "takeoff") {
      const to = firstFix ? [firstFix[0], firstFix[1]] : [D.lat[0], D.lon[0]], L0 = hav(F.origin.lat, F.origin.lon, to[0], to[1]);
      if (L0 > 50) {
        const pts = []; let ref = MAP.lonRef, la = F.origin.lat, lo = F.origin.lon;
        const k = Math.ceil(L0 / 50);
        for (let i = 0; i <= k; i++) { pts.push([la, lo]); [la, lo] = move(la, lo, brg(la, lo, to[0], to[1]), L0 / k); }
        for (let i = pts.length - 1; i >= 0; i--) { const u = unwrapTo(pts[i][1], ref); ref = u; pts[i][1] = u; }
        L.polyline(pts, { color: "#4fd1ff", weight: 2, opacity: 0.45, dashArray: "1 6" }).addTo(gR);
      }
    }
    const back = pathLL(0, mNow);
    if (back.length > 1 && D.fixKind !== "planned" && D.fixKind !== "unknown" && D.fixKind !== "ground") L.polyline(back.map((p) => [p[0], p[1]]), { color: "#4fd1ff", weight: 3, opacity: 0.6, dashArray: "2 6" }).addTo(gR);
    // corridor (80%: +-1.28 sigma)
    const left = [], right = [];
    for (const [la, lo, m] of pathLL(mNow, D.M - 1, 3)) {
      const h = headingAt({ lat: D.lat, lon: D.lon, M: D.M }, m), off = 1.28 * D.sig[m];
      const a = move(la, lo, h - 90, off), b = move(la, lo, h + 90, off);
      left.push([a[0], unwrapTo(a[1], lo)]); right.push([b[0], unwrapTo(b[1], lo)]);
    }
    if (left.length > 1) L.polygon([...left, ...right.reverse()], { color: "#ff4fd8", weight: 1, opacity: 0.45, dashArray: "3 5", fillColor: "#ff4fd8", fillOpacity: 0.1, interactive: false }).addTo(gR);
    // projected path, coloured by the expected jolts
    const segs = [];
    for (let i = 0; i < D.steps.length - 1; i++) {
      const s = D.steps[i], e = D.steps[i + 1];
      if (e.m < mNow) continue;
      const pts = pathLL(Math.max(s.m, mNow), e.m, 1).map((p) => [p[0], p[1]]);
      if (pts.length > 1) segs.push([pts, level(gAtStep(s)).hex]);
    }
    let ref = MAP.lonRef;
    for (const [pts, c] of segs) { const fixd = pts.map(([a, b]) => { const lo = unwrapTo(b, ref); ref = lo; return [a, lo]; }); L.polyline(fixd, { color: c, weight: 4, opacity: 0.95, dashArray: "8 6", lineCap: "butt" }).addTo(gR); }
    // time ticks: every 30 min for the first 2 h, then hourly
    const tz = tzOf();
    let lref = MAP.lonRef;
    for (let t = Math.ceil((D.t0 + mNow * MIN) / (30 * MIN)) * 30 * MIN; t <= (D.arr || D.t0 + (D.M - 1) * MIN); t += 30 * MIN) {
      const m = Math.round((t - D.t0) / MIN), hourly = new Date(t).getUTCMinutes() === 0;
      if (m < 0 || m >= D.M) continue;
      if (t - Date.now() > 2 * HOUR && !hourly) continue;
      const lo = unwrapTo(D.lon[m], lref); lref = lo;
      L.circleMarker([D.lat[m], lo], { radius: hourly ? 3.5 : 2.5, color: "#fff", weight: 1, fillColor: "#fff", fillOpacity: 1, interactive: false }).addTo(gR);
      if (hourly || t - Date.now() < 2 * HOUR) L.marker([D.lat[m], lo], { icon: L.divIcon({ className: "tick", html: `<span style="position:absolute;left:7px;top:-7px">${fmtT(t, tz)}</span>`, iconSize: [0, 0] }), interactive: false }).addTo(gR);
    }
    // airports
    for (const [a, lab] of [[F.origin, "o"], [F.dest, "d"]]) {
      if (!a) continue;
      const lo = unwrapTo(a.lon, MAP.lonRef + (lab === "d" ? wrap(D.lon[D.M - 1] - MAP.lonRef) : 0));
      L.circleMarker([a.lat, lo], { radius: 5, color: "#fff", weight: 2, fillColor: "#111", fillOpacity: 1 }).bindPopup(`<b>${esc(apCode(a))}</b> ${esc(a.name)}`).addTo(gR);
      L.marker([a.lat, lo], { icon: L.divIcon({ className: "aplab", html: `<span style="position:absolute;left:8px;top:-8px">${esc(apCode(a))}</span>`, iconSize: [0, 0] }), interactive: false }).addTo(gR);
    }
    // official warnings and pilot reports
    for (const s of D.sigmets || []) {
      const c0 = s.coords[0], shift = unwrapTo(c0[1], MAP.lonRef) - c0[1];
      L.polygon(s.coords.map(([a, b]) => [a, b + shift]), { color: "#ffb347", weight: 1.5, dashArray: "5 4", fillColor: "#ffb347", fillOpacity: 0.08 })
        .bindPopup(`<b>SIGMET: ${esc((s.qualifier ? s.qualifier.toLowerCase() + " " : "") + (HAZ_NAME[s.hazard] || s.hazard))}</b><br>${esc(s.fir)} · FL${Math.round(s.base / 100)}–${Math.round(s.top / 100)}<br>valid ${fmtR(s.from, s.to)}<div class="raw" style="margin-top:6px">${esc(s.raw)}</div>`).addTo(gW);
    }
    for (const r of D.pireps || []) {
      const lc = LEVELS[Math.min(4, [0, 1, 1, 2, 2, 3, 4][r.lvl])].hex;
      L.circleMarker([r.lat, unwrapTo(r.lon, MAP.lonRef)], { radius: 5, color: "#000", weight: 1, fillColor: lc, fillOpacity: 0.95 })
        .bindPopup(`<b>Pilot report: ${esc(TB_NAME[r.lvl])}</b><br>${r.fl ? "FL" + r.fl + " · " : ""}${esc(r.ac)} · ${ago(r.t)}<div class="raw" style="margin-top:6px">${esc(r.raw)}</div>`).addTo(gW);
    }
    loadTurb();
  }
  updatePlane();
  $("mapMeta").textContent = `Turbulence layer: the forecast for the time you'll pass each spot (blend of the official WAFS forecast and the model ensemble). Clouds: live infrared (Meteosat, GOES, Himawari). Storm cells and lightning: Meteosat area. Times in ${tzLabel()}.${LAYERS.turb && MAP.turbErr ? " " + MAP.turbErr : ""}`;
}
function setView(v, save = true) {
  if (!MAP) return;
  MAP.view = v; if (save) store.set("tw:view", v);
  document.querySelectorAll("#scaleSeg button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.k === v)));
  const D = F?.D;
  if (!D || D.landed || !D.lat) { if (F?.dest) MAP.map.setView([F.dest.lat, F.dest.lon], 5); else MAP.map.setView([30, 0], 2); return; }
  const mNow = clamp(Math.round(nowMin()), 0, D.M - 1), [la, lo] = planeLL();
  if (v === "plane") { MAP.map.setView([la, unwrapTo(lo, MAP.lonRef ?? lo)], 7); return; }
  const span = v === "all" ? D.M : +v;
  const pts = pathLL(v === "all" ? 0 : mNow, Math.min(D.M - 1, mNow + span), 2);
  if (v === "all") for (const p of F.st.track) pts.push([p[0], unwrapTo(p[1], pts[0]?.[1] ?? p[1])]);
  if (pts.length < 2) { MAP.map.setView([la, lo], 6); return; }
  const b = L.latLngBounds(pts.map((p) => [p[0], p[1]]));
  const pad = v === "all" ? 0 : clamp(1.28 * (D.sig[Math.min(D.M - 1, mNow + span)] || 20) / 111, 0.2, 3);
  MAP.map.fitBounds(b.pad(0.08).extend([b.getSouth() - pad, b.getWest() - pad]).extend([b.getNorth() + pad, b.getEast() + pad]), { maxZoom: v === "30" ? 8 : 7, animate: save });
}
// forecast overlay: frames from /api/grid, each cell coloured by the forecast at the time the plane passes nearest to it
async function loadTurb() {
  const D = F.D, g = MAP.groups.turb;
  if (!D || !D.lat || !LAYERS.turb) return;
  const key = D.at;
  if (MAP.turbKey === key) return;
  MAP.turbKey = key; MAP.turbErr = "";
  const mNow = clamp(Math.round(nowMin()), 0, D.M - 1), pts = pathLL(mNow, D.M - 1, 10);
  if (pts.length < 1) return;
  let la0 = 90, la1 = -90, lo0 = 1e9, lo1 = -1e9;
  for (const [a, b] of pts) { la0 = Math.min(la0, a); la1 = Math.max(la1, a); lo0 = Math.min(lo0, b); lo1 = Math.max(lo1, b); }
  la0 = Math.max(-80, la0 - 8); la1 = Math.min(80, la1 + 8); lo0 -= 10; lo1 += 10;
  if (lo1 - lo0 > 300) { lo0 = -180; lo1 = 180; }
  const fl = D.fl[mNow] > 200 ? D.fl[mNow] : 370;
  let js;
  try { js = await api(`/api/grid?bbox=${lo0.toFixed(1)},${la0.toFixed(1)},${lo1.toFixed(1)},${la1.toFixed(1)}&fl=${fl}&t0=${new Date(D.t0 + mNow * MIN).toISOString()}&t1=${new Date(D.arr || D.t0 + D.M * MIN).toISOString()}`, {}, 30000); }
  catch (e) { MAP.turbErr = "Turbulence layer unavailable right now."; MAP.turbKey = null; return; }
  if (!F || F.D !== D) return;
  const frames = js.frames.map((f) => ({ t: Date.parse(f.valid), a: Uint8Array.from(atob(f.edr), (c) => c.charCodeAt(0)) }));
  const ni = js.nlat, nj = js.nlon, E = js.edr_scale;
  // nearest path point (every 10 min) for each cell -> the time the plane is there -> nearest frame
  const P = pts.map(([a, b, m]) => [a, b, D.t0 + m * MIN]);
  const fi = new Uint8Array(ni * nj), dk = new Float32Array(ni * nj);
  for (let i = 0; i < ni; i++) {
    const la = js.lat0 + i * js.dlat, cl = Math.cos(la * DEG);
    for (let j = 0; j < nj; j++) {
      const lo = js.lon0 + j * js.dlon;
      let best = 0, bd = Infinity;
      for (let k = 0; k < P.length; k++) { const dy = la - P[k][0], dx = (lo - P[k][1]) * cl, d = dx * dx + dy * dy; if (d < bd) { bd = d; best = k; } }
      const t = P[best][2];
      let fb = 0; for (let f = 1; f < frames.length; f++) if (Math.abs(frames[f].t - t) < Math.abs(frames[fb].t - t)) fb = f;
      fi[i * nj + j] = fb; dk[i * nj + j] = Math.sqrt(bd) * 111;
    }
  }
  const kk = gPerEdr(mNow + 120);
  // value per cell from its own valid time, then smooth (bilinear) between cells
  const val = new Float32Array(ni * nj);
  for (let c = 0; c < ni * nj; c++) val[c] = frames[fi[c]].a[c] * E;
  const latN = js.lat0 - js.dlat / 2, latS = js.lat0 + (ni - 0.5) * js.dlat, lonW = js.lon0 - js.dlon / 2, lonE = js.lon0 + (nj - 0.5) * js.dlon;
  const merc = (la) => Math.log(Math.tan(Math.PI / 4 + (clamp(la, -85, 85) * DEG) / 2));
  const W = clamp(nj * 3, 64, 1400), y0 = merc(latN), y1 = merc(latS), H = clamp(Math.round((W * (y0 - y1)) / ((lonE - lonW) * DEG)), 32, 1600);
  const cv = document.createElement("canvas"); cv.width = W; cv.height = H;
  const cx = cv.getContext("2d"), img = cx.createImageData(W, H), px = img.data;
  const rgb = LEVELS.map((l) => [parseInt(l.hex.slice(1, 3), 16), parseInt(l.hex.slice(3, 5), 16), parseInt(l.hex.slice(5, 7), 16)]);
  const bil = (A, i0, i1, j0, j1, wy, wx) => (A[i0 * nj + j0] * (1 - wx) + A[i0 * nj + j1] * wx) * (1 - wy) + (A[i1 * nj + j0] * (1 - wx) + A[i1 * nj + j1] * wx) * wy;
  for (let y = 0; y < H; y++) {
    const la = (2 * Math.atan(Math.exp(y0 - ((y + 0.5) / H) * (y0 - y1))) - Math.PI / 2) / DEG;
    const fiy = (la - js.lat0) / js.dlat, i0 = clamp(Math.floor(fiy), 0, ni - 1), i1 = clamp(i0 + 1, 0, ni - 1), wy = clamp(fiy - i0, 0, 1);
    for (let x = 0; x < W; x++) {
      const lo = lonW + ((x + 0.5) / W) * (lonE - lonW);
      const fjx = (lo - js.lon0) / js.dlon, j0 = clamp(Math.floor(fjx), 0, nj - 1), j1 = clamp(j0 + 1, 0, nj - 1), wx = clamp(fjx - j0, 0, 1);
      const gg = kk * bil(val, i0, i1, j0, j1, wy, wx);
      if (gg < 0.17) continue;
      const lv = LEVELS.findIndex((l) => gg < l.max), [r, g2, b] = rgb[Math.max(1, lv)];
      const fade = clamp(1 - (bil(dk, i0, i1, j0, j1, wy, wx) - 700) / 500, 0.2, 1);
      const al = gg < 0.2 ? 0.08 * (gg - 0.17) / 0.03 : lv === 1 ? 0.08 + 0.32 * clamp((gg - 0.2) / 0.3, 0, 1) : lv === 2 ? 0.55 : 0.65;
      const o = (y * W + x) * 4;
      px[o] = r; px[o + 1] = g2; px[o + 2] = b; px[o + 3] = Math.round(255 * fade * al);
    }
  }
  cx.putImageData(img, 0, 0);
  g.clearLayers();
  L.imageOverlay(cv.toDataURL("image/png"), [[latS, lonW], [latN, lonE]], { opacity: 1, interactive: false }).addTo(g);
}

/* ------------------------------------------------------------------ airport picker */
let sheetFor = null;
function openSheet(which) {
  sheetFor = which;
  $("sheetTitle").textContent = which === "from" ? "Departure airport" : "Destination airport";
  $("sheet").hidden = false; $("apQ").value = ""; searchAp("");
  setTimeout(() => $("apQ").focus(), 50);
}
function closeSheet() { $("sheet").hidden = true; sheetFor = null; }
function searchAp(q) {
  q = q.trim().toLowerCase();
  const list = AP?.list || [];
  let res;
  if (!q) res = list.filter((a) => a.big).slice(0, 0);
  else {
    const sc = (a) => (a.iata.toLowerCase() === q || a.icao.toLowerCase() === q ? 0 : a.city.toLowerCase().startsWith(q) ? 1 + (a.big ? 0 : 1) : a.name.toLowerCase().includes(q) || a.city.toLowerCase().includes(q) ? 3 + (a.big ? 0 : 1) : 9);
    res = list.map((a) => [sc(a), a]).filter(([s]) => s < 9).sort((x, y) => x[0] - y[0]).slice(0, 30).map((x) => x[1]);
  }
  const cur = F && (sheetFor === "from" ? F.origin : F.dest);
  const reset = F?.st.route ? `<button class="row" type="button" data-code=""><span class="k" style="color:var(--tint)">Use the flight database route</span></button>` : "";
  $("apRes").innerHTML = reset + (res.map((a) => `<button class="row" type="button" data-code="${esc(a.iata)}"><span class="k"><b>${esc(a.iata)}</b> ${esc(a.city)}<br><small>${esc(a.name)} · ${esc(a.cc)}</small></span>${cur && cur.iata === a.iata ? '<span class="v" style="color:var(--tint)">✓</span>' : ""}</button>`).join("") || (q ? `<div class="row"><span class="k" style="color:var(--label2)">No airport matches “${esc(q)}”.</span></div>` : `<div class="row"><span class="k" style="color:var(--label2)">Type a city, airport name or code (CDG, LFPG).</span></div>`));
  $("apRes").querySelectorAll("button").forEach((b) => b.addEventListener("click", () => pickAp(b.dataset.code)));
}
function pickAp(code) {
  if (!F) return closeSheet();
  if (!code) F.st.route = null;
  else {
    const r = F.st.route || { from: F.routeSrc === "you" ? "" : apCode(F.origin), to: F.routeSrc === "you" ? "" : apCode(F.dest) };
    r[sheetFor === "from" ? "from" : "to"] = code;
    if (!r.from && F.origin) r.from = apCode(F.origin);
    if (!r.to && F.dest) r.to = apCode(F.dest);
    F.st.route = r;
  }
  F.st.last = null; F.D = null; drawn = null; if (MAP) MAP.turbKey = null;
  saveF(); closeSheet(); resolveRoute(); renderAll(); refresh();
}

/* ------------------------------------------------------------------ wiring */
$("searchForm").addEventListener("submit", (e) => { e.preventDefault(); go($("q").value); });
$("backBtn").addEventListener("click", () => { history.pushState(null, "", location.pathname); route(); });
$("refreshBtn").addEventListener("click", () => refresh());
$("shareBtn").addEventListener("click", async () => {
  if (!F) return;
  const u = new URL(location.origin + location.pathname);
  u.searchParams.set("f", F.q);
  if (F.routeSrc === "you" && F.origin && F.dest) { u.searchParams.set("from", apCode(F.origin)); u.searchParams.set("to", apCode(F.dest)); }
  if (F.st.dep && F.fix?.kind !== "live") u.searchParams.set("dep", new Date(F.st.dep).toISOString());
  const title = `${F.q} turbulence forecast`;
  try { if (navigator.share) await navigator.share({ title, url: u.toString() }); else { await navigator.clipboard.writeText(u.toString()); setStatus("Link copied."); } }
  catch { /* cancelled */ }
});
window.addEventListener("popstate", route);
document.querySelectorAll(".tabbar button").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.t)));
document.querySelectorAll("#nSeg button").forEach((b) => b.addEventListener("click", () => setN(+b.dataset.n)));
$("nSlider").addEventListener("input", (e) => setN(+e.target.value));
document.querySelectorAll("#feelBtns button").forEach((b) => b.addEventListener("click", () => report(b.dataset.l)));
document.querySelectorAll("#scaleSeg button").forEach((b) => b.addEventListener("click", () => setView(b.dataset.k)));
document.querySelectorAll("#layerChips .chip").forEach((b) => b.addEventListener("click", () => {
  const k = b.dataset.l; LAYERS[k] = !LAYERS[k]; store.set("tw:layers", LAYERS); b.setAttribute("aria-pressed", String(LAYERS[k]));
  if (!MAP) return;
  if (LAYERS[k]) { MAP.groups[k].addTo(MAP.map); if (k === "turb") { MAP.turbKey = null; loadTurb(); } } else MAP.groups[k].remove();
}));
$("setFrom").addEventListener("click", () => openSheet("from"));
$("setTo").addEventListener("click", () => openSheet("to"));
$("sheetClose").addEventListener("click", closeSheet);
$("sheet").addEventListener("click", (e) => { if (e.target === $("sheet")) closeSheet(); });
$("apQ").addEventListener("input", (e) => searchAp(e.target.value));
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("sheet").hidden) closeSheet(); });
$("selCls").addEventListener("change", (e) => { if (!F) return; F.st.cls = e.target.value; saveF(); if (F.D && !F.D.landed) { F.D.cls = classFor().key; fitGP(); renderAll(); drawn = null; if (MAP) MAP.turbKey = null; } });
$("depInput").addEventListener("change", (e) => { if (!F) return; const t = e.target.value ? new Date(e.target.value).getTime() : null; F.st.dep = Number.isFinite(t) ? t : null; F.st.manual = null; saveF(); drawn = null; if (MAP) MAP.turbKey = null; refresh(); });
$("tapPos").addEventListener("click", () => startTap());
$("selTz").addEventListener("change", (e) => { TZ = e.target.value; store.set("tw:tz", TZ); drawn = null; renderAll(); });
$("selTheme").value = store.get("tw:theme", "");
$("selTheme").addEventListener("change", (e) => { store.set("tw:theme", e.target.value); applyTheme(e.target.value); });
document.querySelectorAll("#nSeg button").forEach((b) => b.setAttribute("aria-pressed", String(+b.dataset.n === N)));
$("nSlider").value = N;

if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("/sw.js").catch(() => {});
route();
