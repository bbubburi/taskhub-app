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
    people: "관련인물", doc: "기획서", result: "결과", status: "상태", priority: "우선순위", start: "시작일", due: "기한",
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
    const pa = a.priority in PRI_RANK ? PRI_RANK[a.priority] : 2;
    const pb = b.priority in PRI_RANK ? PRI_RANK[b.priority] : 2;
    if (pa !== pb) return pa - pb;
    const ta = a.title || "", tb = b.title || "";
    return ta < tb ? -1 : ta > tb ? 1 : 0;
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
    const dflt = { status: "미착수", priority: "보통", repeat: "", base_date: todayIso || iso(today()) };
    for (const k of Object.keys(dflt)) if (!(k in it)) it[k] = dflt[k];
    for (const k of ["domain", "summary", "detail", "doc", "result", "source", "parent", "start", "due"]) if (!(k in it)) it[k] = "";
    for (const k of ["people", "tags", "links", "actions"]) if (!(k in it)) it[k] = [];
    return it;
  }

  return {
    STATUSES, PRIORITIES, REPEATS, FIELDS, DONE, ValidationError,
    parseDate, iso, today, toDay, ymd, shiftIso, weekRange, monthRange, yearRange,
    inPeriod, isOverdue, undated, sortCompare, nextOccurrence, progress, normalize,
  };
});
