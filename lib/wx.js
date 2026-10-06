// Official warnings and pilot reports from aviationweather.gov (NOAA AWC), cached in memory.
import { getJSON } from "./http.js";

const memo = new Map();
async function cached(key, ttlMs, fn) {
  const hit = memo.get(key);
  if (hit && Date.now() - hit.t < ttlMs) return hit.v;
  const v = await fn();
  if (v != null) memo.set(key, { t: Date.now(), v });
  if (memo.size > 200) memo.delete(memo.keys().next().value);
  return v ?? hit?.v ?? null;
}

const HAZ = { TURB: "TURB", TS: "TS", CB: "CB", MTW: "MTW", TC: "TC", VA: "VA", CONVECTIVE: "TS" };

// International SIGMETs (all FIRs outside the US) + US convective/turbulence SIGMETs. Only hazards that reach cruise levels.
export async function sigmets() {
  return cached("sigmets", 300_000, async () => {
    const [intl, us] = await Promise.all([
      getJSON("https://aviationweather.gov/api/data/isigmet?format=json", {}, 12000),
      getJSON("https://aviationweather.gov/api/data/airsigmet?format=json", {}, 12000),
    ]);
    if (!intl && !us) return null;
    const out = [];
    for (const s of intl || []) {
      const hz = HAZ[String(s.hazard || "").toUpperCase()];
      if (!hz || (s.coords || []).length < 3 || (s.top ?? 60000) < 20000) continue;
      out.push({ fir: s.firName || s.firId || "", hazard: hz, qualifier: String(s.qualifier || "").trim(), base: s.base ?? 0, top: s.top ?? 60000,
        from: s.validTimeFrom * 1000, to: s.validTimeTo * 1000, coords: s.coords.map((c) => [c.lat, c.lon]),
        raw: String(s.rawSigmet || "").replace(/\s+/g, " ").slice(0, 400) });
    }
    for (const s of us || []) {
      if (s.airSigmetType !== "SIGMET") continue;
      const hz = HAZ[String(s.hazard || "").toUpperCase()];
      if (!hz || (s.coords || []).length < 3) continue;
      const top = s.altitudeHi1 ?? s.altitudeHi2 ?? 60000;
      if (top < 20000) continue;
      out.push({ fir: "US " + (s.icaoId || ""), hazard: hz, qualifier: hz === "TS" ? "CONVECTIVE" : (s.severity >= 4 ? "SEV" : ""), base: s.altitudeLow1 ?? 0, top,
        from: s.validTimeFrom * 1000, to: s.validTimeTo * 1000, coords: s.coords.map((c) => [c.lat, c.lon]),
        raw: String(s.rawAirSigmet || "").replace(/\s+/g, " ").slice(0, 400) });
    }
    out.forEach((s, i) => { s.id = i; s.box = bbox(s.coords); });
    return out;
  });
}

const PIREP_TB = { NEG: 0, SMTH: 0, "SMTH-LGT": 1, LGT: 1, "LGT-MOD": 2, MOD: 3, "MOD-SEV": 4, SEV: 5, "SEV-EXTM": 6, EXTM: 6 };
// Pilot reports with a turbulence remark in a lat/lon box over the last `ageH` hours.
export async function pireps(la0, lo0, la1, lo1, ageH = 3) {
  const boxes = [];
  if (lo1 - lo0 >= 360) boxes.push([la0, -180, la1, 180]);
  else if (lo1 > 180) boxes.push([la0, lo0, la1, 180], [la0, -180, la1, lo1 - 360]);
  else if (lo0 < -180) boxes.push([la0, lo0 + 360, la1, 180], [la0, -180, la1, lo1]);
  else boxes.push([la0, lo0, la1, lo1]);
  const r = (x) => Math.round(x);
  const lists = await Promise.all(boxes.map((b) => {
    const q = b.map(r).join(",");
    return cached("pirep:" + q + ":" + ageH, 300_000, () => getJSON(`https://aviationweather.gov/api/data/pirep?format=json&age=${ageH}&bbox=${q}`, {}, 12000));
  }));
  const out = [];
  for (const l of lists) for (const p of l || []) {
    const ti = String(p.tbInt1 || "").toUpperCase().trim();
    if (!(ti in PIREP_TB) || p.lat == null) continue;
    out.push({ lat: p.lat, lon: p.lon, fl: p.fltLvl ?? null, t: p.obsTime * 1000, ac: p.acType || "", tb: ti, lvl: PIREP_TB[ti],
      top: p.tbTop1 ?? null, base: p.tbBas1 ?? null, raw: String(p.rawOb || "").slice(0, 160) });
  }
  return out;
}

export function bbox(coords) {
  let a = 90, b = 180, c = -90, d = -180;
  for (const [la, lo] of coords) { a = Math.min(a, la); c = Math.max(c, la); b = Math.min(b, lo); d = Math.max(d, lo); }
  return [a, b, c, d];
}

const wrap = (x) => ((x + 540) % 360) - 180;
// Point in polygon (ring of [lat, lon]); longitudes are unwrapped around the test point so date-line polygons work.
export function inPoly(lat, lon, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const yi = ring[i][0], xi = lon + wrap(ring[i][1] - lon), yj = ring[j][0], xj = lon + wrap(ring[j][1] - lon);
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function km(a, b, c, d) {
  const R = 6371, p = Math.PI / 180, x = Math.sin(((c - a) * p) / 2), y = Math.sin(((d - b) * p) / 2);
  return 2 * R * Math.asin(Math.sqrt(x * x + Math.cos(a * p) * Math.cos(c * p) * y * y));
}

// Rough distance (km) from a point to a polygon's edge, via its vertices and edge midpoints.
export function nearPoly(lat, lon, ring, maxKm) {
  for (let i = 0; i < ring.length; i++) {
    const [a, b] = ring[i], [c, d] = ring[(i + 1) % ring.length];
    if (km(lat, lon, a, b) < maxKm || km(lat, lon, (a + c) / 2, b + wrap(d - b) / 2) < maxKm) return true;
  }
  return false;
}
