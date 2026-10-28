// 홈 화면 앱을 오프라인에서도 열기 위한 서비스 워커. 실패해도 앱은 그대로 동작한다.
if ("serviceWorker" in navigator && location.protocol !== "file:") {
  navigator.serviceWorker.register("sw.js").catch(function () { /* 등록 불가(http 접속 등) → 일반 웹페이지로 동작 */ });
}
