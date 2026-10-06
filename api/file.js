// GET ?path=manifest.json | sigwx_YYYYMMDDHH_TURB_hash.json  ->  passthrough from the data branch (works for private forks too)
import { getFile } from "../lib/data.js";
import { send } from "../lib/http.js";

export default async function handler(req, res) {
  const path = String(req.query.path || "");
  if (!/^(manifest\.json|sigwx_\d{10}_(TURB|CB)(_[0-9a-f]{8})?\.json)$/.test(path)) return send(res, 400, { error: "bad path" });
  try {
    const b = await getFile(path, path === "manifest.json" ? 120_000 : 3600_000);
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", path === "manifest.json" ? "public, s-maxage=120" : "public, s-maxage=3600");
    res.status(200).send(b);
  } catch (e) {
    send(res, e.status === 404 ? 404 : 502, { error: String(e.message || e) }, "public, s-maxage=60");
  }
}
