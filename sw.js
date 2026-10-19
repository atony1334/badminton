// 羽球輪轉排場 Service Worker
// 1. 讓安卓 Chrome 能把網頁「安裝」成 App（使用填滿的圖示）
// 2. 接收「輪到你上場」推播並顯示通知
// 不做任何快取，所有請求都直接走網路，所以更新版本、強制更新都不受影響。
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});

// 推播內容由雲端程式送出（只帶 data）：{ title, body, url, tag, expiresAt }
self.addEventListener('push', (event) => {
  let payload = {};
  try {
    const raw = event.data ? event.data.json() : {};
    payload = raw.data || (raw.notification ? Object.assign({}, raw.notification, raw.data) : raw);
  } catch (err) {
    payload = { body: event.data ? event.data.text() : '' };
  }
  const title = payload.title || '🏸 輪到你上場！';
  const expiresAt = Number(payload.expiresAt) || 0;
  event.waitUntil(clearExpired().then(() => self.registration.showNotification(title, {
    body: payload.body || '',
    icon: 'icon-192.png',
    badge: 'icon-192.png',
    tag: payload.tag || 'oncourt',
    renotify: true,
    vibrate: [300, 150, 300],
    timestamp: Date.now(),
    data: { url: payload.url || './', expiresAt },
  })));
});

// 通知有時效：過期的（例如那一場早就打完了）在收到新通知時順手清掉
function clearExpired() {
  const now = Date.now();
  return self.registration.getNotifications().then((list) => {
    list.forEach((n) => {
      const exp = n.data && n.data.expiresAt;
      if (exp && exp < now) n.close();
    });
  }).catch(() => {});
}

// 網頁打開時會請 Service Worker 清掉過期或已經看過的通知
self.addEventListener('message', (event) => {
  const msg = event.data || {};
  if (msg.type !== 'clear-notifications') return;
  event.waitUntil(self.registration.getNotifications().then((list) => {
    const now = Date.now();
    list.forEach((n) => {
      const exp = n.data && n.data.expiresAt;
      const tagHit = msg.tagPrefix && String(n.tag || '').startsWith(msg.tagPrefix);
      if (tagHit || (exp && exp < now)) n.close();
    });
  }).catch(() => {}));
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
