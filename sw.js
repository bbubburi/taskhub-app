/* 서비스 워커: 앱 파일을 기기에 저장해 두고 오프라인에서도 열리게 한다.
   - 데이터(localStorage)는 서비스 워커가 건드리지 않는다. 저장하는 것은 앱 코드 파일뿐.
   - 새 버전을 배포했을 때는 CACHE 이름을 올리면(빌드 스크립트가 자동으로 올림) 옛 캐시가 지워지고 새 파일을 받는다.
   - 전략: 네트워크 우선(온라인이면 항상 최신), 실패하면 저장해 둔 파일. 그래서 고친 화면이 바로 반영된다. */
const CACHE = "taskhub-phone-ef0fbdf2e6";
const FILES = ["./", "./index.html", "./core.js", "./local.js", "./config.js", "./register-sw.js", "./mobile.css", "./app/app.js", "./app/style.css", "./manifest.webmanifest", "./icons/icon-192.png", "./icons/icon-512.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET" || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith(
    fetch(req).then((res) => {
      if (res && res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {}); }
      return res;
    }).catch(() => caches.match(req).then((hit) => hit || caches.match("./index.html")))
  );
});
