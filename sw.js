// 最簡單的 Service Worker：讓安卓 Chrome 能把網頁「安裝」成 App（才會使用填滿的圖示）。
// 不做任何快取，所有請求都直接走網路，所以更新版本、強制更新都不受影響。
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});
