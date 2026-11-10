/* NuTracker service worker.
 * La app abre al instante desde la caché (aunque el servidor esté dormido o no
 * haya red) y se actualiza en segundo plano; si llegó una versión nueva de la
 * página, avisa a las pestañas abiertas. Los datos tienen su propia caché en
 * localStorage y /api siempre va a la red. */
const CACHE = "nutracker-v4";
const SHELL = ["/", "/garmin.html", "/manifest.webmanifest", "/icon.svg"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function notifyUpdate() {
  self.clients.matchAll({ type: "window" }).then(list => list.forEach(c => c.postMessage({ type: "nt-update" })));
}

self.addEventListener("fetch", e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== "GET" || url.pathname.startsWith("/api/")) return;
  const same = url.origin === self.location.origin;
  // misma página con distinto ?query (p. ej. /?home=1) comparte una sola entrada
  const key = same ? url.pathname : req;

  e.respondWith(caches.open(CACHE).then(async cache => {
    const cached = await cache.match(key);
    const fresh = fetch(req).then(resp => {
      if (resp.ok || resp.type === "opaque") {
        const before = cached && cached.headers.get("etag"), after = resp.headers.get("etag");
        const done = cache.put(key, resp.clone());
        if (same && before && after && before !== after && req.mode === "navigate") done.then(notifyUpdate);
      }
      return resp;
    });
    if (!cached) return fresh;          // primera vez: esperar a la red
    e.waitUntil(fresh.catch(() => {})); // ya hay copia: responder ya y refrescar por detrás
    return cached;
  }));
});
