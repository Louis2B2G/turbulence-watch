// POST {points: [[lat, lon, time, flightLevel], ...]}  ->  every forecast member at each point and time,
// plus the official warnings (SIGMET), significant-weather areas (WAFS SIGWX) and pilot reports along the way.
import { manifest, grid, getFile } from "../lib/data.js";
import { send } from "../lib/http.js";
import { sigmets, pireps, inPoly, nearPoly, km } from "../lib/wx.js";
import { clamp, nearestFile, bracket, cellOf, maxAround, wafsAt, modelAt } from "../lib/fields.js";

const PRODUCTS = ["wafs340", "wafs390", "cbtop", "gfs1", "gfs2", "ifs1", "ifs2", "aifs1", "aifs2", "conv"];
const r3 = (x) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 1000) / 1000);
const parsed = new Map();

async function sigwx(name) {
  if (!name) return null;
  if (!parsed.has(name)) {
    parsed.set(name, getFile(name, 6 * 3600e3).then((b) => (JSON.parse(b.toString("utf8")).features || []).map((f) => {
      const g = f.geometry || {}, p = f.properties || {};
      const ring = g.type === "Polygon" ? g.coordinates[0] : g.type === "LineString" ? g.coordinates : null;
      return ring && ring.length >= 3 ? { p, ring: ring.map(([lo, la]) => [la, lo]) } : null;
    }).filter(Boolean)).catch(() => []));
    if (parsed.size > 60) parsed.delete(parsed.keys().next().value);
  }
  return parsed.get(name);
}
const fl3 = (s, dflt) => (/^\d+$/.test(String(s)) ? +s : dflt);

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return send(res, 204, {});
  if (req.method !== "POST") return send(res, 405, { error: "POST {points:[[lat,lon,time,fl],...]}" });
  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  const raw = Array.isArray(body?.points) ? body.points.slice(0, 600) : [];
  const pts = raw.map(([lat, lon, t, fl]) => ({ lat: +lat, lon: ((+lon + 540) % 360) - 180, t: typeof t === "number" ? t : Date.parse(t), fl: +fl || 370 }))
    .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon) && Number.isFinite(p.t));
  if (!pts.length) return send(res, 400, { error: "no points" });
  let m;
  try { m = await manifest(); } catch (e) { return send(res, 503, { error: "forecast fields not published yet", detail: String(e.message || e) }); }
  const G = m.grid, e = m.scale.edr;

  // forecast grids needed (two bracketing valid times per point)
  const plan = pts.map((p) => {
    const { ta, tb, w } = bracket(m, p.t);
    const files = {};
    for (const prod of PRODUCTS) files[prod] = [nearestFile(m, prod, ta), nearestFile(m, prod, tb)];
    return { ...p, w, files, cell: cellOf(G, p.lat, p.lon) };
  });
  const need = new Set(plan.flatMap((p) => Object.values(p.files).flat()).filter(Boolean));
  const loaded = new Map();
  const sigP = sigmets().catch(() => null);
  let la0 = 90, la1 = -90, lo0 = 999, lo1 = -999;
  for (const p of pts) { la0 = Math.min(la0, p.lat); la1 = Math.max(la1, p.lat); }
  { // longitude extent, unwrapped along the path so date-line routes give a narrow box
    let prev = pts[0].lon, acc = prev;
    for (const p of pts) { acc += ((p.lon - prev + 540) % 360) - 180; prev = p.lon; lo0 = Math.min(lo0, acc); lo1 = Math.max(lo1, acc); }
  }
  const pirP = pireps(Math.max(-90, la0 - 2), lo0 - 2, Math.min(90, la1 + 2), lo1 + 2, 3).catch(() => []);
  await Promise.all([...need].map(async (n) => { try { loaded.set(n, await grid(n)); } catch { /* missing grid */ } }));

  const tval = (p, prod, rad, sc, zeroIsMissing = true) => {
    const [n0, n1] = p.files[prod];
    const get = (n) => { const a = n && loaded.get(n); if (!a) return null; const v = maxAround(a, G, p.cell[0], p.cell[1], rad) * sc; return zeroIsMissing && v === 0 ? null : v; };
    const a = get(n0), b = get(n1);
    if (a == null) return b; if (b == null) return a;
    return a * (1 - p.w) + b * p.w;
  };

  // significant-weather chart areas, nearest chart time
  const swTimes = Object.keys(m.files.sigwx_TURB || {}).map((k) => [Date.parse(k), m.files.sigwx_TURB[k], (m.files.sigwx_CB || {})[k]]);
  const swFor = (t) => { let b = null; for (const x of swTimes) if (!b || Math.abs(x[0] - t) < Math.abs(b[0] - t)) b = x; return b && Math.abs(b[0] - t) <= 3 * 3600e3 ? b : null; };
  const swNames = new Set(); for (const p of pts) { const s = swFor(p.t); if (s) { swNames.add(s[1]); swNames.add(s[2]); } }
  const swData = new Map(await Promise.all([...swNames].filter(Boolean).map(async (n) => [n, await sigwx(n)])));

  const sig = (await sigP) || [];
  const used = new Set();
  const out = plan.map((p) => {
    const mdl = (name) => modelAt(tval(p, name + "1", 1, e), tval(p, name + "2", 1, e), p.fl);
    const o = {
      wafs: r3(wafsAt(tval(p, "wafs340", 1, e), tval(p, "wafs390", 1, e), p.fl)),
      ifs: r3(mdl("ifs")), gfs: r3(mdl("gfs")), aifs: r3(mdl("aifs")),
      conv: r3(tval(p, "conv", 0, e)), cb: r3(tval(p, "cbtop", 1, m.scale.cbtop_kft, false)),
    };
    // SIGMETs in force when the plane gets there (1 h early / 30 min late margin) at its level, inside or within 40 km
    const hits = [];
    for (const s of sig) {
      if (p.t < s.from - 3600e3 || p.t > s.to + 1800e3) continue;
      if (p.fl * 100 < s.base - 2000 || p.fl * 100 > s.top + 2000) continue;
      const [a, b, c, d] = s.box;
      if (p.lat < a - 1 || p.lat > c + 1) continue;
      if (d - b < 180 && (p.lon < b - 1.5 || p.lon > d + 1.5)) continue;
      if (inPoly(p.lat, p.lon, s.coords) || nearPoly(p.lat, p.lon, s.coords, 40)) { hits.push(s.id); used.add(s.id); }
    }
    if (hits.length) o.w = hits;
    const sw = swFor(p.t);
    if (sw) {
      for (const a of swData.get(sw[1]) || []) {
        const b = fl3(a.p.base, 100), tp = fl3(a.p.top, 600);
        if (p.fl >= b - 10 && p.fl <= tp + 10 && inPoly(p.lat, p.lon, a.ring)) {
          const sev = a.p.severity === "severe" ? 2 : 1;
          if (!o.sw || sev > o.sw[0]) o.sw = [sev, b, tp];
        }
      }
      for (const a of swData.get(sw[2]) || []) {
        const tp = fl3(a.p.top, 450);
        if (tp >= p.fl - 30 && inPoly(p.lat, p.lon, a.ring)) {
          const ext = String(a.p.extent || "ISOL").toUpperCase();
          const rank = (x) => (x.includes("FREQ") ? 3 : x.includes("OCNL") ? 2 : 1);
          if (!o.cbx || rank(ext) > rank(o.cbx[0])) o.cbx = [ext, tp];
        }
      }
    }
    return o;
  });

  // warnings worth drawing: the ones the path hits, plus any whose box overlaps the route box
  const near = sig.filter((s) => used.has(s.id) || (s.to > Date.now() && s.box[0] < la1 + 3 && s.box[2] > la0 - 3 &&
    (s.box[3] - s.box[1] > 180 || lo1 - lo0 > 300 || (s.box[3] > lo0 - 4 && s.box[1] < lo1 + 4) || (s.box[3] + 360 > lo0 - 4 && s.box[1] + 360 < lo1 + 4))));
  const pr = (await pirP).filter((r) => pts.some((p) => Math.abs(p.lat - r.lat) < 2 && km(p.lat, p.lon, r.lat, r.lon) < 150));

  send(res, 200, {
    updated: m.updated, sources: m.sources, weights: m.weights,
    range: [m.times[0], m.times[m.times.length - 1]],
    points: out,
    sigmets: near.slice(0, 60).map(({ box, ...s }) => s),
    pireps: pr.slice(0, 200),
  });
}
