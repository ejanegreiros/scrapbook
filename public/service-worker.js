// Service worker — Scrapbook World Cruise
// Estratégias:
//  • Navegação (HTML): rede primeiro, com fallback para o cache (abre offline).
//  • Estáticos próprios (/css, /js, /vendor, /icons): stale-while-revalidate (rápido e sempre atualiza).
//  • Fotos do R2 e outras origens: não são interceptadas.
//  • API, login e demais rotas: nunca passam pelo cache.
// Para forçar a atualização dos usuários após um deploy, incremente VERSION.
const VERSION = 'v4';
const STATIC_CACHE = `scrapbook-static-${VERSION}`;

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
  '/vendor/fontsource/fraunces/wght-italic.css',
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
      .then(keys => Promise.all(keys.filter(k => k !== STATIC_CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

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

  // Outras origens (fotos no R2, mapas): o navegador cuida sozinho, com o cache HTTP.
  // Não interceptar: um fetch() daqui é barrado pela CSP (connect-src 'self') e a imagem não carrega.
  if (url.origin !== self.location.origin) return;

  // Estáticos próprios
  if (STATIC_PREFIXES.some(p => url.pathname.startsWith(p)) || url.pathname === '/manifest.json') {
    event.respondWith(staleWhileRevalidate(request, STATIC_CACHE));
  }
  // Todo o resto (API, auth, upload, stats, comments, qr...) segue direto para a rede.
});
