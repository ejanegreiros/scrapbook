// Service worker — Scrapbook World Cruise
// Estratégias:
//  • Navegação (HTML): rede primeiro, com fallback para o cache (abre offline).
//  • Estáticos próprios (/css, /js, /vendor, /icons): stale-while-revalidate (rápido e sempre atualiza).
//  • Imagens do R2 (miniaturas/fotos): cache com limite de itens.
//  • API, login e demais rotas: nunca passam pelo cache.
// Para forçar a atualização dos usuários após um deploy, incremente VERSION.
const VERSION = 'v2';
const STATIC_CACHE = `scrapbook-static-${VERSION}`;
const IMAGE_CACHE = `scrapbook-images-${VERSION}`;
const MAX_IMAGES = 120;

const PRECACHE = [
  '/',
  '/css/styles.css',
  '/js/theme.js',
  '/js/i18n.js',
  '/js/app.js',
  '/vendor/bootstrap/css/bootstrap.min.css',
  '/vendor/bootstrap/js/bootstrap.bundle.min.js',
  '/vendor/bootstrap-icons/font/bootstrap-icons.min.css',
  '/vendor/fontsource/inter/index.css',
  '/vendor/fontsource/fraunces/index.css',
  '/manifest.json',
];
const STATIC_PREFIXES = ['/css/', '/js/', '/vendor/', '/icons/'];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(STATIC_CACHE)
      // um arquivo ausente não deve impedir a instalação
      .then(cache => Promise.all(PRECACHE.map(url => cache.add(url).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => ![STATIC_CACHE, IMAGE_CACHE].includes(k)).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

async function trimCache(cacheName, max) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  if (keys.length > max) await Promise.all(keys.slice(0, keys.length - max).map(k => cache.delete(k)));
}

function staleWhileRevalidate(request, cacheName) {
  return caches.open(cacheName).then(async cache => {
    const cached = await cache.match(request);
    const network = fetch(request).then(res => {
      if (res && res.ok) cache.put(request, res.clone());
      return res;
    }).catch(() => cached);
    return cached || network;
  });
}

self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  // Navegação
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then(res => {
          const copy = res.clone();
          caches.open(STATIC_CACHE).then(c => c.put('/', copy));
          return res;
        })
        .catch(() => caches.match('/'))
    );
    return;
  }

  // Imagens do R2 (outra origem)
  if (url.origin !== self.location.origin) {
    if (request.destination === 'image' && url.hostname.endsWith('.r2.dev')) {
      event.respondWith(
        caches.open(IMAGE_CACHE).then(async cache => {
          const cached = await cache.match(request);
          if (cached) return cached;
          const res = await fetch(request);
          if (res && (res.ok || res.type === 'opaque')) {
            cache.put(request, res.clone()).then(() => trimCache(IMAGE_CACHE, MAX_IMAGES));
          }
          return res;
        })
      );
    }
    return;
  }

  // Estáticos próprios
  if (STATIC_PREFIXES.some(p => url.pathname.startsWith(p)) || url.pathname === '/manifest.json') {
    event.respondWith(staleWhileRevalidate(request, STATIC_CACHE));
  }
  // Todo o resto (API, auth, upload, stats, comments, qr...) segue direto para a rede.
});
