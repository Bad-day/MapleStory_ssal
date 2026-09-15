/* 메소 알러지 쌀숭이 서비스 워커
   앱 껍데기를 캐시해 오프라인에서도 켜지게 한다.
   사진 판독과 넥슨 조회만 네트워크가 필요하고 나머지 기능은 전부 동작한다. */
const CACHE = "ssalsungi-v1";
const SHELL = [
  "./", "./index.html", "./app.js", "./app.css",
  "./manifest.webmanifest", "./icon-192.png", "./icon-512.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  // API 호출은 절대 캐시하지 않는다
  if (url.hostname.endsWith("anthropic.com") || url.hostname.endsWith("nexon.com")) return;
  if (url.origin !== location.origin) return;

  // 앱 파일은 네트워크 우선, 실패하면 캐시로 떨어진다
  e.respondWith(
    fetch(req)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(req).then((r) => r || caches.match("./index.html")))
  );
});
