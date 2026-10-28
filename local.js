/* 개인용 폰 앱의 저장소·API. 서버(server.py)가 하던 일을 브라우저 안에서 한다.
   데이터: localStorage 의 JSON 한 덩어리(키 taskhub.personal.v1). 형식은 PC 앱의 personal.json 과 같다.
   원칙: 읽기→수정→쓰기를 한 번의 동기 호출로 끝낸다(중간에 다른 코드가 끼어들 수 없음).
         저장이 실패하면 기존 데이터를 그대로 두고 오류를 알린다. 손상된 데이터는 지우지 않고 사본을 남긴다. */
(function (root, factory) {
  const lib = factory(typeof module === "object" && module.exports ? require("./core.js") : root.THCore);
  if (typeof module === "object" && module.exports) module.exports = lib;
  else {
    root.THLocalLib = lib;
    if (root.TH_CONFIG && root.TH_CONFIG.local) root.THLocal = lib.create({ storage: lib.browserStorage(root) });
  }
})(typeof self !== "undefined" ? self : this, function (C) {
  "use strict";

  const KEY = "taskhub.personal.v1";
  const SPACE = "personal";
  const NOT_FOUND = "대상을 찾을 수 없습니다.";

  function browserStorage(root) {
    try {
      const s = root.localStorage, k = "__th_probe__";
      s.setItem(k, "1");
      s.removeItem(k);
      return s;
    } catch (e) { return null; }       // 사생활 보호 모드 등: 메모리로 대체(새로고침하면 사라짐)
  }

  function nowIso() {
    const n = new Date(), p = (x) => String(x).padStart(2, "0");
    return n.getFullYear() + "-" + p(n.getMonth() + 1) + "-" + p(n.getDate()) + "T" + p(n.getHours()) + ":" + p(n.getMinutes()) + ":" + p(n.getSeconds());
  }
  function newId() {
    const b = new Uint8Array(5);
    (typeof crypto !== "undefined" ? crypto : require("node:crypto").webcrypto).getRandomValues(b);
    return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  }

  function sanitizeImport(text) {
    let obj;
    try { obj = JSON.parse(text); } catch (e) { return { ok: false, error: "JSON 형식이 올바르지 않습니다." }; }
    // 업무 데이터가 개인 폰에 들어오는 실수를 막는다. 파일 형식이 같으므로 표식(space)으로 구분한다.
    // (표식이 없는 손수 만든 파일까지 막을 수는 없다: 완벽한 차단이 아니라 실수 방지 장치)
    if (obj && !Array.isArray(obj) && obj.space && obj.space !== SPACE) {
      return { ok: false, error: "이 파일은 ‘" + (obj.space === "work" ? "업무" : obj.space) + "’ 데이터입니다. 업무 데이터는 개인 폰 앱에 가져올 수 없습니다." };
    }
    const arr = Array.isArray(obj) ? obj : obj && Array.isArray(obj.items) ? obj.items : null;
    if (!arr) return { ok: false, error: "과제 목록(items)이 없는 파일입니다." };
    if (arr.length > 5000) return { ok: false, error: "과제가 5000건을 넘어 가져올 수 없습니다." };
    const out = [], ids = new Set();
    for (let i = 0; i < arr.length; i++) {
      const x = arr[i];
      if (!x || typeof x !== "object" || Array.isArray(x)) return { ok: false, error: (i + 1) + "번째 항목이 올바르지 않습니다." };
      let it;
      try { it = C.normalize(x); }                      // 알려진 필드만 복사되므로 낯선 키는 버려진다
      catch (e) {
        if (e instanceof C.ValidationError) return { ok: false, error: (i + 1) + "번째 과제: " + e.message };
        throw e;
      }
      const id = typeof x.id === "string" && /^[A-Za-z0-9_-]{1,40}$/.test(x.id) && !ids.has(x.id) ? x.id : newId();
      ids.add(id);
      it.id = id;
      for (const k of ["created", "updated"]) it[k] = typeof x[k] === "string" ? x[k].slice(0, 25) : nowIso();
      if (typeof x.ref === "string") it.ref = x.ref.slice(0, 100);
      out.push(it);
    }
    return { ok: true, items: out };
  }

  function create(opts) {
    const key = (opts && opts.key) || KEY;
    let store = opts && opts.storage;
    let persistent = true;
    let recovered = "";
    if (!store) {
      persistent = false;
      const mem = new Map();
      store = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => void mem.set(k, String(v)), removeItem: (k) => void mem.delete(k) };
    }
    const empty = () => ({ space: SPACE, items: [], inbox: [], log: [] });

    function load() {
      const raw = store.getItem(key);
      if (raw === null || raw === undefined) return empty();
      let d;
      try {
        d = JSON.parse(raw);
        if (!d || typeof d !== "object" || !Array.isArray(d.items)) throw new Error("shape");
      } catch (e) {
        const ck = key + ".corrupt." + Date.now();
        try { store.setItem(ck, raw); }
        catch (e2) { throw new Error("저장된 데이터를 읽을 수 없고 복구용 사본도 만들지 못했습니다. 브라우저 저장 공간을 확인하세요."); }
        store.removeItem(key);
        recovered = ck;
        return empty();
      }
      d.space = SPACE;
      if (!Array.isArray(d.inbox)) d.inbox = [];
      if (!Array.isArray(d.log)) d.log = [];
      return d;
    }
    function save(d) {
      try { store.setItem(key, JSON.stringify(d)); }
      catch (e) { throw new Error("저장 공간이 부족하거나 저장이 막혀 있어 저장하지 못했습니다. 백업 후 완료한 과제를 정리해 보세요."); }
    }
    function log(d, action, id, note) {
      d.log.push({ at: nowIso(), action, id, note: note || "" });
      if (d.log.length > 500) d.log = d.log.slice(-500);
    }
    function mutate(fn) {
      const d = load();
      const r = fn(d);        // fn 이 던지면 저장하지 않는다
      save(d);
      return r;
    }
    const findIdx = (d, id) => {
      const i = d.items.findIndex((x) => x.id === id);
      if (i < 0) throw new Error(NOT_FOUND);
      return i;
    };

    function addItem(fields) {
      return mutate((d) => {
        const it = C.normalize(fields);
        it.id = newId();
        it.created = it.updated = nowIso();
        d.items.push(it);
        log(d, "add", it.id, it.title);
        return it;
      });
    }
    function updateItem(id, fields) {
      return mutate((d) => {
        const i = findIdx(d, id);
        const old = d.items[i];
        const it = C.normalize(fields, old);
        it.updated = nowIso();
        let spawned = null;
        if (fields.status === "완료" && old.status !== "완료" && it.repeat) {       // 반복 과제는 완료하면 다음 회차를 만든다
          const nd = C.nextOccurrence(it);
          if (nd) {
            const nxt = JSON.parse(JSON.stringify(it));
            Object.assign(nxt, { id: newId(), status: "미착수", result: "", created: it.updated, updated: it.updated });
            const gap = it.start && it.due ? C.parseDate(it.due) - C.parseDate(it.start) : 0;
            nxt.due = nd;
            nxt.start = it.start ? C.shiftIso(nd, -gap) : "";
            nxt.actions = (it.actions || []).map((a) => Object.assign({}, a, { done: false }));
            d.items.push(nxt);
            spawned = nxt;
            log(d, "repeat", nxt.id, it.title + " → " + nxt.due);
          }
        }
        d.items[i] = it;
        log(d, "update", id, Object.keys(fields).sort().join(","));
        return { item: it, spawned };
      });
    }
    function deleteItem(id) {
      mutate((d) => {
        const i = findIdx(d, id);
        const [it] = d.items.splice(i, 1);
        d.items.forEach((o) => { if (o.parent === id) o.parent = ""; });
        log(d, "delete", id, it.title || "");
      });
    }
    function view(period, ref) {
      const items = load().items;
      let sel;
      if (["today", "week", "month", "year"].includes(period)) sel = items.filter((x) => C.inPeriod(x, period, ref));
      else if (period === "undated") sel = items.filter((x) => C.undated(x));
      else if (period === "done") sel = items.filter((x) => C.DONE.has(x.status));
      else if (period === "all") sel = items.slice();
      else throw new C.ValidationError("알 수 없는 기간: " + period);
      return sel.sort(C.sortCompare);
    }
    function counts(ref) {
      const items = load().items;
      const o = {};
      for (const p of ["today", "week", "month", "year"]) o[p] = items.filter((x) => C.inPeriod(x, p, ref)).length;
      o.undated = items.filter((x) => C.undated(x)).length;
      o.done = items.filter((x) => C.DONE.has(x.status)).length;
      o.overdue = items.filter((x) => C.isOverdue(x, ref)).length;
      o.inbox = 0;
      return o;
    }
    const decorate = (it) => Object.assign({}, it, { _progress: C.progress(it), _overdue: C.isOverdue(it) });

    // 서버 API 와 같은 경로·응답 모양 → 화면 코드(app.js)가 서버와 로컬을 구분하지 않는다
    async function handle(method, path, body) {
      const qi = path.indexOf("?");
      const p = qi < 0 ? path : path.slice(0, qi);
      const q = new URLSearchParams(qi < 0 ? "" : path.slice(qi + 1));
      const parts = p.replace(/^\/+|\/+$/g, "").split("/");
      const head = parts[0];
      if (method === "GET") {
        if (head === "meta") return { statuses: C.STATUSES, priorities: C.PRIORITIES, repeats: C.REPEATS, fields: C.FIELDS, spaces: [SPACE], today: C.iso(C.today()) };
        if (head === "counts") return counts();
        if (head === "items") return view(q.get("period") || "today").map(decorate);
        if (head === "item" && parts.length === 2) return decorate(load().items[findIdx(load(), parts[1])]);
        if (head === "inbox") return [];
      } else if (method === "POST" && head === "items") return addItem(body || {});
      else if (method === "PUT" && head === "item" && parts.length === 2) return updateItem(parts[1], body || {});
      else if (method === "DELETE" && head === "item" && parts.length === 2) { deleteItem(parts[1]); return { ok: true }; }
      throw new Error("지원하지 않는 요청입니다.");
    }

    // ── 백업·복원 ──
    function stats() { return { count: load().items.length, persistent, recovered }; }
    function exportData() {
      const d = load();
      return { app: "taskhub", format: 1, exported: nowIso(), space: SPACE, items: d.items, inbox: [], log: [] };
    }
    function replaceAll(items) {
      const cur = store.getItem(key);
      try { store.setItem(key + ".prev", cur !== null ? cur : JSON.stringify(empty())); }
      catch (e) { throw new Error("복원 전 현재 데이터를 보관하지 못해 중단했습니다. 저장 공간을 확인하세요."); }
      const d = empty();
      d.items = items;
      log(d, "import", "", items.length + "건");
      save(d);
    }
    function hasPrev() { return store.getItem(key + ".prev") !== null; }
    function restorePrev() {
      const p = store.getItem(key + ".prev");
      if (p === null) throw new Error("되돌릴 데이터가 없습니다.");
      store.setItem(key, p);
      store.removeItem(key + ".prev");
    }

    return { handle, addItem, updateItem, deleteItem, view, counts, stats, exportData, replaceAll, hasPrev, restorePrev, sanitizeImport, key };
  }

  return { create, browserStorage, sanitizeImport, KEY };
});
