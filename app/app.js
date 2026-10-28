/* TaskHub 화면. 외부 라이브러리 없음.
   보안: 사용자/외부 텍스트는 innerHTML 로 넣지 않고 textContent 로만 넣는다(el() 헬퍼). */
"use strict";

const PERIODS = [
  ["today", "오늘"], ["week", "이번 주"], ["month", "이번 달"], ["year", "올해"],
  ["undated", "기한 없음"], ["done", "완료"],
];
const SPACE_LABEL = { work: "업무", personal: "개인" };
/* 실행 방식: 서버판(PC, 기본)과 로컬판(폰 개인용, index.html 이 window.TH_CONFIG={local:true,...} 를 먼저 선언).
   화면 코드는 하나를 같이 쓰고, 서버와 대화하는 api() 한 곳만 갈아 끼운다. */
const CFG = window.TH_CONFIG || {};
const LOCAL = !!CFG.local;
const state = { space: CFG.space || "work", period: "today", view: "list", q: "", meta: null, counts: {}, items: [], inbox: [], editing: null };
const store = { get(k, d) { try { return localStorage.getItem(k) ?? d; } catch (e) { return d; } }, set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* 저장소 사용 불가 시 무시 */ } } };

function el(tag, attrs, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v == null) continue;
    if (k === "class") n.className = v;
    else if (k === "text") n.textContent = v;
    else if (k.startsWith("on") && typeof v === "function") n.addEventListener(k.slice(2), v);
    else if (v === true) n.setAttribute(k, "");
    else n.setAttribute(k, v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) n.append(c.nodeType ? c : document.createTextNode(String(c)));
  return n;
}
const $ = (id) => document.getElementById(id);

async function api(method, path, body) {
  if (LOCAL) {                       // 폰 개인용: 서버 없이 브라우저 안 저장소를 쓴다
    try { return await window.THLocal.handle(method, path, body); }
    catch (e) { throw new Error(e && e.message ? e.message : "처리하지 못했습니다."); }
  }
  const sep = path.includes("?") ? "&" : "?";
  let res;
  try {
    // 서버는 쓰기 요청(POST/PUT/DELETE)에 JSON Content-Type 을 요구한다(CSRF 방어).
    // DELETE 처럼 본문이 없어도 헤더는 항상 보내야 한다.
    const write = method !== "GET";
    res = await fetch(`/api/${path}${sep}space=${state.space}`, {
      method, headers: write ? { "Content-Type": "application/json" } : {}, body: write ? JSON.stringify(body || {}) : undefined,
    });
  } catch (e) {
    throw new Error("서버에 연결할 수 없습니다. 터미널에서 서버가 실행 중인지 확인하세요.");
  }
  let data = null;
  try { data = await res.json(); } catch (e) { /* 본문 없음 */ }
  if (!res.ok) throw new Error((data && data.error) || `요청 실패 (${res.status})`);
  return data;
}

function toast(msg) {
  const t = $("toast"); t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), 2600);
}
function banner(msg, isErr) {
  const b = $("banner"); b.textContent = msg || ""; b.hidden = !msg; b.classList.toggle("err", !!isErr);
}

/* ───────── 날짜 표시 ───────── */
function fmtDue(it) {
  const a = it.start, b = it.due;
  if (a && b && a !== b) return `${a.slice(5)} ~ ${b.slice(5)}`;
  return (b || a || "").slice(5) || "";
}
function dday(it) {
  const d = it.due || it.start; if (!d || !state.meta) return "";
  const t0 = new Date(state.meta.today + "T00:00:00"), t1 = new Date(d + "T00:00:00");
  const n = Math.round((t1 - t0) / 86400000);
  return n === 0 ? "D-Day" : n > 0 ? `D-${n}` : `D+${-n}`;
}

/* ───────── 헤더 ───────── */
function renderHeader() {
  const sp = $("spaces"); sp.replaceChildren(...state.meta.spaces.map((s) =>
    el("button", { role: "tab", "aria-selected": String(s === state.space), class: s === state.space ? "on" : "", onclick: () => switchSpace(s), text: SPACE_LABEL[s] || s })));
  const pr = $("periods"); pr.replaceChildren(...PERIODS.map(([k, label]) => {
    const n = state.counts[k], warn = k === "today" && state.counts.overdue > 0;
    return el("button", { role: "tab", "aria-selected": String(k === state.period), class: k === state.period ? "on" : "", onclick: () => setPeriod(k) },
      label, n != null ? el("span", { class: "n" + (warn ? " warn" : ""), text: String(n) }) : null);
  }));
  document.querySelectorAll("#viewMode button").forEach((b) => b.classList.toggle("on", b.dataset.v === state.view));
  const on = pr.querySelector(".on");                       // 좁은 화면에서 선택한 탭이 가려지지 않게 한다
  if (on && on.scrollIntoView) { try { on.scrollIntoView({ inline: "center", block: "nearest" }); } catch (e) { /* 구형 브라우저 */ } }
  updateTabHint();
}
function updateTabHint() {
  const pr = $("periods");
  pr.classList.toggle("more", pr.scrollWidth - pr.clientWidth - pr.scrollLeft > 4);   // 오른쪽에 더 볼 탭이 있을 때만
}

/* ───────── 카드/목록/보드 ───────── */
function card(it, draggable) {
  const prog = it._progress;
  const c = el("div", { class: "card", tabindex: "0", role: "button", draggable: draggable ? "true" : false,
    onclick: () => openForm(it), onkeydown: (e) => { if (e.key === "Enter") openForm(it); } },
    el("div", { class: "row1" },
      el("div", { class: "title", text: it.title }),
      it.priority !== "보통" ? el("span", { class: "chip " + it.priority, text: it.priority }) : null),
    it.summary ? el("div", { class: "sum", text: it.summary }) : null,
    el("div", { class: "meta" },
      it.domain ? el("span", { class: "chip dom", text: it.domain }) : null,
      it.due || it.start ? el("span", { text: fmtDue(it) }) : null,
      it._overdue ? el("span", { class: "chip overdue", text: "기한 초과 " + dday(it) }) : (it.due ? el("span", { text: dday(it) }) : null),
      el("span", { class: "chip " + (it.status === "완료" ? "완료" : ""), text: it.status }),
      it.repeat ? el("span", { text: "↻ " + it.repeat }) : null,
      prog != null ? el("span", {}, el("span", { class: "bar" }, el("i", { style: `width:${prog}%` })), " " + prog + "%") : null,
      (it.people || []).length ? el("span", { text: "👤 " + it.people.slice(0, 3).join(", ") + (it.people.length > 3 ? " 외" : "") }) : null));
  if (draggable) {
    c.addEventListener("dragstart", (e) => { e.dataTransfer.setData("text/plain", it.id); e.dataTransfer.effectAllowed = "move"; });
  }
  return c;
}

function visibleItems() {
  const q = state.q.trim().toLowerCase();
  if (!q) return state.items;
  return state.items.filter((it) => [it.title, it.summary, it.detail, it.domain, (it.people || []).join(" "), (it.tags || []).join(" "), it.result].join(" ").toLowerCase().includes(q));
}

function renderList(items) {
  // 도메인별로 묶는다. 도메인이 없으면 '미분류'.
  const groups = new Map();
  for (const it of items) { const k = it.domain || "미분류"; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(it); }
  return [...groups.entries()].map(([k, arr]) =>
    el("section", { class: "group" }, el("h3", {}, k, el("span", { class: "cnt", text: String(arr.length) })), arr.map((it) => card(it, false))));
}

function renderBoard(items) {
  const cols = state.meta.statuses.filter((s) => s !== "취소");
  return el("div", { class: "board" }, cols.map((s) => {
    const arr = items.filter((it) => it.status === s);
    const col = el("div", { class: "col" + (arr.length ? "" : " empty-col") }, el("h3", {}, s, " ", el("span", { class: "cnt", text: String(arr.length) })), arr.map((it) => card(it, true)));
    col.addEventListener("dragover", (e) => { e.preventDefault(); col.classList.add("over"); });
    col.addEventListener("dragleave", () => col.classList.remove("over"));
    col.addEventListener("drop", async (e) => {
      e.preventDefault(); col.classList.remove("over");
      const id = e.dataTransfer.getData("text/plain"); if (!id) return;
      try { await changeStatus(id, s); } catch (err) { banner(err.message, true); }
    });
    return col;
  }));
}

function renderMain() {
  const items = visibleItems(); const m = $("main");
  if (!items.length) {
    const msg = state.q ? "검색 결과가 없습니다." : state.period === "today" ? "오늘 처리할 과제가 없습니다." : "표시할 과제가 없습니다.";
    m.replaceChildren(el("div", { class: "empty" }, el("b", { text: msg }), LOCAL ? "‘+ 새 과제’로 추가하세요." : "‘+ 새 과제’로 추가하거나 오른쪽 제안함에서 가져오세요."));
    return;
  }
  m.replaceChildren(...(state.view === "board" ? [renderBoard(items)] : renderList(items)));
}

/* ───────── 제안함 ───────── */
function renderInbox() {
  const box = $("inbox"); const layout = document.querySelector(".layout");
  layout.classList.toggle("no-inbox", !state.inbox.length);
  box.hidden = !state.inbox.length; if (!state.inbox.length) return;
  box.replaceChildren(
    el("h3", { text: `제안함 (${state.inbox.length})` }),
    el("p", { class: "hint", text: "다른 곳에서 가져온 후보입니다. 수락해야 내 과제가 됩니다." }),
    ...state.inbox.map((x) => el("div", { class: "it" },
      el("div", { class: "t", text: x.title }),
      el("div", { class: "s", text: [x.source, x.ref, x.due && "기한 " + x.due].filter(Boolean).join(" · ") }),
      el("div", { class: "b" },
        el("button", { class: "btn primary", onclick: async () => { try { await api("POST", `inbox/${x.id}/accept`, {}); toast("과제로 추가했습니다."); await refresh(); } catch (e) { banner(e.message, true); } }, text: "수락" }),
        el("button", { class: "btn", onclick: async () => { try { await api("POST", `inbox/${x.id}/dismiss`, {}); await refresh(); } catch (e) { banner(e.message, true); } }, text: "무시" })))));
}

/* ───────── 데이터 새로고침 ───────── */
async function refresh() {
  try {
    const [counts, items, inbox] = await Promise.all([api("GET", "counts"), api("GET", `items?period=${state.period}`), api("GET", "inbox")]);
    Object.assign(state, { counts, items, inbox }); banner("");
  } catch (e) { banner(e.message, true); }
  renderHeader(); renderMain(); renderInbox();
}
async function changeStatus(id, status) {
  const r = await api("PUT", `item/${id}`, { status });
  if (r.spawned) toast(`반복 과제: 다음 회차(${r.spawned.due})를 만들었습니다.`);
  await refresh();
}
function setPeriod(p) { state.period = p; store.set("th.period", p); refresh(); }
function switchSpace(s) { state.space = s; store.set("th.space", s); refresh(); }

/* ───────── 편집 폼 ───────── */
function field(label, input, opts = {}) {
  return el("div", { class: "f" + (opts.full ? " full" : "") }, el("label", { text: label, for: input.id }), input, opts.help ? el("div", { class: "help", text: opts.help }) : null);
}
function inp(id, type, value, attrs) { return el("input", Object.assign({ id, type, value: value || "" }, attrs)); }
function sel(id, options, value) { return el("select", { id }, options.map((o) => el("option", { value: o, selected: o === value, text: o || "(없음)" }))); }
function ta(id, value, rows) { const t = el("textarea", { id, rows: String(rows || 3) }); t.value = value || ""; return t; }

function actRow(a) {
  const row = el("div", { class: "act" },
    el("input", { type: "checkbox", checked: !!a.done, "aria-label": "완료" }),
    el("input", { type: "text", value: a.text || "", placeholder: "해야 할 일" }),
    el("input", { type: "date", value: a.due || "", "aria-label": "기한" }),
    el("button", { type: "button", class: "rm", "aria-label": "삭제", text: "×", onclick: () => row.remove() }));
  return row;
}

function openForm(it) {
  state.editing = it || null;
  const isNew = !it; it = it || { status: "미착수", priority: "보통", base_date: state.meta.today, actions: [], people: [], tags: [], links: [], repeat: "" };
  $("formTitle").textContent = isNew ? "새 과제" : "과제 편집";
  $("btnDelete").hidden = isNew; $("formMsg").textContent = "";
  const actsBox = el("div", { class: "acts", id: "f_acts" }, (it.actions || []).map(actRow));
  const body = $("formBody");
  body.replaceChildren(
    el("div", { class: "f full" }, el("label", { for: "f_title", text: "과제명" }), inp("f_title", "text", it.title, { required: true, maxlength: "200" })),
    field("기준일자", inp("f_base_date", "date", it.base_date), { help: "이 정보를 작성/확인한 날짜" }),
    field("도메인", inp("f_domain", "text", it.domain, { list: "dl_domain", placeholder: CFG.domainHint || "예: 업무 영역 이름" })),
    field("상태", sel("f_status", state.meta.statuses, it.status)),
    field("우선순위", sel("f_priority", state.meta.priorities, it.priority)),
    field("시작일", inp("f_start", "date", it.start)),
    field("기한", inp("f_due", "date", it.due)),
    field("반복", sel("f_repeat", state.meta.repeats, it.repeat), { help: "완료하면 다음 회차가 자동 생성됩니다" }),
    field("관련인물", inp("f_people", "text", (it.people || []).join(", "), { placeholder: "쉼표로 구분" })),
    field("개요", ta("f_summary", it.summary, 2), { full: true }),
    field("세부사항", ta("f_detail", it.detail, 4), { full: true }),
    el("div", { class: "f full" }, el("label", { text: "액션플랜" }), actsBox,
      el("div", {}, el("button", { type: "button", class: "btn", text: "+ 항목 추가", onclick: () => actsBox.append(actRow({})) }))),
    field("기획서", ta("f_doc", it.doc, 2), { full: true, help: "문서 링크나 파일명" }),
    field("결과", ta("f_result", it.result, 3), { full: true }),
    field("태그", inp("f_tags", "text", (it.tags || []).join(", ")), {}),
    field("링크", inp("f_links", "text", (it.links || []).join(", ")), { help: "관련 문서·페이지 주소" }),
    it.source ? el("div", { class: "f full help" }, "출처: " + it.source + (it.ref ? " · " + it.ref : "")) : null);
  const dl = $("dl_domain") || el("datalist", { id: "dl_domain" });
  dl.replaceChildren(...[...new Set(state.items.map((x) => x.domain).filter(Boolean))].map((d) => el("option", { value: d })));
  if (!dl.parentNode) document.body.append(dl);
  $("drawer").hidden = false; document.body.classList.add("form-open"); $("f_title").focus();
}
function closeForm() { $("drawer").hidden = true; document.body.classList.remove("form-open"); state.editing = null; }

function readForm() {
  const v = (id) => $(id).value;
  const acts = [...document.querySelectorAll("#f_acts .act")].map((r) => {
    const [cb, tx, dd] = r.querySelectorAll("input");
    return { text: tx.value, done: cb.checked, due: dd.value };
  }).filter((a) => a.text.trim());
  return { title: v("f_title"), base_date: v("f_base_date"), domain: v("f_domain"), status: v("f_status"), priority: v("f_priority"),
    start: v("f_start"), due: v("f_due"), repeat: v("f_repeat"), people: v("f_people"), summary: v("f_summary"), detail: v("f_detail"),
    actions: acts, doc: v("f_doc"), result: v("f_result"), tags: v("f_tags"), links: v("f_links") };
}

async function submitForm(e) {
  e.preventDefault();
  const body = readForm(); $("formMsg").textContent = "";
  try {
    if (state.editing) {
      const r = await api("PUT", `item/${state.editing.id}`, body);
      if (r.spawned) toast(`반복 과제: 다음 회차(${r.spawned.due})를 만들었습니다.`); else toast("저장했습니다.");
    } else { await api("POST", "items", body); toast("추가했습니다."); }
    closeForm(); await refresh();
  } catch (err) { $("formMsg").textContent = err.message; }   // 폼을 닫지 않고 입력을 보존한다
}
async function deleteItem() {
  if (!state.editing || !confirm(`‘${state.editing.title}’ 을(를) 삭제할까요? 되돌릴 수 없습니다.`)) return;
  try { await api("DELETE", `item/${state.editing.id}`); toast("삭제했습니다."); closeForm(); await refresh(); }
  catch (err) { $("formMsg").textContent = err.message; }
}

/* ───────── 주간보고 ───────── */
async function showReport() {
  if (LOCAL) { await showBackup(); return; }          // 폰 개인용에서는 같은 자리가 '백업' 버튼
  try {
    const r = await api("GET", "report");
    openModal("주간보고 문안 (복사해서 붙여 넣기)", r.text, true);
  } catch (e) { banner(e.message, true); }
}
function openModal(title, content, copyable) {
  $("modalTitle").textContent = title;
  const box = $("modalText");
  box.classList.toggle("plain", typeof content !== "string");      // 위젯이면 <pre> 서식 해제
  if (typeof content === "string") box.textContent = content; else box.replaceChildren(content);
  $("modalCopy").hidden = !copyable;
  $("modal").hidden = false;
}

/* 앱 버전 표시: build_phone.py 가 만든 version.js 가 있을 때만(폰 판) */
function versionLine() {
  const v = window.TH_VERSION;
  if (!v) return null;
  const when = v.date ? ` · ${v.date}` : "";
  return el("p", { class: "help ver", text: `내 할일 v${v.version} (빌드 ${v.build}${when})` });
}

/* ───────── 백업·복원 (폰 개인용 전용) ───────── */
function fileStamp() { const n = new Date(), p = (x) => String(x).padStart(2, "0"); return `${n.getFullYear()}${p(n.getMonth() + 1)}${p(n.getDate())}_${p(n.getHours())}${p(n.getMinutes())}`; }
async function showBackup() {
  const L = window.THLocal, st = L.stats();
  const msg = el("div", { class: "help", role: "status" });
  const fileIn = el("input", { type: "file", accept: "application/json,.json", hidden: true, id: "restoreFile" });
  const note = (t, bad) => { msg.textContent = t; msg.style.color = bad ? "var(--red)" : "var(--green)"; };
  const body = el("div", { class: "backup" },
    el("p", {}, `저장된 과제: ${st.count}건`),
    st.persistent ? null : el("p", { class: "banner err", text: "이 브라우저는 저장을 막고 있어 새로고침하면 데이터가 사라집니다. 일반 모드(비공개 모드 아님)로 여세요." }),
    st.recovered ? el("p", { class: "banner", text: "저장된 데이터가 손상돼 복구용 사본을 남기고 새로 시작했습니다." }) : null,
    el("p", { class: "help", text: "데이터는 이 폰의 브라우저에만 있습니다. 폰을 바꾸거나 브라우저 데이터를 지우면 사라지므로, 정기적으로 파일로 저장해 두세요." }),
    el("div", { class: "row-btns" },
      el("button", { class: "btn primary", type: "button", text: "백업 파일 저장", onclick: () => {
        try {
          const blob = new Blob([JSON.stringify(L.exportData(), null, 2)], { type: "application/json" });
          const a = el("a", { href: URL.createObjectURL(blob), download: `taskhub_personal_${fileStamp()}.json` });
          document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
          note("백업 파일을 저장했습니다. 파일 앱/다운로드에서 확인하세요.");
        } catch (e) { note("백업하지 못했습니다: " + e.message, true); }
      } }),
      el("button", { class: "btn", type: "button", text: "백업에서 복원", onclick: () => fileIn.click() }),
      L.hasPrev() ? el("button", { class: "btn", type: "button", text: "복원 취소(직전 상태로)", onclick: async () => {
        if (!confirm("방금 복원하기 전 상태로 되돌릴까요?")) return;
        try { L.restorePrev(); note("직전 상태로 되돌렸습니다."); await refresh(); } catch (e) { note(e.message, true); }
      } }) : null),
    msg, fileIn, versionLine());
  fileIn.addEventListener("change", async () => {
    const f = fileIn.files && fileIn.files[0]; if (!f) return;
    if (f.size > 5_000_000) { note("파일이 너무 큽니다(5MB 초과).", true); return; }
    const parsed = L.sanitizeImport(await f.text());
    if (!parsed.ok) { note("복원하지 못했습니다: " + parsed.error, true); return; }
    if (!confirm(`백업 파일의 과제 ${parsed.items.length}건으로 현재 ${L.stats().count}건을 바꿉니다.\n(바꾸기 전 상태는 ‘복원 취소’로 되돌릴 수 있습니다.)`)) return;
    try { L.replaceAll(parsed.items); note(`${parsed.items.length}건을 복원했습니다.`); await refresh(); }
    catch (e) { note(e.message, true); }
    fileIn.value = "";
  });
  openModal("백업 / 복원", body, false);
}

/* ───────── 초기화 ───────── */
async function init() {
  state.space = store.get("th.space", "work"); state.period = store.get("th.period", "today"); state.view = store.get("th.view", "list");
  try { state.meta = await api("GET", "meta"); }
  catch (e) { banner(e.message, true); return; }
  if (!state.meta.spaces.includes(state.space)) state.space = "work";
  if (!PERIODS.some(([k]) => k === state.period)) state.period = "today";
  if (LOCAL) {
    $("btnReport").textContent = "백업";
    $("btnReport").title = "데이터를 파일로 저장하거나 복원";
    $("spaces").hidden = true;                      // 폰 앱은 개인 공간 하나뿐
    document.title = CFG.title || "TaskHub 개인";
  }
  $("btnNew").onclick = () => openForm(null);
  $("btnReport").onclick = showReport;
  $("form").addEventListener("submit", submitForm);
  $("btnClose").onclick = $("btnCancel").onclick = $("drawerBg").onclick = closeForm;
  $("btnDelete").onclick = deleteItem;
  $("modalClose").onclick = () => ($("modal").hidden = true);
  $("modalCopy").onclick = async () => { try { await navigator.clipboard.writeText($("modalText").textContent); toast("복사했습니다."); } catch (e) { toast("복사하지 못했습니다. 직접 선택해 복사하세요."); } };
  $("viewMode").addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; state.view = b.dataset.v; store.set("th.view", state.view); renderHeader(); renderMain(); });
  $("search").addEventListener("input", (e) => { state.q = e.target.value; renderMain(); });
  $("periods").addEventListener("scroll", updateTabHint, { passive: true });
  window.addEventListener("resize", updateTabHint);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { if (!$("modal").hidden) $("modal").hidden = true; else if (!$("drawer").hidden) closeForm(); }
    if (e.key === "n" && !e.metaKey && !e.ctrlKey && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName) && $("drawer").hidden) { e.preventDefault(); openForm(null); }
  });
  if (LOCAL && navigator.storage && navigator.storage.persist) { try { await navigator.storage.persist(); } catch (e) { /* 지원 안 하면 무시 */ } }
  await refresh();
}
init();
