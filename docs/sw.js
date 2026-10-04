/* Gift Monitor PWA — офлайн-кэш оболочки, данные всегда из сети */
var CACHE = 'atelier4-anim';
var SHELL = ['./', './index.html', './logo.png', './icon-192.png', './icon-512.png', './icon.svg', './manifest.webmanifest'];
self.addEventListener('install', function(e){
  e.waitUntil(caches.open(CACHE).then(function(c){ return c.addAll(SHELL); }).then(function(){ return self.skipWaiting(); }));
});
self.addEventListener('activate', function(e){
  e.waitUntil(caches.keys().then(function(keys){
    return Promise.all(keys.filter(function(k){ return k !== CACHE; }).map(function(k){ return caches.delete(k); }));
  }).then(function(){ return self.clients.claim(); }));
});
self.addEventListener('fetch', function(e){
  var url = e.request.url;
  var isData = url.indexOf('status.json') >= 0 || url.indexOf('gifts.json') >= 0 ||
               url.indexOf('images.json') >= 0 || url.indexOf('history.json') >= 0 ||
               url.indexOf('floors.json') >= 0 || url.indexOf('floors-hist.json') >= 0 ||
               url.indexOf('live.json') >= 0 || url.indexOf('version.json') >= 0;
  if (isData){
    /* данные: сеть первая, кэш — фолбэк для офлайна */
    e.respondWith(fetch(e.request).then(function(r){
      var cp = r.clone();
      caches.open(CACHE).then(function(c){
        c.put(new Request(e.request.url.split('?')[0]), cp.clone());
      });
      return r;
    }).catch(function(){ return caches.match(e.request.url.split('?')[0], { ignoreSearch: true }); }));
    return;
  }
  if (e.request.method !== 'GET') return;
  /* HTML-навигация: СЕТЬ ПЕРВАЯ — юзер всегда видит свежий дизайн, кэш только для офлайна */
  if (e.request.mode === 'navigate' || url.indexOf('index.html') >= 0){
    e.respondWith(fetch(e.request).then(function(r){
      var cp = r.clone();
      caches.open(CACHE).then(function(c){ c.put(new Request('./index.html'), cp); });
      return r;
    }).catch(function(){ return caches.match('./index.html'); }));
    return;
  }
  /* остальная оболочка (лого/иконки/манифест): кэш первый */
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then(function(m){
    return m || fetch(e.request).then(function(r){
      var cp = r.clone(); caches.open(CACHE).then(function(c){ c.put(e.request, cp); });
      return r;
    });
  }));
});
