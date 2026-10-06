// GET ?q=AF556  ->  route candidates (adsbdb, adsb.lol route database) + live ADS-B position (adsb.lol, adsb.fi, OpenSky fallback).
// Route databases are keyed by flight number and are sometimes stale or reversed, so the app checks them against the position
// and lets the passenger override them.
import { send, getJSON } from "../lib/http.js";

const KT = 1.852, FT = 3.28084;
const apDb = (a) => a && a.latitude != null && ({ iata: a.iata_code || null, icao: a.icao_code || null, name: a.name, city: a.municipality, country: a.country_iso_name, lat: a.latitude, lon: a.longitude });
const apLol = (a) => a && a.lat != null && ({ iata: a.iata || null, icao: a.icao || null, name: a.name, city: a.location, country: a.countryiso2, lat: a.lat, lon: a.lon });

function fromReadsb(js, src) {
  const now = (js?.now || Date.now()) / 1000;
  return (js?.ac || []).filter((a) => a.lat != null).map((a) => ({
    src, hex: a.hex, lat: a.lat, lon: a.lon, callsign: (a.flight || "").trim(),
    alt_ft: typeof a.alt_baro === "number" ? a.alt_baro : (typeof a.alt_geom === "number" ? a.alt_geom : (a.alt_baro === "ground" ? 0 : null)),
    gs_kmh: a.gs != null ? Math.round(a.gs * KT) : null, track: a.track ?? a.true_heading ?? null,
    vrate: a.baro_rate ?? a.geom_rate ?? null,
    t: new Date((now - (a.seen_pos ?? a.seen ?? 0)) * 1000).toISOString(), reg: a.r || null, type: a.t || null,
  }));
}

export default async function handler(req, res) {
  const q = String(req.query.q || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 10);
  if (!q) return send(res, 400, { error: "pass ?q=FLIGHT, e.g. AF556 or AFR556" });
  const m = q.match(/^([A-Z0-9]{2})(\d{1,4}[A-Z]?)$/);   // IATA style (AF556) vs ICAO callsign (AFR556)
  const [dbr, alr] = await Promise.all([
    getJSON(`https://api.adsbdb.com/v0/callsign/${q}`, {}, 7000),
    m ? getJSON(`https://api.adsbdb.com/v0/airline/${m[1]}`, {}, 7000) : null,
  ]);
  const db = dbr?.response?.flightroute || null;
  let callsign = db?.callsign_icao || null, airline = db?.airline || null;
  if (!callsign && m) { // flight number unknown to the route database: turn it into the ICAO callsign aircraft broadcast
    const a = Array.isArray(alr?.response) ? alr.response.find((x) => x.icao) : null;
    if (a) { callsign = a.icao + m[2].replace(/^0+/, ""); airline = a; }
  }
  callsign = callsign || q;
  // OpenSky (anonymous, rate limited) searches a box around the database route; asked in parallel, used only as a fallback
  const o0 = db?.origin, d0 = db?.destination;
  const box = o0 && d0 ? { lamin: Math.min(o0.latitude, d0.latitude) - 8, lamax: Math.max(o0.latitude, d0.latitude) + 8, lomin: Math.min(o0.longitude, d0.longitude) - 10, lomax: Math.max(o0.longitude, d0.longitude) + 10 } : null;
  const [lol, fi, lolRoute, osky] = await Promise.all([
    getJSON(`https://api.adsb.lol/v2/callsign/${callsign}`, {}, 7000),
    getJSON(`https://opendata.adsb.fi/api/v2/callsign/${callsign}`, {}, 7000),
    getJSON(`https://api.adsb.lol/api/0/route/${callsign}`, {}, 3500),   // second opinion on the route; slow, so short timeout
    box && box.lomax - box.lomin < 180 ? getJSON(`https://opensky-network.org/api/states/all?${new URLSearchParams(box)}`, {}, 6000) : null,
  ]);
  const routes = [];
  if (db?.origin && db?.destination) routes.push({ src: "adsbdb", origin: apDb(db.origin), destination: apDb(db.destination) });
  const la = lolRoute?._airports;
  if (Array.isArray(la) && la.length >= 2) {
    const o = apLol(la[0]), d = apLol(la[la.length - 1]);
    if (o && d && !routes.some((r) => r.origin.icao === o.icao && r.destination.icao === d.icao)) routes.push({ src: "adsb.lol", origin: o, destination: d });
  }
  const fixes = [...fromReadsb(lol, "adsb.lol"), ...fromReadsb(fi, "adsb.fi")];
  if (!fixes.length) {
    for (const st of osky?.states || []) {
      if ((st[1] || "").trim() === callsign && st[6] != null) fixes.push({ src: "OpenSky", hex: st[0], lat: st[6], lon: st[5], callsign, alt_ft: st[7] != null ? Math.round(st[7] * FT) : (st[8] ? 0 : null),
        gs_kmh: st[9] != null ? Math.round(st[9] * 3.6) : null, track: st[10], vrate: st[11] != null ? Math.round(st[11] * 196.85) : null, t: new Date((st[3] || st[4]) * 1000).toISOString() });
    }
  }
  fixes.sort((a, b) => Date.parse(b.t) - Date.parse(a.t));
  const pos = fixes[0] || null;
  send(res, 200, {
    query: q, callsign, flight: db?.callsign_iata || (m ? q : null),
    airline: airline ? { name: airline.name, iata: airline.iata, icao: airline.icao } : null,
    routes,
    position: pos,
    aircraft: pos ? { hex: pos.hex, reg: fixes.find((f) => f.reg)?.reg || null, type: fixes.find((f) => f.type)?.type || null } : null,
    sources_checked: ["adsb.lol", "adsb.fi", ...(fixes.length && fixes[0].src !== "OpenSky" ? [] : ["OpenSky"])],
    at: new Date().toISOString(),
  }, "public, s-maxage=20, stale-while-revalidate=40");
}
