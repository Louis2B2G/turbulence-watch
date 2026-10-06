// GET ?bbox=lon0,lat0,lon1,lat1 -> SIGMETs in force (turbulence, thunderstorms, mountain waves, cyclones, ash) and
// recent pilot turbulence reports in the box, from aviationweather.gov.
import { send } from "../lib/http.js";
import { sigmets, pireps } from "../lib/wx.js";

export default async function handler(req, res) {
  const [lo0, la0, lo1, la1] = String(req.query.bbox || "-180,-90,180,90").split(",").map(Number);
  const box = [lo0, la0, lo1, la1].every(Number.isFinite) ? [lo0, la0, lo1, la1] : [-180, -90, 180, 90];
  const [sig, pir] = await Promise.all([sigmets().catch(() => null), pireps(box[1], box[0], box[3], box[2], 2).catch(() => [])]);
  if (!sig) return send(res, 502, { error: "aviationweather.gov unavailable" }, "public, s-maxage=60");
  const inBox = (s) => s.box[0] <= box[3] && s.box[2] >= box[1] && (box[2] - box[0] >= 360 || (s.box[1] <= box[2] && s.box[3] >= box[0]));
  send(res, 200, {
    at: new Date().toISOString(),
    sigmets: sig.filter((s) => s.to > Date.now() && inBox(s)).map(({ box: _b, ...s }) => s),
    pireps: pir.slice(0, 400),
  }, "public, s-maxage=300, stale-while-revalidate=600");
}
