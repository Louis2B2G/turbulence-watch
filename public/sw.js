// Offline shell: the app keeps working on flaky in-flight Wi-Fi. Network first for our own files (so new deploys show
// up immediately), cache as fallback. Live data under /api is never cached here.
const C = "tw-v1";
const SHELL = ["/", "/app.js", "/app.css", "/airports.json", "/icon.svg", "/manifest.webmanifest"];
self.addEventListener("install", (e) => { e.waitUntil(caches.open(C).then((c) => c.addAll(SHELL)).catch(() => {})); self.skipWaiting(); });
self.addEventListener("activate", (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== C).map((k) => caches.delete(k))))); self.clients.claim(); });
self.addEventListener("fetch", (e) => {
  const r = e.request, u = new URL(r.url);
  if (r.method !== "GET") return;
  if (u.origin === location.origin && !u.pathname.startsWith("/api/")) {
    e.respondWith(fetch(r).then((res) => { if (res.ok) { const cp = res.clone(); caches.open(C).then((c) => c.put(r, cp)); } return res; })
      .catch(() => caches.match(r, { ignoreSearch: true }).then((m) => m || caches.match("/"))));
  } else if (u.hostname === "cdnjs.cloudflare.com") {
    e.respondWith(caches.match(r).then((m) => m || fetch(r).then((res) => { const cp = res.clone(); caches.open(C).then((c) => c.put(r, cp)); return res; })));
  }
});
