// Local server that mimics Vercel: static files from public/, functions from api/*.js.
//   npm run dev                      -> reads forecast fields from the repo's `data` branch on GitHub
//   DATA_DIR=./out npm run dev       -> reads a local build (python -m pipeline.fields)
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUB = path.join(ROOT, "public");
const PORT = +process.env.PORT || 3000;
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".webmanifest": "application/manifest+json", ".ico": "image/x-icon" };

http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://localhost");
  if (u.pathname.startsWith("/api/")) {
    const name = u.pathname.slice(5).replace(/\.js$/, "");
    if (!/^[a-z0-9_-]+$/i.test(name)) { res.writeHead(404); return res.end(); }
    let mod;
    try { mod = await import(pathToFileURL(path.join(ROOT, "api", name + ".js")).href); } catch { res.writeHead(404); return res.end("no such function"); }
    let body = "";
    for await (const c of req) body += c;
    req.query = Object.fromEntries(u.searchParams);
    try { req.body = body && /json/.test(req.headers["content-type"] || "") ? JSON.parse(body) : body || undefined; } catch { req.body = body; }
    res.status = (c) => { res.statusCode = c; return res; };
    res.send = (b) => res.end(typeof b === "string" || Buffer.isBuffer(b) ? b : JSON.stringify(b));
    res.json = (o) => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(o)); };
    const t = Date.now();
    try { await mod.default(req, res); } catch (e) { console.error(e); if (!res.headersSent) { res.statusCode = 500; res.end(String(e)); } }
    console.log(`${req.method} ${u.pathname}${u.search} -> ${res.statusCode} ${Date.now() - t} ms`);
    return;
  }
  let p = path.normalize(path.join(PUB, decodeURIComponent(u.pathname)));
  if (!p.startsWith(PUB)) { res.writeHead(403); return res.end(); }
  if (u.pathname === "/" || !path.extname(p)) p = path.join(PUB, "index.html");
  try {
    const b = await fs.readFile(p);
    res.writeHead(200, { "Content-Type": TYPES[path.extname(p)] || "application/octet-stream", "Cache-Control": "no-store" });
    res.end(b);
  } catch { res.writeHead(404); res.end("not found"); }
}).listen(PORT, () => console.log(`Turbulence Watch on http://localhost:${PORT}${process.env.DATA_DIR ? ` (data: ${process.env.DATA_DIR})` : ""}`));
