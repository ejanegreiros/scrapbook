const CACHE_NAME = "scrapbook-v1";
const STATIC_ASSETS = [
  "/",
  "/vendor/bootstrap/css/bootstrap.min.css",
  "/vendor/bootstrap/js/bootstrap.bundle.min.js",
  "/manifest.json"
];

// ✅ INSTALL
self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

// ✅ ACTIVATE (limpa caches antigos)
self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

// ✅ FETCH
self.addEventListener("fetch", event => {
  const url = new URL(event.request.url);

  // 🚫 NUNCA cache API / auth / upload
  if (
    url.pathname.startsWith("/login") ||
    url.pathname.startsWith("/logout") ||
    url.pathname.startsWith("/auth") ||
    url.pathname.startsWith("/images") ||
    url.pathname.startsWith("/upload")
  ) {
    return;
  }

  // ✅ Cache apenas GET
  if (event.request.method !== "GET") return;

  event.respondWith(
    caches.match(event.request).then(response => {
      return response || fetch(event.request);
    })
  );
});