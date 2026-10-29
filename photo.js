/* 사진 줄이기: 올리기 전에 긴 변을 줄이고 JPEG 로 다시 인코딩한다.
   - 캔버스에 다시 그려서 저장하므로 GPS·카메라 모델 같은 EXIF 메타데이터가 결과에 남지 않는다(촬영 위치가 백업·공유 파일에 딸려 가지 않음).
   - EXIF 회전값은 그림에 반영해서 똑바로 세운 뒤 저장한다(회전값이 사라져도 사진이 누워 보이지 않게).
   - 브라우저 전용(캔버스·Blob 사용). 계산 부분(fitSize)은 순수 함수라 단위 테스트한다. */
(function (root, factory) {
  const lib = factory();
  if (typeof module === "object" && module.exports) module.exports = lib;
  else root.THPhoto = lib;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const MAX_SIDE = 1600, QUALITY = 0.82, MAX_INPUT = 40 * 1024 * 1024, MAX_PIXELS = 100e6;

  // 긴 변이 max 를 넘으면 비율을 지켜 줄인다. 작은 사진은 키우지 않는다.
  function fitSize(w, h, max) {
    max = max || MAX_SIDE;
    if (!(w > 0) || !(h > 0)) throw new Error("사진 크기를 알 수 없습니다.");
    const k = Math.min(1, max / Math.max(w, h));
    return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)), scaled: k < 1 };
  }

  function canvasToBlob(canvas, type, q) {
    return new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error("사진을 변환하지 못했습니다."))), type, q));
  }

  // 파일 → { blob, w, h, mime }. 실패하면 이유를 담은 Error.
  async function shrink(file, opts) {
    const o = opts || {};
    if (!file || typeof file.size !== "number") throw new Error("사진 파일이 필요합니다.");
    if (file.size > MAX_INPUT) throw new Error("사진 파일이 너무 큽니다(40MB 이하).");
    if (file.type && !/^image\//.test(file.type)) throw new Error("이미지 파일이 아닙니다.");
    let bmp;
    try {
      // imageOrientation: "from-image" → EXIF 회전을 적용한 비트맵을 돌려받는다(명시해서 브라우저마다 다른 기본값에 기대지 않는다).
      bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
    } catch (e) {
      throw new Error("이 사진을 열 수 없습니다. 지원하지 않는 형식(HEIC 등)이거나 손상된 파일일 수 있습니다. 카메라 설정을 ‘호환성 우선(JPEG)’로 바꾸거나 다른 사진으로 시도하세요.");
    }
    try {
      if (bmp.width * bmp.height > MAX_PIXELS) throw new Error("사진 해상도가 너무 큽니다.");
      const s = fitSize(bmp.width, bmp.height, o.maxSide);
      const canvas = (o.document || document).createElement("canvas");
      canvas.width = s.w; canvas.height = s.h;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, s.w, s.h);                 // 투명 PNG 가 JPEG 에서 검게 되지 않도록 흰 바탕
      ctx.drawImage(bmp, 0, 0, s.w, s.h);
      const blob = await canvasToBlob(canvas, "image/jpeg", o.quality || QUALITY);
      return { blob, w: s.w, h: s.h, mime: "image/jpeg" };
    } finally {
      if (bmp.close) bmp.close();
    }
  }

  return { shrink, fitSize, MAX_SIDE };
});
