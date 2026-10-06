// Reads the forecast fields published by the GitHub Action to the `data` branch.
// Public repo: raw.githubusercontent.com (CDN). Private repo: set DATA_TOKEN (a GitHub token with read access). Local dev: set DATA_DIR.
import { gunzipSync } from "node:zlib";

// Defaults to the repo Vercel deployed from (forks work with no config), else DATA_REPO, else upstream.
const REPO = process.env.DATA_REPO
  || (process.env.VERCEL_GIT_REPO_OWNER && process.env.VERCEL_GIT_REPO_SLUG
    ? `${process.env.VERCEL_GIT_REPO_OWNER}/${process.env.VERCEL_GIT_REPO_SLUG}`
    : "Louis2B2G/turbulence-watch");
const BRANCH = process.env.DATA_BRANCH || "data";
const TOKEN = process.env.DATA_TOKEN || "";
const LOCAL = process.env.DATA_DIR || "";
const mem = new Map();

async function fetchFile(path) {
  if (LOCAL) {
    const fs = await import("node:fs/promises");
    return fs.readFile(`${LOCAL}/${path}`);
  }
  const raw = `https://raw.githubusercontent.com/${REPO}/${BRANCH}/${path}`;
  let r = null;
  if (TOKEN) {
    r = await fetch(`https://api.github.com/repos/${REPO}/contents/${path}?ref=${BRANCH}`,
      { headers: { "User-Agent": "turbulence-watch", Authorization: `Bearer ${TOKEN}`, Accept: "application/vnd.github.raw" } });
    if (r.status === 401 || r.status === 403) r = null;   // bad token: the repo may still be public
  }
  if (!r) r = await fetch(raw, { headers: { "User-Agent": "turbulence-watch" } });
  if (!r.ok) throw Object.assign(new Error(`${path}: HTTP ${r.status}`), { status: r.status });
  return Buffer.from(await r.arrayBuffer());
}

export async function getFile(path, ttlMs = 300_000) {
  const hit = mem.get(path);
  if (hit && Date.now() - hit.t < ttlMs) return hit.v;
  const v = await fetchFile(path);
  mem.set(path, { t: Date.now(), v });
  return v;
}

export async function manifest() {
  return JSON.parse((await getFile("manifest.json", 120_000)).toString("utf8"));
}

const grids = new Map();
export async function grid(name) {
  if (grids.has(name)) return grids.get(name);
  const p = getFile(name, 12 * 3600_000).then((b) => new Uint8Array(gunzipSync(b)));
  grids.set(name, p);
  p.catch(() => grids.delete(name));
  if (grids.size > 160) grids.delete(grids.keys().next().value);
  return p;
}

export const repoInfo = () => ({ repo: REPO, branch: BRANCH });
