export function send(res, status, body, cache = "no-store") {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", cache);
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.status(status).send(JSON.stringify(body));
}
export async function getJSON(url, opts = {}, timeoutMs = 12000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { ...opts, signal: ctl.signal, headers: { "User-Agent": "turbulence-watch", ...(opts.headers || {}) } });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; } finally { clearTimeout(t); }
}
