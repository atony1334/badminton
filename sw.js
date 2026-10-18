// 羽球輪轉排場 Service Worker
// 1. 讓安卓 Chrome 能把網頁「安裝」成 App（使用填滿的圖示）
// 2. 接收「輪到你上場」推播並顯示通知
// 不做任何快取，所有請求都直接走網路，所以更新版本、強制更新都不受影響。
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});

// 推播內容由雲端程式送出（只帶 data）：{ title, body, url, tag }
self.addEventListener('push', (event) => {
  let payload = {};
  try {
    const raw = event.data ? event.data.json() : {};
    payload = raw.data || (raw.notification ? Object.assign({}, raw.notification, raw.data) : raw);
  } catch (err) {
    payload = { body: event.data ? event.data.text() : '' };
  }
  const title = payload.title || '🏸 輪到你上場！';
  event.waitUntil(self.registration.showNotification(title, {
    body: payload.body || '',
    icon: 'icon-192.png',
    badge: 'icon-192.png',
    tag: payload.tag || 'oncourt',
    renotify: true,
    vibrate: [300, 150, 300],
    data: { url: payload.url || './' },
  }));
});

// 點通知：已經開著的頁面就切過去，沒開就打開觀看頁
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || './';
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    const target = new URL(url, self.location.href);
    const same = list.find((c) => new URL(c.url).search === target.search);
    if (same) return same.focus();
    return self.clients.openWindow(target.href);
  }));
});
