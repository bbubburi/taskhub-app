/* 개인용 폰 앱의 저장소·API. 서버(server.py)가 하던 일을 브라우저 안에서 한다.
   데이터: localStorage 의 JSON 한 덩어리(키 taskhub.personal.v1). 형식은 PC 앱의 personal.json 과 같다.
   원칙: 읽기→수정→쓰기를 한 번의 동기 호출로 끝낸다(중간에 다른 코드가 끼어들 수 없음).
         저장이 실패하면 기존 데이터를 그대로 두고 오류를 알린다. 손상된 데이터는 지우지 않고 사본을 남긴다. */
(function (root, factory) {
  const lib = factory(typeof module === "object" && module.exports ? require("./core.js") : root.THCore);
  if (typeof module === "object" && module.exports) module.exports = lib;
  else {
    root.THLocalLib = lib;
    if (root.TH_CONFIG && root.TH_CONFIG.local) root.THLocal = lib.create({ storage: lib.browserStorage(root), blobs: lib.browserBlobs(root) });
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
    // 보관함(링크·메모·사진 정보)과 사진 본체. 백업 파일은 외부 입력이므로 하나라도 어긋나면 통째로 거부한다(일부만 반영하지 않음).
    // 보관함 정보가 아예 없는 옛 백업은 clips=null 로 돌려, 복원할 때 현재 보관함을 건드리지 않게 한다.
    const rawClips = !Array.isArray(obj) && obj && "clips" in obj ? obj.clips : undefined;
    let clips = null, photos = {};
    if (rawClips !== undefined) {
      if (!Array.isArray(rawClips)) return { ok: false, error: "보관함 목록(clips)의 형식이 올바르지 않습니다." };
      if (rawClips.length > 5000) return { ok: false, error: "보관함 항목이 5000건을 넘어 가져올 수 없습니다." };
      clips = [];
      const cids = new Set();
      for (let i = 0; i < rawClips.length; i++) {
        const x = rawClips[i];
        if (!x || typeof x !== "object" || Array.isArray(x)) return { ok: false, error: "보관함 " + (i + 1) + "번째 항목이 올바르지 않습니다." };
        let cl;
        try { cl = C.normalizeClip(x); }
        catch (e) {
          if (e instanceof C.ValidationError) return { ok: false, error: "보관함 " + (i + 1) + "번째 항목: " + e.message };
          throw e;
        }
        const id = typeof x.id === "string" && /^[A-Za-z0-9_-]{1,40}$/.test(x.id) && !cids.has(x.id) ? x.id : newId();
        cids.add(id);
        cl.id = id;
        for (const k of ["created", "updated"]) cl[k] = typeof x[k] === "string" ? x[k].slice(0, 25) : nowIso();
        clips.push(cl);
      }
      const rawPhotos = obj.photos === undefined ? {} : obj.photos;
      if (!rawPhotos || typeof rawPhotos !== "object" || Array.isArray(rawPhotos)) return { ok: false, error: "사진 본체(photos)의 형식이 올바르지 않습니다." };
      const known = new Map(clips.filter(hasBody).map((c) => [c.blob, c]));
      for (const [bid, ph] of Object.entries(rawPhotos)) {
        const cl = known.get(bid);
        if (!cl) return { ok: false, error: "사진 본체 " + bid + " 에 해당하는 보관함 항목이 없습니다." };
        if (!ph || typeof ph !== "object" || typeof ph.data !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(ph.data)) return { ok: false, error: "사진 본체 " + bid + " 의 데이터가 올바르지 않습니다." };
        if (cl.kind === "file") {                                              // 파일: 내용 형식은 다양해 검사할 수 없다 → 크기만 제한하고, 화면에서 열지 않고 내려받기로만 쓴다
          const fb = b64ToBytes(ph.data);
          if (fb.length > C.CLIP_MAX_FILE) return { ok: false, error: "파일 본체 " + bid + " 가 너무 큽니다(2GB 이하)." };
          photos[bid] = { mime: "", bytes: fb };
          continue;
        }
        if (ph.mime !== cl.mime) return { ok: false, error: "사진 본체 " + bid + " 의 형식이 항목과 다릅니다." };
        const bytes = b64ToBytes(ph.data);
        if (bytes.length > C.CLIP_MAX_PHOTO) return { ok: false, error: "사진 본체 " + bid + " 가 너무 큽니다(100MB 이하)." };
        if (sniffImage(bytes) !== ph.mime) return { ok: false, error: "사진 본체 " + bid + " 는 이미지 파일이 아니거나 형식이 다릅니다." };   // 이름만 이미지인 파일(HTML 등)을 걸러낸다
        photos[bid] = { mime: ph.mime, bytes };
      }
    }
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
    return { ok: true, items: out, clips, photos };
  }

  const hasBody = (c) => c.kind === "photo" || c.kind === "file";            // 본체(IndexedDB)를 따로 갖는 종류. 종류를 더할 때 여기만 고친다

  // 업로드·복원되는 바이트의 실제 형식(첫 바이트로 판별). 선언된 mime 은 믿지 않는다. core.py 의 sniff_image 와 같은 규칙.
  function sniffImage(u8) {
    const at = (sig, off) => sig.every((v, i) => u8[(off || 0) + i] === v);
    if (at([0xff, 0xd8, 0xff])) return "image/jpeg";
    if (at([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
    if (at([0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) || at([0x47, 0x49, 0x46, 0x38, 0x39, 0x61])) return "image/gif";
    if (at([0x52, 0x49, 0x46, 0x46]) && at([0x57, 0x45, 0x42, 0x50], 8)) return "image/webp";
    return "";
  }
  function b64ToBytes(b64) {
    if (typeof Buffer !== "undefined") return new Uint8Array(Buffer.from(b64, "base64"));
    const bin = atob(b64), u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return u;
  }
  function bytesToB64(u8) {
    if (typeof Buffer !== "undefined") return Buffer.from(u8).toString("base64");
    let s = "";
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return btoa(s);
  }
  const blobFromBytes = (bytes, mime) => (typeof Blob !== "undefined" ? new Blob([bytes], { type: mime }) : { size: bytes.length, type: mime, _bytes: bytes, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) });

  // ── 사진 본체 저장소 ──
  // 링크·메모는 할 일과 같은 저장소(작은 JSON)에 두지만, 사진 본체는 localStorage(약 5MB 한도)에 넣으면 사진 몇 장에
  // 할 일 저장까지 막히므로 IndexedDB 에 따로 둔다. 테스트에서는 같은 모양의 메모리 저장소를 주입한다.
  // 인터페이스(모두 Promise): put(id, blob), get(id) → Blob|null, del(id), keys() → id[]
  function memoryBlobs() {
    const m = new Map();
    return { kind: "memory", put: async (id, b) => void m.set(id, b), get: async (id) => (m.has(id) ? m.get(id) : null), del: async (id) => void m.delete(id), keys: async () => [...m.keys()], _m: m };
  }
  function idbBlobs(root) {
    const NAME = "taskhub-photos", STORE = "blobs";
    let dbp = null;
    const open = () => dbp || (dbp = new Promise((res, rej) => {
      const r = root.indexedDB.open(NAME, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(STORE);
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(new Error("사진 저장소를 열 수 없습니다. 브라우저가 저장을 막고 있을 수 있습니다."));
      r.onblocked = () => rej(new Error("사진 저장소가 다른 창에서 사용 중입니다."));
    }));
    const tx = async (mode, fn) => {
      const db = await open();
      return new Promise((res, rej) => {
        const t = db.transaction(STORE, mode);
        let out;
        t.oncomplete = () => res(out);
        t.onerror = () => rej(new Error("사진을 저장소에 쓰거나 읽지 못했습니다. 저장 공간이 부족할 수 있습니다."));
        t.onabort = () => rej(new Error("사진 저장이 취소되었습니다. 저장 공간이 부족할 수 있습니다."));
        out = fn(t.objectStore(STORE), (v) => { out = v; });
      });
    };
    return {
      kind: "indexeddb",
      put: (id, b) => tx("readwrite", (st) => void st.put(b, id)),
      get: (id) => tx("readonly", (st, set) => { const q = st.get(id); q.onsuccess = () => set(q.result === undefined ? null : q.result); }),
      del: (id) => tx("readwrite", (st) => void st.delete(id)),
      keys: () => tx("readonly", (st, set) => { const q = st.getAllKeys(); q.onsuccess = () => set(q.result); }),
    };
  }
  function browserBlobs(root) {
    try { if (root.indexedDB) return idbBlobs(root); } catch (e) { /* 사생활 보호 모드 등 */ }
    return memoryBlobs();                                  // 못 쓰면 메모리(새로고침하면 사라짐) — 사진 화면에서 알린다
  }

  function create(opts) {
    const key = (opts && opts.key) || KEY;
    const blobs = (opts && opts.blobs) || memoryBlobs();
    let store = opts && opts.storage;
    let persistent = true;
    let recovered = "";
    if (!store) {
      persistent = false;
      const mem = new Map();
      store = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => void mem.set(k, String(v)), removeItem: (k) => void mem.delete(k) };
    }
    const empty = () => ({ space: SPACE, items: [], inbox: [], log: [], clips: [] });

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
      if (!Array.isArray(d.clips)) d.clips = [];
      return d;
    }
    function save(d) {
      try { store.setItem(key, JSON.stringify(d)); }
      catch (e) { throw new Error("브라우저 저장 공간이 가득 찼거나 저장이 막혀 있어 저장하지 못했습니다. 메뉴의 ‘저장 공간 정리’에서 큰 자료부터 지우거나, 먼저 백업해 두세요."); }
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
        d.clips.forEach((c) => { if (c.item === id) c.item = ""; });                // 연결된 보관함 자료는 지우지 않고 연결만 푼다
        log(d, "delete", id, it.title || "");
      });
    }
    // ── 보관함 ──
    const findClip = (d, id) => {
      const i = d.clips.findIndex((x) => x.id === id);
      if (i < 0) throw new Error(NOT_FOUND);
      return i;
    };
    function addLink(fields) {                               // 링크·메모
      if (fields && (fields.kind === "photo" || fields.kind === "file")) throw new C.ValidationError("사진·파일은 addPhoto / addFile 로 추가합니다.");
      return mutate((d) => {
        const cl = C.normalizeClip(fields || {});
        cl.id = newId();
        cl.created = cl.updated = nowIso();
        d.clips.push(cl);
        log(d, "clip-add", cl.id, cl.title || cl.host || cl.kind);
        return cl;
      });
    }
    // 사진: 본체를 먼저 저장 → 항목 기록. 항목 기록이 실패하면(저장 공간 초과 등) 방금 넣은 본체를 지워 고아가 남지 않게 한다.
    async function addPhoto(blob, meta) {
      if (!blob || typeof blob.size !== "number") throw new C.ValidationError("사진 파일이 필요합니다.");
      const m = meta || {};
      const id = "p-" + newId();
      const fields = Object.assign({}, m, { kind: "photo", blob: id, mime: blob.type || m.mime || "", bytes: blob.size });
      C.normalizeClip(fields);                               // 본체를 쓰기 전에 먼저 검증(잘못된 형식·크기는 저장하지 않는다)
      await ensureRoom(blob.size);
      await blobs.put(id, blob);
      try {
        return mutate((d) => {
          const cl = C.normalizeClip(fields);
          cl.id = newId();
          cl.created = cl.updated = nowIso();
          d.clips.push(cl);
          log(d, "clip-add", cl.id, cl.title || "photo");
          return cl;
        });
      } catch (e) {
        try { await blobs.del(id); } catch (e2) { /* 정리 실패는 아래 orphans 로 나중에 치운다 */ }
        throw e;
      }
    }
    // 파일: 사진과 같은 순서(검증 → 본체 저장 → 항목 기록, 실패하면 본체 삭제). 이름은 정리해서 표시용으로만 보관한다.
    // 브라우저가 이 사이트에 허락한 공간(navigator.storage.estimate). 알 수 없으면 null — 그때는 막지 않고 저장 시도 결과를 따른다.
    async function room() {
      try {
        const est = opts && opts.estimate ? await opts.estimate() : (typeof navigator !== "undefined" && navigator.storage && navigator.storage.estimate ? await navigator.storage.estimate() : null);
        if (!est || typeof est.quota !== "number" || typeof est.usage !== "number") return null;
        return { used: est.usage, quota: est.quota, free: Math.max(0, est.quota - est.usage) };
      } catch (e) { return null; }
    }
    async function ensureRoom(bytes) {
      const r = await room();
      if (r && bytes + 20 * 1024 * 1024 > r.free) throw new C.ValidationError("이 기기에 남은 저장 공간이 부족합니다(남은 공간 약 " + humanBytes(r.free) + "). 메뉴의 ‘저장 공간 정리’에서 큰 자료를 지우고 다시 올리세요.");
    }
    function humanBytes(n) { return n >= 1073741824 ? (n / 1073741824).toFixed(1) + "GB" : n >= 1048576 ? Math.round(n / 1048576) + "MB" : Math.max(1, Math.round(n / 1024)) + "KB"; }
    async function addFile(blob, meta) {
      if (!blob || typeof blob.size !== "number") throw new C.ValidationError("파일이 필요합니다.");
      const m = meta || {};
      const id = "f-" + newId();
      const fields = Object.assign({}, m, { kind: "file", blob: id, bytes: blob.size });
      C.normalizeClip(fields);
      await ensureRoom(blob.size);
      await blobs.put(id, blob);
      try {
        return mutate((d) => {
          const cl = C.normalizeClip(fields);
          cl.id = newId();
          cl.created = cl.updated = nowIso();
          d.clips.push(cl);
          log(d, "clip-add", cl.id, cl.name);
          return cl;
        });
      } catch (e) {
        try { await blobs.del(id); } catch (e2) { /* orphans 로 치운다 */ }
        throw e;
      }
    }
    async function fileBlob(id) {
      const cl = load().clips.find((x) => x.id === id && x.kind === "file");
      if (!cl) throw new Error(NOT_FOUND);
      const b = await blobs.get(cl.blob);
      if (!b) throw new Error("파일을 찾을 수 없습니다. 이 기기에서 지워졌거나 백업에 파일이 포함되지 않았을 수 있습니다.");
      return { blob: b, name: cl.name };
    }
    function updateClip(id, fields) {
      return mutate((d) => {
        const i = findClip(d, id);
        const f = {};
        for (const k of Object.keys(fields || {})) if (!["blob", "mime", "bytes", "w", "h", "kind"].includes(k)) f[k] = fields[k];   // 사진 본체·종류는 바꾸지 않는다
        const before = d.clips[i];
        const cl = C.normalizeClip(f, before);
        cl.id = before.id; cl.created = before.created; cl.updated = nowIso();
        if (cl.pinned && !before.pinned && !("pin_order" in f)) {                        // 새로 고정한 것은 맨 위
          const others = d.clips.filter((x) => x.pinned && x.id !== id).map((x) => x.pin_order || 0);
          cl.pin_order = others.length ? Math.min(...others) - 1 : 0;                   // 현재 맨 위보다 하나 더 위(음수 가능 — 내부 값). 순서를 바꾸면 0부터 다시 매긴다
        }
        if (!cl.pinned) cl.pin_order = 0;
        d.clips[i] = cl;
        log(d, "clip-update", id, Object.keys(fields || {}).sort().join(","));
        return cl;
      });
    }
    // 고정된 항목의 순서를 한 번에 정한다(파이썬 core.reorder_pins 와 같은 규칙). ids: 위에서 아래 순서, 고정된 항목 전부가 정확히 한 번씩.
    function reorderPins(ids) {
      if (!Array.isArray(ids) || !ids.every((x) => typeof x === "string")) throw new C.ValidationError("순서 목록이 올바르지 않습니다.");
      return mutate((d) => {
        const pinned = new Set(d.clips.filter((c) => c.pinned).map((c) => c.id));
        if (new Set(ids).size !== ids.length || ids.length !== pinned.size || !ids.every((x) => pinned.has(x))) throw new C.ValidationError("고정된 항목 전체를 한 번씩 보내야 합니다.");
        const pos = new Map(ids.map((x, n) => [x, n]));
        d.clips.forEach((c) => { if (pos.has(c.id)) c.pin_order = pos.get(c.id); });
        log(d, "clip-reorder", "", ids.length + "개");
        return d.clips.filter((c) => c.pinned).sort(C.pinSortCompare);
      });
    }
    async function deleteClip(id) {
      const removed = mutate((d) => {
        const i = findClip(d, id);
        const [cl] = d.clips.splice(i, 1);
        log(d, "clip-delete", id, cl.title || cl.host || cl.kind);
        return cl;
      });
      if (removed.blob) { try { await blobs.del(removed.blob); } catch (e) { /* 항목은 이미 지워졌다. 남은 본체는 orphans 로 치운다 */ } }
    }
    function listClips(query, item) {
      let out = C.clipFilter(load().clips, query);
      if (item) out = out.filter((c) => c.item === item);
      return out.sort(C.clipSortCompare);
    }
    async function photoBlob(id) {
      const cl = load().clips.find((x) => x.id === id && x.kind === "photo");
      if (!cl) throw new Error(NOT_FOUND);
      const b = await blobs.get(cl.blob);
      if (!b) throw new Error("사진 파일을 찾을 수 없습니다. 이 기기에서 지워졌거나 백업에 사진이 포함되지 않았을 수 있습니다.");
      return b;
    }
    // 항목이 없는 사진 본체(고아)와 본체가 없는 사진 항목(깨진 항목)을 찾는다.
    async function orphans() {
      const have = new Set(await blobs.keys()), used = new Set(load().clips.filter(hasBody).map((c) => c.blob));
      return { blobsWithoutClip: [...have].filter((k) => !used.has(k)), clipsWithoutBlob: load().clips.filter((c) => hasBody(c) && !have.has(c.blob)).map((c) => c.id) };
    }
    async function cleanOrphans() {
      const o = await orphans();
      for (const k of o.blobsWithoutClip) await blobs.del(k);
      return o.blobsWithoutClip.length;
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
        if (head === "clips" && parts.length === 1) return listClips(q.get("q") || "", q.get("item") || "");
      } else if (method === "POST" && head === "clips" && parts.length === 1) return addLink(body || {});
      else if (method === "PUT" && head === "clips" && parts.length === 2 && parts[1] === "reorder") return reorderPins((body || {}).ids);
      else if (method === "PUT" && head === "clips" && parts.length === 2) return updateClip(parts[1], body || {});
      else if (method === "DELETE" && head === "clips" && parts.length === 2) { await deleteClip(parts[1]); return { ok: true }; }
      else if (method === "POST" && head === "items") return addItem(body || {});
      else if (method === "PUT" && head === "item" && parts.length === 2) return updateItem(parts[1], body || {});
      else if (method === "DELETE" && head === "item" && parts.length === 2) { deleteItem(parts[1]); return { ok: true }; }
      throw new Error("지원하지 않는 요청입니다.");
    }

    // ── 백업·복원 ──
    function stats() { const d = load(); return { count: d.items.length, clips: d.clips.length, persistent, recovered }; }
    // 저장 공간: 보관함 본체 합계 + 브라우저가 허락한 전체/사용량. low = 80% 이상 찼거나 남은 공간이 200MB 미만(정리를 권할 때)
    async function storage() {
      const d = load(), files = d.clips.reduce((n, c) => n + (hasBody(c) && Number.isInteger(c.bytes) ? c.bytes : 0), 0);
      const r = await room();
      const used = r ? r.used : files, total = r ? r.quota : 0;
      return { used, files, clips: d.clips.length, free: r ? r.free : 0, total, known: !!r, low: !!r && (r.used / r.quota >= 0.8 || r.free < 200 * 1024 * 1024) };
    }
    // 정리용 목록: 본체가 큰 순서. ids 로 여러 개를 한 번에 지운다(되돌릴 수 없음 — 화면에서 확인을 받는다)
    async function deleteMany(ids) {
      let n = 0;
      for (const id of ids) { try { await deleteClip(id); n++; } catch (e) { /* 이미 없는 것은 건너뛴다 */ } }
      return n;
    }
    // 백업: 기본은 할 일·링크·메모·사진 *정보*만(작다). withPhotos 면 사진 본체까지 base64 로 넣는다(파일이 커진다).
    // 본체가 빠진 사진 수를 파일에 적어 둔다 → 복원할 때 ‘사진 N장은 본체가 없다’고 알릴 수 있다.
    async function exportData(o) {
      const d = load(), withPhotos = !!(o && o.withPhotos);
      const out = { app: "taskhub", format: 2, exported: nowIso(), space: SPACE, items: d.items, clips: d.clips, inbox: [], log: [] };
      const photos = {};
      let missing = 0;
      for (const c of d.clips.filter(hasBody)) {
        if (!withPhotos) { missing++; continue; }
        const b = await blobs.get(c.blob);
        if (!b) { missing++; continue; }
        const buf = typeof b.arrayBuffer === "function" ? new Uint8Array(await b.arrayBuffer()) : b._bytes;
        photos[c.blob] = { mime: c.mime || "", data: bytesToB64(buf) };
      }
      if (withPhotos) out.photos = photos;
      out.counts = { items: d.items.length, clips: d.clips.length, photos: d.clips.filter(hasBody).length, photosWithoutData: missing };
      return out;
    }
    // 복원. 사진 본체(JSON 과 다른 저장소)는 새 이름으로 먼저 모두 쓰고 → JSON 을 저장한다. JSON 저장이 실패하면 방금 쓴 본체를 지우고
    // 기존 데이터는 그대로 둔다. 옛 사진 본체는 즉시 지우지 않는다: ‘복원 취소’가 JSON 을 되돌려도 본체는 되돌릴 수 없기 때문이다.
    async function replaceAll(items, clips, photos) {
      const cur = store.getItem(key);
      try { store.setItem(key + ".prev", cur !== null ? cur : JSON.stringify(empty())); }
      catch (e) { throw new Error("복원 전 현재 데이터를 보관하지 못해 중단했습니다. 저장 공간을 확인하세요."); }
      const written = [];
      try {
        for (const [bid, ph] of Object.entries(photos || {})) {
          if ((await blobs.keys()).includes(bid)) continue;                          // 이미 있는 본체(같은 번호)는 그대로 둔다
          await blobs.put(bid, blobFromBytes(ph.bytes, ph.mime));
          written.push(bid);
        }
        const d = empty();
        d.items = items;
        d.clips = clips === null || clips === undefined ? load().clips : clips;      // 보관함 정보가 없는 옛 백업이면 현재 보관함을 그대로 둔다
        log(d, "import", "", items.length + "건" + (clips ? ", 보관함 " + clips.length + "건" : ""));
        save(d);
      } catch (e) {
        // JSON 은 되돌리지 않는다: 실패한 localStorage.setItem 은 기존 값을 그대로 둔다(이 브라우저에서 한도 초과로 확인, 테스트로 고정).
        // 따라서 여기서 할 일은 방금 새로 쓴 사진 본체를 지워 고아를 남기지 않는 것뿐이다.
        for (const bid of written) { try { await blobs.del(bid); } catch (e2) { /* 남아도 orphans 로 치운다 */ } }
        throw e;
      }
    }
    function hasPrev() { return store.getItem(key + ".prev") !== null; }
    function restorePrev() {
      const p = store.getItem(key + ".prev");
      if (p === null) throw new Error("되돌릴 데이터가 없습니다.");
      store.setItem(key, p);
      store.removeItem(key + ".prev");
    }

    return { handle, addItem, updateItem, deleteItem, view, counts, stats, exportData, replaceAll, hasPrev, restorePrev, sanitizeImport, key,
      addLink, addPhoto, addFile, fileBlob, updateClip, deleteClip, listClips, photoBlob, orphans, cleanOrphans, blobs, storage, deleteMany, room, reorderPins };
  }

  return { create, browserStorage, browserBlobs, memoryBlobs, sanitizeImport, KEY };
});
