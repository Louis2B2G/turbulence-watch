// POST {sites: [{lat, lon, from, to}]}  ->  wind near the ground at each site, hour by hour, from three ensembles
// (ECMWF 51, NOAA GEFS 31 and DWD ICON 40 members): percentiles of the friction velocity u* (what drives turbulence in the
// lowest 1-2 km, so the bumps on climb-out and approach) plus the 10 m wind, gusts and direction.
// u* per member = geometric mean of two estimates: the log wind profile over 10 cm roughness, and the turbulent part of the
// model gust (ECMWF's gust = U10 + 7.71 u*). Either alone is off in gusty showers or stable nights; together they hold up.
import { send } from "../lib/http.js";

const MODELS = ["ecmwf_ifs025", "gfs025", "icon_seamless"];
const LN = Math.log(10 / 0.1);
const cache = new Map();
const HOUR = 3600e3;
const pct = (a, p) => (a.length ? a[Math.min(a.length - 1, Math.max(0, Math.round(p * (a.length - 1))))] : null);
const r3 = (x) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 1000) / 1000);

async function model(lat, lon, m, d0, d1) {
  const key = `${lat},${lon},${m},${d0},${d1}`, hit = cache.get(key);
  if (hit && Date.now() - hit.t < 30 * 60e3) return hit.v;
  const u = new URL("https://ensemble-api.open-meteo.com/v1/ensemble");
  u.search = new URLSearchParams({ latitude: lat, longitude: lon, models: m, hourly: "wind_speed_10m,wind_gusts_10m,wind_direction_10m",
    wind_speed_unit: "ms", timeformat: "unixtime", timezone: "GMT", start_date: d0, end_date: d1 }).toString();
  const ctl = new AbortController(), to = setTimeout(() => ctl.abort(), 9000);
  try {
    const r = await fetch(u, { signal: ctl.signal, headers: { "User-Agent": "turbulence-watch" } });
    if (!r.ok) throw new Error(`open-meteo ${r.status}`);
    const v = await r.json();
    cache.set(key, { t: Date.now(), v });
    if (cache.size > 300) cache.delete(cache.keys().next().value);
    return v;
  } finally { clearTimeout(to); }
}

async function site(s) {
  const lat = Math.round(+s.lat * 100) / 100, lon = Math.round(+s.lon * 100) / 100;
  let from = +s.from, to = +s.to;
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(from) || !Number.isFinite(to)) return null;
  if (to < from) [from, to] = [to, from];
  from -= HOUR; to = Math.min(to + HOUR, from + 36 * HOUR);
  const day = (t) => new Date(t).toISOString().slice(0, 10);
  const got = await Promise.allSettled(MODELS.map((m) => model(lat, lon, m, day(from), day(to))));
  const per = new Map();   // hour (ms) -> {us: [], u: [], g: [], x: 0, y: 0}
  let elev = null, n = 0;
  for (const g of got) {
    if (g.status !== "fulfilled" || !g.value?.hourly?.time) continue;
    const H = g.value.hourly, T = H.time.map((x) => x * 1000);
    if (elev == null && Number.isFinite(g.value.elevation)) elev = g.value.elevation;
    for (const k of Object.keys(H)) {
      if (!k.startsWith("wind_speed_10m")) continue;
      const G = H[k.replace("wind_speed_10m", "wind_gusts_10m")], Dd = H[k.replace("wind_speed_10m", "wind_direction_10m")], U = H[k];
      if (!G) continue;
      let used = false;
      for (let i = 0; i < T.length; i++) {
        if (T[i] < from - HOUR || T[i] > to + HOUR) continue;
        const u = U[i], gu = G[i];
        if (u == null || gu == null) continue;
        let p = per.get(T[i]);
        if (!p) per.set(T[i], (p = { us: [], u: [], g: [], x: 0, y: 0 }));
        p.us.push(Math.sqrt(((0.4 * u) / LN) * (Math.max(gu - u, 0) / 7.71)));
        p.u.push(u); p.g.push(gu);
        const d = Dd?.[i];
        if (d != null) { p.x += u * Math.sin((d * Math.PI) / 180); p.y += u * Math.cos((d * Math.PI) / 180); }
        used = true;
      }
      if (used) n++;
    }
  }
  if (!per.size) return null;
  const hours = [...per.entries()].sort((a, b) => a[0] - b[0]).map(([t, p]) => {
    for (const a of [p.us, p.u, p.g]) a.sort((x, y) => x - y);
    return { t, us: [r3(pct(p.us, 0.1)), r3(pct(p.us, 0.5)), r3(pct(p.us, 0.9))], u: r3(pct(p.u, 0.5)), g: [r3(pct(p.g, 0.5)), r3(pct(p.g, 0.9))],
      dir: p.x || p.y ? Math.round(((Math.atan2(p.x, p.y) * 180) / Math.PI + 360) % 360) : null };
  });
  return { lat, lon, elev, n, hours };
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return send(res, 204, {});
  if (req.method !== "POST") return send(res, 405, { error: "POST {sites:[{lat,lon,from,to}]}" });
  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  const sites = Array.isArray(body?.sites) ? body.sites.slice(0, 4) : [];
  if (!sites.length) return send(res, 400, { error: "no sites" });
  const out = await Promise.all(sites.map((s) => site(s || {}).catch(() => null)));
  send(res, 200, { sites: out, models: MODELS });
}
