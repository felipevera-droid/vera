/* Service Worker — Portal de Estudios Vera (PWA)
   Estrategia:
   - App shell (index.html, manifest, iconos, fuentes): cache-first, se actualiza en segundo plano.
   - data.json (pruebas): network-first, con respaldo a la última copia en caché (offline).
   Sube CACHE_VERSION cuando cambie el shell para forzar actualización. */
const CACHE_VERSION = 'vera-v1';
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/maskable-512.png',
  './icons/apple-touch-icon.png',
  './icons/favicon-32.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE_VERSION);
    // No fallar la instalación si algún recurso opcional no está.
    await Promise.allSettled(SHELL.map((u) => c.add(u)));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

function isDataJson(url) { return url.pathname.endsWith('/data.json'); }
function isFont(url) { return url.hostname.includes('fonts.googleapis.com') || url.hostname.includes('fonts.gstatic.com'); }

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  let url;
  try { url = new URL(req.url); } catch (_) { return; }

  // No interceptar llamadas a la IA ni a la API de GitHub (siempre en red).
  if (url.hostname.includes('googleapis.com') && url.pathname.includes('generateContent')) return;
  if (url.hostname === 'api.github.com' || url.hostname.includes('workers.dev') || url.hostname.includes('vercel.app')) return;
  if (url.hostname === 'api.anthropic.com') return;

  // data.json → network-first (pruebas frescas), respaldo caché.
  if (isDataJson(url)) {
    e.respondWith((async () => {
      const cache = await caches.open(CACHE_VERSION);
      try {
        const fresh = await fetch(req, { cache: 'no-store' });
        if (fresh && fresh.ok) { cache.put('./data.json', fresh.clone()); return fresh; }
        throw new Error('bad');
      } catch (_) {
        const cached = await cache.match('./data.json');
        return cached || new Response('{}', { headers: { 'Content-Type': 'application/json' } });
      }
    })());
    return;
  }

  // Fuentes de Google → cache-first (se guardan al primer uso).
  if (isFont(url)) {
    e.respondWith((async () => {
      const cache = await caches.open(CACHE_VERSION);
      const cached = await cache.match(req);
      if (cached) return cached;
      try { const res = await fetch(req); if (res && res.ok) cache.put(req, res.clone()); return res; }
      catch (_) { return cached || Response.error(); }
    })());
    return;
  }

  // Mismo origen (shell) → cache-first con refresco en segundo plano.
  if (url.origin === self.location.origin) {
    e.respondWith((async () => {
      const cache = await caches.open(CACHE_VERSION);
      const cached = await cache.match(req, { ignoreSearch: true });
      const network = fetch(req).then((res) => { if (res && res.ok) cache.put(req, res.clone()); return res; }).catch(() => null);
      return cached || (await network) || cache.match('./index.html');
    })());
  }
});
