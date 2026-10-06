// GET ?bbox=lon0,lat0,lon1,lat1&fl=370&t0=iso&t1=iso
//  -> blended turbulence forecast (official WAFS + GFS/ECMWF/AI ensemble + storm proxy) and storm tops,
//     cropped to the box, one frame per 3-hourly valid time between t0 and t1. For the map overlay.
import { manifest, grid } from "../lib/data.js";
import { send } from "../lib/http.js";
import { clamp, nearestFile, wafsAt, modelAt, cbFloor, HOUR } from "../lib/fields.js";

export default async function handler(req, res) {
  let m;
  try { m = await manifest(); } catch { return send(res, 503, { error: "forecast fields not published yet" }); }
  const q = req.query || {};
  const now = Date.now();
  const t0 = Date.parse(q.t0 || q.t || "") || now, t1 = Math.max(t0, Date.parse(q.t1 || "") || t0);
  const fl = clamp(+q.fl || 370, 250, 450);
  let [lo0, la0, lo1, la1] = String(q.bbox || "-180,-75,180,75").split(",").map(Number);
  if (![lo0, la0, lo1, la1].every(Number.isFinite)) return send(res, 400, { error: "bbox=lon0,lat0,lon1,lat1" });
  la0 = clamp(la0, -85, 85); la1 = clamp(la1, -85, 85);
  const G = m.grid, sE = m.scale.edr, sC = m.scale.cbtop_kft;
  const times = m.times.filter((x) => { const t = Date.parse(x); return t >= t0 - 3 * HOUR && t <= t1 + 3 * HOUR; });
  if (!times.length) times.push(m.times.reduce((b, x) => (Math.abs(Date.parse(x) - t0) < Math.abs(Date.parse(b) - t0) ? x : b), m.times[0]));
  const valid = times.slice(0, 12);

  const i0 = clamp(Math.floor((G.lat0 - la1) / -G.dlat), 0, G.nlat - 1), i1 = clamp(Math.ceil((G.lat0 - la0) / -G.dlat), 0, G.nlat - 1);
  const span = Math.min(360, Math.max(G.dlon, lo1 - lo0));
  const lonA = Math.floor((lo0 - G.lon0) / G.dlon) * G.dlon + G.lon0;   // first column, in the caller's (possibly unwrapped) longitude
  const nj = Math.min(G.nlon, Math.ceil(span / G.dlon) + 2), j0 = ((Math.round((lonA - G.lon0) / G.dlon) % G.nlon) + G.nlon) % G.nlon;
  const ni = i1 - i0 + 1;
  const W = m.weights;

  const frames = [];
  for (const vt of valid) {
    const t = Date.parse(vt);
    const names = {};
    for (const p of ["wafs340", "wafs390", "cbtop", "conv", "gfs1", "gfs2", "ifs1", "ifs2", "aifs1", "aifs2"]) names[p] = nearestFile(m, p, t);
    const A = {};
    await Promise.all(Object.entries(names).map(async ([p, n]) => { try { A[p] = n ? await grid(n) : null; } catch { A[p] = null; } }));
    if (!A.wafs340 && !A.gfs1) continue;
    const edr = new Uint8Array(ni * nj), cb = new Uint8Array(ni * nj);
    for (let i = i0; i <= i1; i++) for (let k = 0; k < nj; k++) {
      const idx = i * G.nlon + ((j0 + k) % G.nlon), o = (i - i0) * nj + k;
      const v = (p) => { const a = A[p]; if (!a) return null; const x = a[idx]; return x ? x * sE : null; };
      const mem = { wafs: wafsAt(v("wafs340"), v("wafs390"), fl), gfs: modelAt(v("gfs1"), v("gfs2"), fl), ifs: modelAt(v("ifs1"), v("ifs2"), fl), aifs: modelAt(v("aifs1"), v("aifs2"), fl) };
      let s = 0, ws = 0;
      for (const [kk, x] of Object.entries(mem)) if (x != null) { s += W[kk] * x; ws += W[kk]; }
      const cbk = A.cbtop ? A.cbtop[idx] * sC : null;
      const val = Math.max(ws ? s / ws : 0, v("conv") || 0, cbFloor(cbk));
      edr[o] = clamp(Math.round(val / sE), 0, 255);
      cb[o] = A.cbtop ? A.cbtop[idx] : 0;
    }
    frames.push({ valid: vt, edr: Buffer.from(edr).toString("base64"), cb: Buffer.from(cb).toString("base64") });
  }
  if (!frames.length) return send(res, 404, { error: "no grids for that time" });
  send(res, 200, {
    sources: m.sources, updated: m.updated, fl,
    lat0: G.lat0 + i0 * G.dlat, lon0: lonA, dlat: G.dlat, dlon: G.dlon, nlat: ni, nlon: nj,
    edr_scale: sE, cb_scale: sC, frames,
  }, "public, s-maxage=900, stale-while-revalidate=3600");
}
