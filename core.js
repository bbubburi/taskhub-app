/* TaskHub 핵심 로직의 JavaScript 판 (개인용 폰 앱이 서버 없이 쓴다).
   core.py 와 같은 규칙이어야 하므로 tests/vectors.json 의 같은 사례를 파이썬·JS 양쪽이 통과해야 한다.
   날짜는 내부적으로 '1970-01-01 기준 일수'(정수)로 계산한다 → 시간대·서머타임 영향 없음. 공개 함수는 ISO 문자열을 주고받는다. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.THCore = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const STATUSES = ["제안", "미착수", "진행 중", "확인 필요", "대기", "보류", "완료", "취소"];
  const DONE = new Set(["완료", "취소"]);
  const PRIORITIES = ["긴급", "높음", "보통", "낮음"];
  const PRI_RANK = {};
  PRIORITIES.forEach((p, i) => (PRI_RANK[p] = i));
  const REPEATS = ["", "매일", "매주", "매월", "매년"];
  const FIELDS = {
    title: "과제명", base_date: "기준일자", domain: "도메인", summary: "개요", detail: "세부사항", actions: "액션플랜",
    people: "관련인물", doc: "기획서", result: "결과", status: "상태", priority: "우선순위", start: "시작일", due: "기한", time: "시작 시각", end_time: "종료 시각",
    repeat: "반복", tags: "태그", links: "링크", source: "출처", parent: "상위 과제",
  };
  const MS = 86400000;

  class ValidationError extends Error {
    constructor(m) { super(m); this.name = "ValidationError"; }
  }

  // ── 날짜 ─────────────────────────────────────────
  const pad = (n, w = 2) => String(n).padStart(w, "0");
  function toDay(y, m, d) {                       // m: 1~12 (13 이상이면 다음 해로 넘어감)
    const t = new Date(0);
    t.setUTCFullYear(y, m - 1, d);
    t.setUTCHours(0, 0, 0, 0);
    return Math.floor(t.getTime() / MS);
  }
  function ymd(day) { const t = new Date(day * MS); return [t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()]; }
  function iso(day) { const [y, m, d] = ymd(day); return pad(y, 4) + "-" + pad(m) + "-" + pad(d); }
  function weekday(day) { return (new Date(day * MS).getUTCDay() + 6) % 7; }   // 월=0 … 일=6
  const repr = (s) => (typeof s === "string" ? "'" + s + "'" : String(s));

  function parseDate(s) {
    if (!s) return null;
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s).trim());
    if (!m) throw new ValidationError("날짜 형식은 YYYY-MM-DD 이어야 합니다: " + repr(s));
    const y = +m[1], mo = +m[2], d = +m[3];
    if (y < 1) throw new ValidationError("존재하지 않는 날짜입니다: " + repr(s));
    const day = toDay(y, mo, d);
    const b = ymd(day);
    if (b[0] !== y || b[1] !== mo || b[2] !== d) throw new ValidationError("존재하지 않는 날짜입니다: " + repr(s));
    return day;
  }
  // 'HH:MM'(24시간제) → 그 날 0시부터의 분(0~1439). 빈 값이면 null. core.py 의 parse_time 과 같은 규칙.
  function parseTime(s) {
    if (!s) return null;
    const t = String(s).trim();
    if (!t) return null;
    const m = /^(\d{2}):(\d{2})$/.exec(t);
    if (!m) throw new ValidationError("시각 형식은 HH:MM 이어야 합니다: " + repr(t));
    const h = +m[1], mi = +m[2];
    if (h > 23 || mi > 59) throw new ValidationError("존재하지 않는 시각입니다: " + repr(t));
    return h * 60 + mi;
  }
  function today() { const n = new Date(); return toDay(n.getFullYear(), n.getMonth() + 1, n.getDate()); }
  function refDay(ref) {
    if (ref === undefined || ref === null || ref === "") return today();
    return typeof ref === "number" ? ref : parseDate(ref);
  }
  const shiftIso = (s, n) => iso(parseDate(s) + n);

  function periodRangeDay(period, d) {
    if (period === "today") return [d, d];
    if (period === "week") { const mon = d - weekday(d); return [mon, mon + 6]; }
    const [y, m] = ymd(d);
    if (period === "month") return [toDay(y, m, 1), toDay(y, m + 1, 1) - 1];
    if (period === "year") return [toDay(y, 1, 1), toDay(y, 12, 31)];
    throw new ValidationError("알 수 없는 기간: " + period);
  }
  function range(period, ref) { const [a, b] = periodRangeDay(period, refDay(ref)); return [iso(a), iso(b)]; }
  const weekRange = (ref) => range("week", ref);
  const monthRange = (ref) => range("month", ref);
  const yearRange = (ref) => range("year", ref);

  function span(item) {
    let s = parseDate(item.start), e = parseDate(item.due);
    if (s !== null && e === null) e = s;
    if (e !== null && s === null) s = e;
    return [s, e];
  }
  function inPeriod(item, period, ref) {
    if (DONE.has(item.status)) return false;
    const r = refDay(ref);
    const [lo, hi] = periodRangeDay(period, r);
    const [s, e] = span(item);
    if (s === null) return false;
    if ((period === "today" || period === "week") && e < r) return true;   // 기한 지난 미완료는 계속 노출
    return s <= hi && e >= lo;
  }
  function isOverdue(item, ref) {
    const r = refDay(ref);
    const e = span(item)[1];
    return e !== null && e < r && !DONE.has(item.status);
  }
  function undated(item) { return span(item)[0] === null && !DONE.has(item.status); }

  function sortCompare(a, b) {
    const ea = span(a)[1], eb = span(b)[1];
    const ka = ea === null ? Infinity : ea, kb = eb === null ? Infinity : eb;
    if (ka !== kb) return ka < kb ? -1 : 1;
    const ma = parseTime(a.time), mb = parseTime(b.time);
    const xa = ma === null ? 24 * 60 : ma, xb = mb === null ? 24 * 60 : mb;
    if (xa !== xb) return xa - xb;
    const pa = a.priority in PRI_RANK ? PRI_RANK[a.priority] : 2;
    const pb = b.priority in PRI_RANK ? PRI_RANK[b.priority] : 2;
    if (pa !== pb) return pa - pb;
    const ta = a.title || "", tb = b.title || "";
    return ta < tb ? -1 : ta > tb ? 1 : 0;
  }

  // 끌어서 날짜 옮기기: 기한을 to 로 옮기고, 기간 일정(시작일~기한)은 길이를 그대로 보존한다. 시작일만 있는 일정은 하루짜리로 본다.
  // 돌려주는 것은 바뀌는 필드({start, due})뿐이다. 시각 등 다른 필드는 건드리지 않는다.
  function moveTo(item, to) {
    const target = parseDate(to);
    if (target === null) throw new ValidationError("옮길 날짜가 없습니다.");
    const [s, e] = span(item);
    if (s === null || s === e) return { start: "", due: iso(target) };
    return { start: iso(target), due: iso(target + (e - s)) };
  }

  // 할 일 목록의 구간. core.py 의 section_of 와 같은 규칙. ref 는 ISO 날짜 문자열(기본: 오늘).
  function sectionOf(item, ref) {
    if (DONE.has(item.status)) return "done";
    const [s, e] = span(item);
    if (s === null) return item.status === "진행 중" || item.status === "확인 필요" ? "doing" : "undated";
    const r = refDay(ref);
    if (e < r) return "overdue";
    if (s <= r) return "today";
    const n = s - r;
    if (n === 1) return "tomorrow";
    return n <= 6 - weekday(r) ? "week" : "later";
  }

  function nextOccurrence(item, ref) {
    const due = parseDate(item.due);
    const base = due !== null ? due : refDay(ref);
    const rep = item.repeat;
    if (rep === "매일") return iso(base + 1);
    if (rep === "매주") return iso(base + 7);
    if (rep === "매월") {
      const [y, m, d] = ymd(base);
      const y2 = y + Math.floor(m / 12), m2 = (m % 12) + 1;
      const last = ymd(toDay(y2, m2 + 1, 1) - 1)[2];
      return iso(toDay(y2, m2, Math.min(d, last)));
    }
    if (rep === "매년") {
      const [y, m, d] = ymd(base);
      const t = toDay(y + 1, m, d);
      return ymd(t)[1] !== m ? iso(toDay(y + 1, m, 28)) : iso(t);   // 2/29 → 2/28
    }
    return null;
  }

  // 파이썬 round() 와 같이 .5 는 짝수 쪽으로(1/8 → 12%, 3/8 → 38%)
  function roundHalfEven(x) {
    const f = Math.floor(x), diff = x - f;
    if (diff < 0.5) return f;
    if (diff > 0.5) return f + 1;
    return f % 2 === 0 ? f : f + 1;
  }
  function progress(item) {
    const a = item.actions || [];
    if (!a.length) return null;
    return roundHalfEven((100 * a.filter((x) => x.done).length) / a.length);
  }

  // ── 항목 정규화·검증 ──────────────────────────────
  function normList(v) {
    if (v === undefined || v === null) return [];
    if (typeof v === "string") return v.split(/[,\n]/).map((x) => x.trim()).filter(Boolean);
    return Array.from(v).map((x) => String(x).trim()).filter(Boolean);
  }
  function normActions(v) {
    if (v === undefined || v === null) return [];
    if (typeof v === "string") v = v.split("\n").filter((x) => x.trim());
    const out = [];
    for (const a of v) {
      if (typeof a === "string") {
        const t = a.replace(/^\s*(?:[-*•]|\[[ xX]\])\s*/, "").trim();
        if (t) out.push({ text: t, done: /^\s*\[[xX]\]/.test(a), due: "" });
      } else if (a && typeof a === "object" && String(a.text == null ? "" : a.text).trim()) {
        const due = a.due || "";
        parseDate(due);
        out.push({ text: String(a.text).trim(), done: !!a.done, due });
      }
    }
    return out;
  }
  function normalize(fields, existing, todayIso) {
    const it = existing ? JSON.parse(JSON.stringify(existing)) : {};
    const f = fields;
    for (const k of ["title", "domain", "summary", "detail", "doc", "result", "source", "parent"]) {
      if (k in f) it[k] = typeof f[k] === "string" ? f[k].trim() : f[k] || "";
    }
    for (const k of ["base_date", "start", "due"]) {
      if (k in f) { parseDate(f[k]); it[k] = f[k] || ""; }
    }
    for (const k of ["time", "end_time"]) {
      if (k in f) { parseTime(f[k]); it[k] = typeof f[k] === "string" ? f[k].trim() : ""; }
    }
    if ("status" in f) {
      if (!STATUSES.includes(f.status)) throw new ValidationError("상태는 " + STATUSES.join(", ") + " 중 하나여야 합니다.");
      it.status = f.status;
    }
    if ("priority" in f) {
      if (!PRIORITIES.includes(f.priority)) throw new ValidationError("우선순위는 " + PRIORITIES.join(", ") + " 중 하나여야 합니다.");
      it.priority = f.priority;
    }
    if ("repeat" in f) {
      if (!REPEATS.includes(f.repeat)) throw new ValidationError("반복은 " + REPEATS.map((r) => r || "(없음)").join(", ") + " 중 하나여야 합니다.");
      it.repeat = f.repeat;
    }
    for (const k of ["people", "tags", "links"]) if (k in f) it[k] = normList(f[k]);
    if ("actions" in f) it.actions = normActions(f.actions);
    if (!it.title) throw new ValidationError("과제명은 비울 수 없습니다.");
    const s = parseDate(it.start), e = parseDate(it.due);
    if (s !== null && e !== null && s > e) throw new ValidationError("시작일이 기한보다 늦습니다.");
    const t0 = parseTime(it.time), t1 = parseTime(it.end_time);
    if (t1 !== null && t0 === null) throw new ValidationError("종료 시각만 있을 수 없습니다. 시작 시각을 먼저 넣으세요.");
    // 종료 시각이 더 빠른 것은 '같은 날'일 때만 오류다(며칠에 걸친 일정은 마지막 날 오전에 끝날 수 있다).
    const oneDay = !(s !== null && e !== null && s !== e);
    if (t0 !== null && t1 !== null && oneDay && t1 < t0) throw new ValidationError("종료 시각이 시작 시각보다 빠릅니다.");
    const dflt = { status: "미착수", priority: "보통", repeat: "", base_date: todayIso || iso(today()) };
    for (const k of Object.keys(dflt)) if (!(k in it)) it[k] = dflt[k];
    for (const k of ["domain", "summary", "detail", "doc", "result", "source", "parent", "start", "due", "time", "end_time"]) if (!(k in it)) it[k] = "";
    for (const k of ["people", "tags", "links", "actions"]) if (!(k in it)) it[k] = [];
    return it;
  }

  // ── 보관함(링크·사진·메모) ────────────────────────
  // core.py 의 normalize_clip 과 같은 규칙. 링크는 허용 목록 방식(http/https 만)이다.
  const CLIP_KINDS = ["link", "note", "photo", "file"];
  const CLIP_PHOTO_MIMES = ["image/jpeg", "image/png", "image/webp", "image/gif"];
  // 한도는 core.py 와 같은 값. 혼자 쓰는 기기 전제라 넉넉하게 두고, 목적은 ‘실수로 거대한 것을 올리는 것’ 방지뿐이다.
  const CLIP_MAX_URL = 8192, CLIP_MAX_BODY = 100000, CLIP_MAX_PHOTO = 100 * 1024 * 1024;
  const CLIP_MAX_FILE = 2 * 1024 * 1024 * 1024;                 // 내투두는 이 위에 ‘브라우저가 허락한 남은 공간’ 검사가 따로 붙는다(local.js)
  const FILE_EXTS = new Set(["pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "hwp", "hwpx", "txt", "md", "csv", "rtf", "odt", "ods", "odp",
    "zip", "7z", "png", "jpg", "jpeg", "gif", "webp", "mp3", "m4a", "wav", "mp4", "mov", "json", "eml", "msg"]);
  const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;

  // 주소에서 호스트만 잘라낸다. URL 파서에 맡기면 'https:///path' 를 'https://path' 로 고쳐 버리고 한글 도메인을 xn-- 로 바꿔
  // 언어마다 결과가 달라지므로 직접 자른다(권한부 = '://' 뒤 ~ 첫 / ? #). 사용자:비밀번호@ 와 :포트 는 뗀다. core.py 의 _host_of 와 같은 규칙.
  function hostOf(u) {
    const rest = u.replace(/^https?:\/\//i, "");
    let auth = rest.split(/[\/?#]/, 1)[0];
    auth = auth.slice(auth.lastIndexOf("@") + 1);
    if (auth.startsWith("[")) return "";                    // IPv6 주소는 지원하지 않는다(거부)
    auth = auth.replace(/:\d*$/, "");
    return auth.toLowerCase();
  }
  function clipUrl(raw) {
    const u = typeof raw === "string" ? raw.trim() : "";
    if (!u) throw new ValidationError("링크 주소를 입력하세요.");
    if (u.length > CLIP_MAX_URL) throw new ValidationError("링크가 너무 깁니다(8192자 이하).");
    if (!/^https?:\/\//i.test(u)) throw new ValidationError("링크는 http:// 또는 https:// 로 시작해야 합니다.");
    // 브라우저는 URL 안의 탭/줄바꿈을 무시하고 해석하므로 공백·제어 문자가 섞인 값은 파싱 전에 거부한다.
    if (/[\s\x00-\x1f\x7f]/.test(u)) throw new ValidationError("링크 주소가 올바르지 않습니다.");
    const host = hostOf(u);
    if (!host) throw new ValidationError("링크 주소가 올바르지 않습니다.");
    return [u, host.startsWith("www.") ? host.slice(4) : host];
  }
  // 보관할 파일의 표시용 이름. core.py 의 clean_filename 과 같은 규칙.
  function cleanFilename(name) {
    let n = String(name == null ? "" : name).split(/[\\/]/).pop();
    n = n.replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim().replace(/\.+$/, "").trim();
    if (n.startsWith(".") && !n.slice(1).includes(".")) throw new ValidationError("파일 이름이 비어 있습니다.");     // '.pdf' 처럼 이름 없이 확장자만
    n = n.replace(/^\.+/, "").trim();
    if (!n.includes(".")) throw new ValidationError(n ? "파일 이름에 확장자가 필요합니다." : "파일 이름이 비어 있습니다.");
    const i = n.lastIndexOf("."), stem = n.slice(0, i), ext = n.slice(i + 1).toLowerCase();
    if (!stem.trim()) throw new ValidationError("파일 이름이 비어 있습니다.");
    if (!FILE_EXTS.has(ext)) throw new ValidationError("이 형식의 파일은 보관할 수 없습니다(." + ext + ").");
    return stem.trim().slice(0, 100 - ext.length - 1).replace(/\s+$/, "") + "." + ext;
  }
  function normalizeClip(fields, existing) {
    const cl = existing ? JSON.parse(JSON.stringify(existing)) : {};
    const f = fields;
    const kind = "kind" in f ? f.kind : cl.kind;
    if (!CLIP_KINDS.includes(kind)) throw new ValidationError("종류는 " + CLIP_KINDS.join(", ") + " 중 하나여야 합니다.");
    cl.kind = kind;
    if ("title" in f || !("title" in cl)) cl.title = typeof f.title === "string" ? f.title.trim() : "";
    if ("body" in f || !("body" in cl)) cl.body = typeof f.body === "string" ? f.body.trim() : "";
    if (cl.body.length > CLIP_MAX_BODY) throw new ValidationError("메모가 너무 깁니다(100000자 이하).");
    if ("tags" in f || !("tags" in cl)) cl.tags = normList(f.tags);
    if ("item" in f || !("item" in cl)) {
      const item = typeof f.item === "string" ? f.item : "";
      if (item && !ID_RE.test(item)) throw new ValidationError("연결할 할 일 번호가 올바르지 않습니다.");
      cl.item = item;
    }
    for (const k of ["url", "host", "blob", "mime", "name"]) if (!(k in cl)) cl[k] = "";
    for (const k of ["w", "h", "bytes"]) if (!(k in cl)) cl[k] = 0;
    if (kind === "link") {
      const [u, h] = clipUrl("url" in f ? f.url : cl.url);
      cl.url = u; cl.host = h;
    } else if (kind === "note") {
      if (!cl.body) throw new ValidationError("메모 내용을 입력하세요.");
    } else if (kind === "file") {
      const blob = "blob" in f ? f.blob : cl.blob;
      if (typeof blob !== "string" || !ID_RE.test(blob)) throw new ValidationError("파일이 필요합니다.");
      cl.name = cleanFilename("name" in f ? f.name : cl.name);
      const size = ("bytes" in f ? f.bytes : cl.bytes) || 0;
      if (!Number.isInteger(size) || size < 0) throw new ValidationError("파일 크기가 올바르지 않습니다.");
      if (size > CLIP_MAX_FILE) throw new ValidationError("파일이 너무 큽니다(2GB 이하).");
      cl.blob = blob; cl.bytes = size; cl.mime = "";
    } else {
      const blob = "blob" in f ? f.blob : cl.blob;
      if (typeof blob !== "string" || !ID_RE.test(blob)) throw new ValidationError("사진 파일이 필요합니다.");
      const mime = ("mime" in f ? f.mime : cl.mime) || "";
      if (!CLIP_PHOTO_MIMES.includes(mime)) throw new ValidationError("사진은 jpeg, png, webp, gif 만 올릴 수 있습니다.");
      const size = ("bytes" in f ? f.bytes : cl.bytes) || 0;
      if (!Number.isInteger(size) || size < 0) throw new ValidationError("사진 파일 크기가 올바르지 않습니다.");
      if (size > CLIP_MAX_PHOTO) throw new ValidationError("사진 파일이 너무 큽니다(100MB 이하).");
      cl.blob = blob; cl.mime = mime; cl.bytes = size;
      for (const k of ["w", "h"]) { const v = ("w" in f || "h" in f) ? (f[k] || 0) : (cl[k] || 0); cl[k] = Number.isInteger(v) && v >= 0 && v <= 20000 ? v : 0; }
    }
    return cl;
  }
  // 최근에 만든 것이 위. 같은 시각이면 id 가 큰 쪽이 위.
  function clipSortCompare(a, b) {
    const ca = a.created || "", cb = b.created || "";
    if (ca !== cb) return ca < cb ? 1 : -1;
    const ia = a.id || "", ib = b.id || "";
    return ia < ib ? 1 : ia > ib ? -1 : 0;
  }
  function clipFilter(clips, query) {
    const q = String(query || "").trim().toLowerCase();
    if (!q) return clips.slice();
    return clips.filter((c) => [c.title || "", c.body || "", c.url || "", (c.tags || []).join(" ")].join(" ").toLowerCase().includes(q));
  }

  // ── 자연어 빠른 입력 ────────────────────────────
  // "내일 오후 3시 회의" → { title:"회의", due, time, ... }. 원칙: 확실한 표현만 읽고, 조금이라도 모호하면 건드리지 않고 제목에 그대로 둔다.
  // (엉뚱한 날짜에 일정이 잡히는 것이 가장 나쁘다.) 토큰(공백으로 나눈 단어) 단위로 읽으므로 ‘오늘의’·‘내일부터’·‘3시간’ 같은 말은 해석하지 않는다.
  // 제목이 비게 되면 해석하지 않는다(날짜만 친 실수일 가능성이 높다). 읽은 결과는 화면이 저장 전에 칩으로 보여 준다.
  const WD = { 월: 0, 화: 1, 수: 2, 목: 3, 금: 4, 토: 5, 일: 6 };
  const DAY_WORDS = { 오늘: 0, 내일: 1, 모레: 2, 내일모레: 2, 글피: 3 };
  const DAYPART = { 새벽: [0, 5], 아침: [5, 11], 낮: [11, 17], 저녁: [17, 21], 밤: [18, 24] };      // 낮/저녁/밤은 오후 쪽, 새벽/아침은 오전 쪽
  function daysInMonth(y, m) { return ymd(toDay(y, m + 1, 1) - 1)[2]; }
  function validMd(y, m, d) { return m >= 1 && m <= 12 && d >= 1 && d <= daysInMonth(y, m); }
  function pick24(h, m, mer) {                                   // 시(h)·분(m)·오전/오후 단서 → 24시간제 분 값 (불가능하면 null)
    if (!(m >= 0 && m <= 59)) return null;
    if (mer === "am") { if (h < 1 || h > 12) return null; h = h === 12 ? 0 : h; }
    else if (mer === "pm") { if (h < 1 || h > 12) return null; h = h === 12 ? 12 : h + 12; }
    else if (mer === "24") { if (h < 0 || h > 23) return null; }
    else { if (h < 1 || h > 12) return null; h = h === 12 ? 12 : h <= 6 ? h + 12 : h; }       // 단서가 없으면 1~6시는 오후, 7~11시는 오전, 12시는 정오
    return h * 60 + m;
  }
  const hhmm = (min) => pad(Math.floor(min / 60)) + ":" + pad(min % 60);
  // 시각 토큰열 하나를 읽는다. 읽으면 { min, used(소비한 토큰 수), mer } 아니면 null.
  function readClock(tok, i, hint) {
    const t = tok[i];
    let m = /^(\d{1,2}):(\d{2})$/.exec(t);
    if (m) { const min = pick24(+m[1], +m[2], hint ? hint : +m[1] >= 13 || m[1].length === 2 && +m[1] === 0 ? "24" : hint || "none"); return min === null ? null : { min, used: 1 }; }
    let mer = hint || "none", j = i;
    if (t === "오전" || t === "오후") { mer = t === "오전" ? "am" : "pm"; j++; }
    else if (DAYPART[t]) { mer = DAYPART[t][0] < 11 && t !== "낮" ? "am" : "pm"; if (t === "낮") mer = "pm"; j++; }
    else if (t === "정오") return { min: 720, used: 1 };
    else if (t === "자정") return { min: 0, used: 1 };
    const h = /^(\d{1,2})시$/.exec(tok[j] || "");
    if (!h) return null;
    const hour = +h[1];
    let k = j + 1, minute = 0;
    if (tok[k] === "반") { minute = 30; k++; }
    else { const mm = /^(\d{1,2})분$/.exec(tok[k] || ""); if (mm) { minute = +mm[1]; k++; } }
    // ‘3시간’·‘2시간 뒤’는 소요 시간이므로 읽지 않는다(토큰이 정확히 N시 일 때만 통과하므로 여기까지 오지 않는다)
    const min = pick24(hour, minute, mer);
    return min === null ? null : { min, used: k - i, mer: mer === "none" ? undefined : mer };
  }
  function parseQuick(text, todayIso) {
    const raw = String(text == null ? "" : text).trim().replace(/\s+/g, " ");
    const out = { title: raw, due: "", time: "", end_time: "", repeat: "" };
    if (!raw) return out;
    // 범위 표지를 별도 토큰으로 갈라 둔다: "2시부터" → "2시 부터", "4시까지" → "4시 까지", "10시~11시" → "10시 ~ 11시", "2시-4시" → "2시 - 4시".
    // 제목으로 되돌릴 때는 원문 토큰을 쓰므로(rawTok) 해석하지 않은 부분은 입력 그대로 남는다.
    const split = (w) => w
      .replace(/(\d시(?:\d{1,2}분|반)?)(부터|까지)/g, "$1 $2")
      .replace(/(\d시(?:\d{1,2}분|반)?|\d{1,2}:\d{2})([~-])(?=\d|오전|오후)/g, "$1 $2 ")
      .replace(/(\d시(?:\d{1,2}분|반)?|\d{1,2}:\d{2})([~-])(?=\D)/g, "$1 $2 ");
    const rawTok = raw.split(" ");
    const ref = refDay(todayIso), [ty, tm, td] = ymd(ref);
    const tok = [], origin = [];                                       // tok[k] 는 갈라낸 토큰, origin[k] 는 그 토큰이 나온 원문 토큰 번호
    rawTok.forEach((w, n) => split(w).split(" ").filter(Boolean).forEach((x) => { tok.push(x); origin.push(n); }));
    const used = new Array(tok.length).fill(false);
    let due = null, time = null, endTime = null, repeat = "";
    const take = (a, n) => { for (let k = a; k < a + n; k++) used[k] = true; };
    const free = (a, n) => { for (let k = a; k < a + n; k++) if (k >= tok.length || used[k]) return false; return true; };
    const nextWeekday = (wd, strict) => {                           // wd 요일 중 오늘 이후(오늘이면 다음 주)
      let d = ref + ((wd - weekday(ref) + 7) % 7);
      if (d === ref && strict !== false) d += 7;
      return d;
    };
    for (let i = 0; i < tok.length; i++) {
      if (used[i]) continue;
      const t = tok[i];
      // ── 반복: 매일 / 매주 X요일 / 매월 N일 / 매년 M월 D일
      if (!repeat && t === "매일" && due === null) { repeat = "매일"; due = ref; take(i, 1); continue; }
      if (!repeat && t === "매주" && due === null) {
        const w = /^([월화수목금토일])요일$/.exec(tok[i + 1] || "");
        if (w && free(i, 2)) { repeat = "매주"; due = nextWeekday(WD[w[1]], false); take(i, 2); continue; }
      }
      if (!repeat && t === "매월" && due === null) {
        const d = /^(\d{1,2})일$/.exec(tok[i + 1] || "");
        if (d && free(i, 2) && +d[1] >= 1 && +d[1] <= 31) {
          const dd = +d[1];
          let y = ty, m = tm;
          if (dd < td) { m++; if (m > 12) { m = 1; y++; } }
          const day = Math.min(dd, daysInMonth(y, m));
          repeat = "매월"; due = toDay(y, m, day); take(i, 2); continue;
        }
      }
      if (!repeat && t === "매년" && due === null) {
        const md = /^(\d{1,2})월$/.exec(tok[i + 1] || ""), dd = /^(\d{1,2})일$/.exec(tok[i + 2] || "");
        if (md && dd && free(i, 3) && validMd(2001, +md[1], +dd[1]) && !(+md[1] === 2 && +dd[1] === 29)) {
          let y = ty;
          if (toDay(y, +md[1], +dd[1]) < ref) y++;
          repeat = "매년"; due = toDay(y, +md[1], +dd[1]); take(i, 3); continue;
        }
      }
      if (due === null && !repeat) {
        // ── 날짜 단어
        if (t in DAY_WORDS) { due = ref + DAY_WORDS[t]; take(i, 1); continue; }
        // ── 요일: (이번주|다음주|다음 주|이번 주) X요일 / X요일
        const wk = t === "이번주" || t === "다음주" ? t : (t === "이번" || t === "다음") && tok[i + 1] === "주" ? t + "주" : null;
        const wkLen = wk && (t === "이번주" || t === "다음주") ? 1 : 2;
        if (wk && free(i, wkLen + 1)) {
          const w = /^([월화수목금토일])요일$/.exec(tok[i + wkLen] || "");
          if (w) {
            const monday = ref - weekday(ref) + (wk === "다음주" ? 7 : 0);
            due = monday + WD[w[1]]; take(i, wkLen + 1); continue;
          }
        }
        const w1 = /^([월화수목금토일])요일$/.exec(t);
        if (w1) { due = nextWeekday(WD[w1[1]]); take(i, 1); continue; }
        // ── 월/일: 11/5 · 11월 5일 · 11월5일 · 2026-11-05 · 2027년 3월 1일
        let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
        if (m && validMd(+m[1], +m[2], +m[3])) { due = toDay(+m[1], +m[2], +m[3]); take(i, 1); continue; }
        let y0 = null, a = i;
        const yr = /^(\d{4})년$/.exec(t);
        if (yr) { y0 = +yr[1]; a = i + 1; }
        m = /^(\d{1,2})\/(\d{1,2})$/.exec(tok[a] || "");
        let mo = null, dy = null, len = 0;
        if (m) { mo = +m[1]; dy = +m[2]; len = a - i + 1; }
        else {
          const mm = /^(\d{1,2})월(\d{1,2})일$/.exec(tok[a] || "");
          if (mm) { mo = +mm[1]; dy = +mm[2]; len = a - i + 1; }
          else {
            const m2 = /^(\d{1,2})월$/.exec(tok[a] || ""), d2 = /^(\d{1,2})일$/.exec(tok[a + 1] || "");
            if (m2 && d2) { mo = +m2[1]; dy = +d2[1]; len = a - i + 2; }
          }
        }
        if (mo !== null && free(i, len)) {
          if (mo === 2 && dy === 29 && y0 === null) continue;       // 연도를 안 쓴 2/29 는 어느 해인지 모호하므로 해석하지 않는다(연도를 쓰면 아래에서 실제 존재 여부로 판단)
          const y = y0 !== null ? y0 : ty;
          if (!validMd(y, mo, dy)) continue;
          let d = toDay(y, mo, dy);
          if (y0 === null && d < ref) d = toDay(y + 1, mo, dy);       // 이미 지난 날짜(연도를 안 썼을 때)는 다음 해
          due = d; take(i, len); continue;
        }
      }
      // ── 시각: 오전/오후/아침/저녁… N시 [반|M분] · H:MM · 정오 · 자정 · 범위(A ~ B · A - B · A 부터 B [까지])
      if (time === null) {
        const c = readClock(tok, i);
        if (c && free(i, c.used)) {
          let usedAll = c.used, endMin = null;
          const j = i + c.used, sep = tok[j];
          if (sep === "~" || sep === "-" || sep === "부터") {
            const e = readClock(tok, j + 1, c.mer);                    // 앞의 오전/오후 단서가 뒤 시각에도 이어진다("오후 2시 ~ 4시")
            if (e && free(j + 1, e.used) && e.min > c.min) {
              usedAll += 1 + e.used; endMin = e.min;
              if (tok[j + 1 + e.used] === "까지" && free(j + 1 + e.used, 1)) usedAll++;
            }
          }
          time = c.min; endTime = endMin; take(i, usedAll); continue;
        }
      }
    }
    const keep = new Set(tok.map((_, k) => k).filter((k) => !used[k]).map((k) => origin[k]));       // 일부라도 해석에 쓰이지 않은 원문 토큰
    const fully = new Set(origin.filter((n) => tok.every((_, k) => origin[k] !== n || used[k])));     // 전부 해석에 쓰인 원문 토큰
    const rest = rawTok.filter((_, n) => !fully.has(n) && (keep.has(n) || !fully.has(n))).join(" ");
    const interpreted = due !== null || time !== null || repeat;
    if (!interpreted || !rest || DAY_ONLY(rest)) return out;          // 읽은 게 없거나, 읽고 나면 제목이 비면(또는 날짜 단어뿐이면) 그대로 둔다
    out.title = rest;
    if (due !== null) out.due = iso(due);
    else if (time !== null || repeat) out.due = iso(ref);               // 시각만 있으면 오늘
    if (time !== null) out.time = hhmm(time);
    if (endTime !== null) out.end_time = hhmm(endTime);
    if (repeat) out.repeat = repeat;
    return out;
  }
  function DAY_ONLY(rest) { return rest.split(" ").every((w) => w in DAY_WORDS); }

  // ── 달력 ─────────────────────────────────────────
  // 월요일 시작, 항상 6주(42칸). 날짜는 ISO 문자열로 주고받는다.
  function monthGrid(year, month) {
    if (!(month >= 1 && month <= 12)) throw new ValidationError("월은 1~12 여야 합니다.");
    const first = toDay(year, month, 1), start = first - weekday(first), cells = [];
    for (let i = 0; i < 42; i++) cells.push({ date: iso(start + i), in_month: ymd(start + i)[1] === month });
    return cells;
  }
  // 달력에 찍을 과제를 날짜별로: 완료·취소 제외 / 시작~기한 모든 날 / 기한 없음 제외
  function itemsByDay(items, year, month) {
    const grid = monthGrid(year, month), lo = parseDate(grid[0].date), hi = parseDate(grid[41].date), out = {};
    for (const it of items) {
      if (DONE.has(it.status)) continue;
      const [s, e] = span(it);
      if (s === null || e < lo || s > hi) continue;
      for (let d = Math.max(s, lo); d <= Math.min(e, hi); d++) (out[iso(d)] = out[iso(d)] || []).push(it);
    }
    for (const k of Object.keys(out)) out[k].sort(sortCompare);
    return out;
  }

  return {
    STATUSES, PRIORITIES, REPEATS, FIELDS, DONE, ValidationError,
    parseDate, parseTime, iso, today, toDay, ymd, shiftIso, weekRange, monthRange, yearRange,
    inPeriod, isOverdue, undated, sortCompare, nextOccurrence, progress, normalize, monthGrid, itemsByDay,
    normalizeClip, clipSortCompare, clipFilter, CLIP_KINDS, CLIP_PHOTO_MIMES, CLIP_MAX_PHOTO, CLIP_MAX_FILE, cleanFilename, sectionOf, parseQuick, moveTo,
  };
});
