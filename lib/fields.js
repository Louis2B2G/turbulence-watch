// Shared helpers for the gridded forecast fields (see pipeline/fields.py for how they are made).
export const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
export const HOUR = 3600e3;

// The newest file of `prod` whose valid time is within `maxMs` of t.
export function nearestFile(m, prod, t, maxMs = 3 * HOUR) {
  let best = null, bd = Infinity;
  for (const [k, name] of Object.entries(m.files[prod] || {})) {
    const d = Math.abs(Date.parse(k) - t);
    if (d < bd && d <= maxMs) { bd = d; best = name; }
  }
  return best;
}

// The two valid times around t and the interpolation weight between them.
export function bracket(m, t) {
  const ts = m.times.map((x) => Date.parse(x));
  let i1 = ts.findIndex((x) => x >= t);
  if (i1 < 0) i1 = ts.length - 1;
  const i0 = Math.max(0, ts[i1] > t ? i1 - 1 : i1);
  const w = ts[i1] === ts[i0] ? 0 : clamp((t - ts[i0]) / (ts[i1] - ts[i0]), 0, 1);
  return { ta: ts[i0], tb: ts[i1], w };
}

export const cellOf = (G, lat, lon) => [
  clamp(Math.round((G.lat0 - lat) / -G.dlat), 0, G.nlat - 1),
  ((Math.round((lon - G.lon0) / G.dlon) % G.nlon) + G.nlon) % G.nlon,
];

// Max over a (2 rad + 1)^2 neighbourhood: forecasts are not exact about where a patch sits.
export function maxAround(a, G, i, j, rad) {
  let mx = 0;
  for (let di = -rad; di <= rad; di++) for (let dj = -rad; dj <= rad; dj++) {
    const v = a[clamp(i + di, 0, G.nlat - 1) * G.nlon + ((j + dj + G.nlon) % G.nlon)];
    if (v > mx) mx = v;
  }
  return mx;
}

// Flight-level weighting between the two cruise layers: half interpolation, half the worse layer
// (aircraft change level, and the layers are only ~4000 ft thick).
export function byLevel(lo, hi, fl, flLo, flHi) {
  if (lo == null || hi == null) return lo ?? hi;
  const w = clamp((fl - flLo) / (flHi - flLo), 0, 1);
  return 0.5 * ((1 - w) * lo + w * hi) + 0.5 * Math.max(lo, hi);
}
export const wafsAt = (w340, w390, fl) => byLevel(w340, w390, fl, 340, 390);
export const modelAt = (l1, l2, fl) => byLevel(l1, l2, fl, 365, 405);

// Storm tops (kft) reaching cruise level imply convective turbulence around the cell.
export const cbFloor = (cbKft) => (cbKft != null && cbKft >= 34 ? Math.min(0.26, 0.16 + 0.006 * (cbKft - 34)) : 0);
