/* 업투두(PC) · 내투두(폰·PC) 화면.
   같은 코드를 두 앱이 함께 쓴다. 서버와 대화하는 api() 한 곳만 서버(업투두) / 브라우저 저장소(내투두)로 갈린다.
   화면: 왼쪽 달력 · 오른쪽 목록/상세(한 창). 좁은 화면에서는 위아래로 쌓고, 상세는 화면 전체를 덮는다.
   보안: 사용자/외부 텍스트는 innerHTML 로 넣지 않고 textContent 로만 넣는다(el() 헬퍼). 외부 라이브러리 없음. */
"use strict";

const CFG = window.TH_CONFIG || {};
const LOCAL = !!CFG.local;
const APP_NAME = CFG.title || "업투두";
const DONE = ["완료", "취소"];
const DOW = ["월", "화", "수", "목", "금", "토", "일"];
const VIEWS = [["list", "목록"], ["board", "보드"]];
const PRI = { "긴급": 0, "높음": 1, "보통": 2, "낮음": 3 };
const MAX_DONE_IN_BOARD = 15;
const state = {
  space: CFG.space || "work", meta: null, items: [], inbox: [],
  page: "tasks",                     // tasks(할 일) | clips(보관함)
  clips: [], clipKind: "all", clipTag: "", clipMonth: "", clipLayout: "history", clipDetail: null,       // 보관함 목록·필터·열린 항목(null | {id|null})
  tab: "now",                        // 목록 위 탭: now(지금) | overdue | later | done. 저장하지 않아 앱을 열 때마다 ‘지금’ 으로 시작한다
  view: "list",                      // list | board
  day: "",                           // 달력에서 고른 날짜(빈 값 = 전체). 목록이 그 날짜로 좁혀진다
  q: "", cal: { y: 0, m: 0 },
  detail: null,                      // null = 목록, { id|null, preset, snap } = 상세(새 과제는 id 가 null)
  expanded: new Set(),               // ‘더 보기’ 로 펼친 구간(새로고침하면 처음 상태로)
  density: "roomy",                  // 목록 간격: roomy(개요 두 줄) | tight(제목+한 줄 요약, 한 화면에 더 많이)
};
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
  if (LOCAL) {                       // 내투두: 서버 없이 브라우저 안 저장소를 쓴다
    try { return await window.THLocal.handle(method, path, body); }
    catch (e) { throw new Error(e && e.message ? e.message : "처리하지 못했습니다."); }
  }
  const sep = path.includes("?") ? "&" : "?";
  let res;
  try {
    // 서버는 쓰기 요청(POST/PUT/DELETE)에 JSON Content-Type 을 요구한다(CSRF 방어). 본문 없는 DELETE 도 헤더는 항상 보낸다.
    const write = method !== "GET";
    res = await fetch(`/api/${path}${sep}space=${state.space}`, {
      method, headers: write ? { "Content-Type": "application/json" } : {}, body: write ? JSON.stringify(body || {}) : undefined,
    });
  } catch (e) {
    throw new Error("서버에 연결할 수 없습니다. 업투두 실행 창(터미널)이 켜져 있는지 확인하세요.");
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
function banner(msg, isErr, kind) {                                            // kind: "conn" = 연결 오류(새로고침이 성공하면 사라진다). 그 밖의 안내는 사용자가 볼 수 있게 남는다
  const x = $("banner"); x.textContent = msg || ""; x.hidden = !msg; x.classList.toggle("err", !!isErr); x.dataset.kind = msg ? (kind || "") : "";
  clearTimeout(banner._t);
  if (msg && kind !== "conn") banner._t = setTimeout(() => { if (x.dataset.kind !== "conn") { x.hidden = true; x.textContent = ""; } }, 8000);
}
function clearConnBanner() { const x = $("banner"); if (x.dataset.kind === "conn") banner(""); }

/* ───────── 날짜·시각 ───────── */
const pad2 = (n) => String(n).padStart(2, "0");
const isoOf = (y, m, d) => `${y}-${pad2(m)}-${pad2(d)}`;
function localIso(d) { return isoOf(d.getFullYear(), d.getMonth() + 1, d.getDate()); }
function todayIso() { return state.meta ? state.meta.today : localIso(new Date()); }
function dayDiff(a, b) { return Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86400000); }
function dowOf(iso) { return (new Date(iso + "T00:00:00Z").getUTCDay() + 6) % 7; }          // 월=0 … 일=6
function relDay(iso) {
  const n = dayDiff(todayIso(), iso);
  return n === 0 ? "오늘" : n === 1 ? "내일" : n === -1 ? "어제" : n > 0 ? `${n}일 후` : `${-n}일 전`;
}
function dayTitle(iso) { return `${+iso.slice(5, 7)}월 ${+iso.slice(8)}일 ${DOW[dowOf(iso)]}요일`; }
function fmtTime(t) { const [h, m] = t.split(":").map(Number); return `${h < 12 ? "오전" : "오후"} ${h % 12 || 12}:${pad2(m)}`; }
function fmtRange(it) {
  if (!it.time) return "";
  if (!it.end_time) return fmtTime(it.time);
  const a = fmtTime(it.time), b = fmtTime(it.end_time);
  return a.slice(0, 2) === b.slice(0, 2) ? `${a}–${b.slice(3)}` : `${a} – ${b}`;      // 같은 오전/오후면 뒤쪽 접두어 생략
}

/* 월 격자(월요일 시작, 6주 42칸). core.py/core.js 의 month_grid 와 같은 규칙이며 tests/vectors.json 으로 검증한다. */
function monthCells(y, m) {
  const first = new Date(Date.UTC(y, m - 1, 1)), lead = (first.getUTCDay() + 6) % 7, cells = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(Date.UTC(y, m - 1, 1 - lead + i));
    cells.push({ date: isoOf(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()), inMonth: d.getUTCMonth() === m - 1, day: d.getUTCDate() });
  }
  return cells;
}
/* 날짜별 과제: 완료·취소 제외, 시작~기한 모든 날, 기한 없음 제외 */
function byDay(items, cells) {
  const lo = cells[0].date, hi = cells[41].date, out = {};
  for (const it of items) {
    if (it.status === "완료" || it.status === "취소") continue;
    const s = it.start || it.due, e = it.due || it.start;
    if (!s || e < lo || s > hi) continue;
    const a = new Date((s < lo ? lo : s) + "T00:00:00Z"), z = new Date((e > hi ? hi : e) + "T00:00:00Z");
    for (let t = a; t <= z; t = new Date(t.getTime() + 86400000)) (out[t.toISOString().slice(0, 10)] = out[t.toISOString().slice(0, 10)] || []).push(it);
  }
  return out;
}

/* ───────── 과제 판정·정렬 ───────── */
const isDone = (it) => DONE.includes(it.status);
const endOf = (it) => it.due || it.start || "";
const isOverdue = (it) => !isDone(it) && !!endOf(it) && endOf(it) < todayIso();
const isUndated = (it) => !isDone(it) && !it.start && !it.due;
function cmpDay(a, b) {              // 같은 날 목록: 시각 있는 것 먼저(빠른 순) → 우선순위 → 제목
  const ta = a.time || "99:99", tb = b.time || "99:99";
  if (ta !== tb) return ta < tb ? -1 : 1;
  const pa = PRI[a.priority] ?? 2, pb = PRI[b.priority] ?? 2;
  if (pa !== pb) return pa - pb;
  return (a.title || "").localeCompare(b.title || "", "ko");
}
function cmpAny(a, b) {              // 날짜가 빠른 순(없으면 뒤) → cmpDay
  const ea = endOf(a) || "9999", eb = endOf(b) || "9999";
  return ea !== eb ? (ea < eb ? -1 : 1) : cmpDay(a, b);
}
function matchQuery(items) {         // 목록·보드·달력이 같은 검색 규칙을 쓴다
  const q = state.q.trim().toLowerCase();
  if (!q) return items;
  return items.filter((it) => [it.title, it.summary, it.detail, it.domain, (it.people || []).join(" "), (it.tags || []).join(" "), it.result].join(" ").toLowerCase().includes(q));
}

/* ───────── 화면 뼈대·메뉴 ───────── */
function buildShell() {
  $("app").replaceChildren(
    el("header", { class: "top" },
      el("div", { class: "brand", text: APP_NAME }),
      el("input", { id: "search", type: "search", placeholder: "검색", "aria-label": "검색", autocomplete: "off" }),
      el("div", { class: "spacer" }),
      el("button", { class: "btn primary", id: "btnNew", type: "button", text: "＋ 새 할 일" }),
      el("div", { class: "menu-wrap" },
        el("button", { class: "ib", id: "btnMenu", type: "button", "aria-label": "메뉴", "aria-haspopup": "menu", "aria-expanded": "false", text: "⋯" }),
        el("div", { class: "menu", id: "menu", role: "menu", hidden: true },
          el("div", { class: "menu-label", text: "보기" }),
          el("div", { class: "seg", id: "viewMode", role: "group", "aria-label": "보기 방식" }, VIEWS.map(([k, label]) => el("button", { type: "button", "data-v": k, text: label }))),
          el("div", { class: "menu-label", text: "목록 간격" }),
          el("div", { class: "seg", id: "densityMode", role: "group", "aria-label": "목록 간격" }, [["roomy", "넉넉히"], ["tight", "촘촘히"]].map(([k, label]) => el("button", { type: "button", "data-d": k, text: label }))),
          el("button", { class: "menu-item", id: "btnReport", type: "button", role: "menuitem", text: LOCAL ? "백업 · 복원" : "주간보고 만들기" }),
          el("button", { class: "menu-item", id: "btnCleanup", type: "button", role: "menuitem", text: "저장 공간 정리" }),
          el("div", { class: "menu-foot", id: "appInfo" })))),
    el("nav", { class: "pages", role: "tablist", "aria-label": "화면" },
      el("button", { class: "pg", id: "pgTasks", type: "button", role: "tab", "data-page": "tasks", text: "할 일" }),
      el("button", { class: "pg", id: "pgClips", type: "button", role: "tab", "data-page": "clips", text: "보관함" })),
    el("div", { id: "banner", class: "banner", hidden: true }),
    el("main", { id: "main", "aria-live": "polite" }),
    el("button", { class: "fab", id: "btnFab", type: "button", "aria-label": "새 할 일", text: "＋" }),
    el("div", { class: "modal", id: "modal", hidden: true },
      el("div", { class: "modal-bg", id: "modalBg" }),
      el("div", { class: "modal-box", role: "dialog", "aria-modal": "true", "aria-labelledby": "modalTitle" },
        el("h3", { id: "modalTitle" }), el("pre", { id: "modalText" }),
        el("div", { class: "modal-foot" }, el("button", { class: "btn", id: "modalCopy", type: "button", text: "복사" }), el("button", { class: "btn primary", id: "modalClose", type: "button", text: "닫기" })))),
    el("div", { class: "toast", id: "toast", role: "status", hidden: true }));
}
function toggleMenu(open) {
  const m = $("menu"), want = open === undefined ? m.hidden : open;
  m.hidden = !want; $("btnMenu").setAttribute("aria-expanded", String(want));
}
function setDensity(d) { state.density = d === "tight" ? "tight" : "roomy"; store.set("th.density", state.density); document.body.dataset.density = state.density; renderMenu(); }
function renderMenu() {
  document.querySelectorAll("#viewMode button").forEach((b) => b.classList.toggle("on", b.dataset.v === state.view));
  document.querySelectorAll("#densityMode button").forEach((b) => b.classList.toggle("on", b.dataset.d === state.density));
  const v = LOCAL ? (window.TH_VERSION && window.TH_VERSION.version) : (state.meta && state.meta.version);
  $("appInfo").textContent = `${APP_NAME}${v ? " v" + v : ""}`;
}

/* ───────── 그리기: 뼈대 → 왼쪽(목록·상세) → 오른쪽(달력) ───────── */
function render(opts) {
  document.querySelectorAll(".pg").forEach((b) => { const on = b.dataset.page === state.page; b.classList.toggle("on", on); b.setAttribute("aria-selected", String(on)); });
  $("search").placeholder = state.page === "clips" ? "보관함 검색" : "검색";
  if (state.page === "clips") { layoutClips(); renderMenu(); renderClips(opts); return; }
  layout(); renderMenu(); renderLeft(opts); renderCal();
}
function setPage(p) {
  if (p === state.page) return;
  if (!confirmLeave() || !confirmLeaveClip()) return;
  state.detail = null; state.clipDetail = null; state.page = p; store.set("th.page", p); render();
}
function layout() {
  const main = $("main");
  if (!$("stageMain")) main.replaceChildren(el("section", { class: "stage-main", id: "stageMain" }), el("aside", { class: "side", id: "side", "aria-label": "달력" }));
  main.className = "stage has-side";
  main.dataset.view = state.view;
  document.body.classList.toggle("detail-open", !!state.detail);
}
function computeCal() {
  const cells = monthCells(state.cal.y, state.cal.m);
  return { cells, by: byDay(matchQuery(state.items), cells) };
}
function renderCal() { $("side").replaceChildren(renderCalendar(computeCal())); }
function renderLeft(opts = {}) {
  const box = $("stageMain");
  if (opts.keepDirty && state.detail && isDirty()) return;                    // 입력 중인 상세는 데이터가 바뀌어도 덮어쓰지 않는다
  if (state.detail && state.detail.id && !state.items.some((x) => x.id === state.detail.id)) state.detail = null;   // 사라진 과제
  const key = [state.view, state.day, state.q, state.detail ? state.detail.id || "new" : ""].join("|");
  const top = state._leftKey === key ? window.scrollY : 0;
  box.replaceChildren(state.detail ? renderDetail() : state.view === "board" ? renderBoard() : renderSections());
  state._leftKey = key;
  if (top) window.scrollTo(0, top);
  document.body.classList.toggle("detail-open", !!state.detail);
  if (state.detail) {
    state.detail.snap = JSON.stringify(readForm());
    if (!state.detail.id && !state.detail.focused) { state.detail.focused = true; $("f_title").focus(); }
  }
}

/* ───────── 달력(오른쪽·아래: 보조) ───────── */
function calGoto(delta) {
  let { y, m } = state.cal; m += delta;
  while (m < 1) { m += 12; y -= 1; }
  while (m > 12) { m -= 12; y += 1; }
  state.cal.y = y; state.cal.m = m;
  renderCal();
}
function pickDay(date) {                                                      // 같은 날짜를 다시 누르면 필터 해제
  if (!confirmLeave()) return;
  state.detail = null; state.day = state.day === date ? "" : date;
  if (state.day) { state.cal.y = +date.slice(0, 4); state.cal.m = +date.slice(5, 7); }
  render();
}
function clearDay() { if (!confirmLeave()) return; state.detail = null; state.day = ""; render(); }
function renderCalendar(v) {
  const { y, m } = state.cal, today = todayIso();
  return el("div", { class: "cal" },
    el("div", { class: "cal-head" },
      el("h2", { class: "cal-title", text: `${y}년 ${m}월` }),
      el("button", { class: "ib", type: "button", "aria-label": "이전 달", text: "‹", onclick: () => calGoto(-1) }),
      el("button", { class: "ib", type: "button", "aria-label": "다음 달", text: "›", onclick: () => calGoto(1) }),
      el("button", { class: "today-btn", type: "button", text: "오늘", onclick: () => { state.cal.y = +today.slice(0, 4); state.cal.m = +today.slice(5, 7); pickDay(today); } })),
    el("div", { class: "cal-grid", role: "grid", "aria-label": `${y}년 ${m}월 달력` },
      DOW.map((w, i) => el("div", { class: "cal-dow" + (i === 5 ? " sat" : i === 6 ? " sun" : ""), role: "columnheader", text: w })),
      v.cells.map((c, i) => calCell(c, i, v.by[c.date] || [], today))));
}
function calCell(c, i, list, today) {
  const n = list.length, od = list.some(isOverdue), col = i % 7, sel = c.date === state.day;
  const cls = ["cal-cell", c.inMonth ? "" : "out", c.date === today ? "today" : "", sel ? "sel" : "", col === 5 ? "sat" : col === 6 ? "sun" : ""].filter(Boolean).join(" ");
  const btn = el("button", { class: cls, type: "button", role: "gridcell", "data-date": c.date, "aria-selected": String(sel), "aria-label": `${c.date}${n ? `, 과제 ${n}개` : ""}`, onclick: () => pickDay(c.date) },
    el("span", { class: "cal-day", text: String(c.day) }),
    el("span", { class: "cal-dots" + (od ? " od" : "") }, n ? [...Array(Math.min(n, 3))].map(() => el("i")) : null, n > 3 ? el("b", { text: "+" + (n - 3) }) : null));
  btn.addEventListener("dragover", (e) => { if (document.body.classList.contains("dragging-task")) { e.preventDefault(); btn.classList.add("drop"); } });
  btn.addEventListener("dragleave", () => btn.classList.remove("drop"));
  btn.addEventListener("drop", (e) => {
    e.preventDefault(); btn.classList.remove("drop");
    const id = e.dataTransfer.getData("text/plain"); if (id) applyMove(id, c.date);
  });
  return btn;
}

/* ───────── 오른쪽: 날짜 목록·탭 ───────── */
const BRIEF_STATUS = ["진행 중", "확인 필요", "대기", "보류"];                  // 목록 줄에 따로 표시할 상태(미착수·완료는 흔하거나 자리로 알 수 있어 생략)
function row(it, opts = {}) {
  const done = isDone(it), od = isOverdue(it), sub = [];
  const multi = it.start && it.due && it.start !== it.due;
  if (multi) sub.push(`${it.start.slice(5)} ~ ${it.due.slice(5)}`);
  else if (opts.showDate && endOf(it)) sub.push(endOf(it).slice(5));
  if (it.domain) sub.push(it.domain);
  const acts = it.actions || [];
  if (acts.length) sub.push(`체크 ${acts.filter((a) => a.done).length}/${acts.length}`);
  const brief = (it.summary || "").trim();                                      // 개요(없으면 내용 첫머리)를 두 줄까지 보여 준다 — 열어 보지 않아도 무슨 일인지 알 수 있게
  const gist = brief || (it.detail || "").trim().split("\n")[0];
  const badges = done ? [] : [!done && BRIEF_STATUS.includes(it.status) ? el("span", { class: "bdg st-" + BRIEF_STATUS.indexOf(it.status), text: it.status }) : null,
    it.priority === "긴급" || it.priority === "높음" ? el("span", { class: "bdg pri-" + (it.priority === "긴급" ? "0" : "1"), text: it.priority }) : null].filter(Boolean);
  const r = el("div", { class: "row" + (done ? " done" : "") + (od ? " od" : ""), role: "button", tabindex: "0", "data-id": it.id, draggable: done ? false : "true", onclick: () => openDetail(it.id),
      onkeydown: (e) => { if (e.key === "Enter" && e.target === e.currentTarget) openDetail(it.id); } },
    el("button", { class: "chk", type: "button", "aria-label": done ? "완료 취소" : "완료로 표시", "aria-pressed": String(done), onclick: (e) => { e.stopPropagation(); setDone(it, !done); } }),
    el("div", { class: "row-main" },
      el("div", { class: "row-title" }, it.title, it.repeat ? el("span", { class: "rep", title: it.repeat, text: " ↻" }) : null),
      gist && !done ? el("div", { class: "row-gist", text: gist }) : null,
      badges.length || sub.length || od ? el("div", { class: "row-sub" }, badges, sub.join(" · "), od ? el("span", { class: "od-tag", text: (sub.length ? " · " : "") + `기한 지남 D+${dayDiff(endOf(it), todayIso())}` }) : null) : null),
    it.time ? el("div", { class: "row-time", text: fmtRange(it) }) : null,
    !done && isUndated(it) ? el("button", { class: "adddate", type: "button", "aria-label": `${it.title} 날짜 정하기`, text: "＋ 날짜", onclick: (e) => { e.stopPropagation(); openDatePick(it, e.currentTarget); } }) : null);
  if (!done) {
    r.addEventListener("dragstart", (e) => { e.dataTransfer.setData("text/plain", it.id); e.dataTransfer.effectAllowed = "move"; r.classList.add("dragging"); document.body.classList.add("dragging-task"); });
    r.addEventListener("dragend", () => { r.classList.remove("dragging"); document.body.classList.remove("dragging-task"); document.querySelectorAll(".cal-cell.drop").forEach((c) => c.classList.remove("drop")); });
  }
  return r;
}
/* 날짜 정하기(폰·터치용): ‘＋ 날짜’ 를 누르면 작은 선택지가 뜬다 */
function datePresets() {
  const t = todayIso(), sat = (() => { const n = (5 - dowOf(t) + 7) % 7; return n === 0 ? 7 : n; })();
  const add = (n) => { const d = new Date(t + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  return [["오늘", t], ["내일", add(1)], ["이번 주말", add(dowOf(t) >= 5 ? 0 : sat)], ["다음 주", add(7 - dowOf(t))]];
}
function openDatePick(it, anchor) {
  closeDatePick();
  const pop = el("div", { class: "datepick", id: "datepick", role: "dialog", "aria-label": "날짜 정하기" },
    ...datePresets().map(([label, d]) => el("button", { type: "button", class: "dp", text: `${label} ${+d.slice(5, 7)}/${+d.slice(8)}`, onclick: () => { closeDatePick(); applyMove(it.id, d); } })),
    el("input", { type: "date", class: "dp-input", "aria-label": "직접 고르기", onchange: (e) => { if (e.target.value) { closeDatePick(); applyMove(it.id, e.target.value); } } }));
  anchor.closest(".row").after(pop);
}
function closeDatePick() { const p = $("datepick"); if (p) p.remove(); }
async function applyMove(id, date) {                                           // 끌어놓기·＋ 날짜 공통: 기한을 옮기고 목록·달력을 새로 그린다
  const it = state.items.find((x) => x.id === id); if (!it) return;
  if (!confirmLeave()) return;
  try {
    const body = window.THCore.moveTo(it, date);
    await api("PUT", `item/${id}`, body);
    toast(`${+date.slice(5, 7)}월 ${+date.slice(8)}일로 옮겼습니다.`);
    if (!state.day) showTab(Object.assign({}, it, body));
    await refresh();
  } catch (e) { banner(e.message, true); }
}
function inboxRow(x) {
  return el("div", { class: "row inbox-row" },
    el("div", { class: "row-main" },
      el("div", { class: "row-title", text: x.title }),
      el("div", { class: "row-sub", text: [x.source, x.ref, x.due && "기한 " + x.due].filter(Boolean).join(" · ") }),
      el("div", { class: "row-actions" },
        el("button", { class: "btn primary sm", type: "button", text: "수락", onclick: async () => { try { await api("POST", `inbox/${x.id}/accept`, {}); toast("과제로 추가했습니다."); await refresh(); } catch (e) { banner(e.message, true); } } }),
        el("button", { class: "btn sm", type: "button", text: "무시", onclick: async () => { try { await api("POST", `inbox/${x.id}/dismiss`, {}); await refresh(); } catch (e) { banner(e.message, true); } } }))));
}
/* 빠른 추가: 치는 동안 ‘이렇게 저장됩니다’ 칩을 보여 준다(날짜·시각·반복). 칩의 ✕ 를 누르면 그 부분 해석만 끈다.
   날짜를 말하지 않았으면 달력에서 고른 날(없으면 날짜 미정)로 저장한다. 해석이 하나도 없으면 입력 그대로가 제목이다. */
function fmtChipDate(d) { return `${+d.slice(5, 7)}/${+d.slice(8)}(${DOW[dowOf(d)]}) ${relDay(d)}`; }
function quickAdd(dayDefault) {
  const off = new Set();                                                       // 사용자가 끈 해석: due | time | repeat
  const inp = el("input", { id: "quickAdd", class: "qa", type: "text", placeholder: "＋ 할 일 추가 — 예: 내일 오후 3시 회의", maxlength: "200", autocomplete: "off", "aria-label": "빠른 추가" });
  const chips = el("div", { class: "qchips", id: "qchips", "aria-live": "polite" });
  const read = () => window.THCore ? window.THCore.parseQuick(inp.value, todayIso()) : { title: inp.value.trim(), due: "", time: "", end_time: "", repeat: "" };
  const plan = () => {                                                          // 지금 입력을 저장하면 만들어질 값
    const r = read(), keepAll = !(r.due || r.time || r.repeat);
    if (keepAll) return { title: inp.value.trim().replace(/\s+/g, " "), due: dayDefault || "", time: "", end_time: "", repeat: "", parsed: false };
    const o = { title: r.title, due: r.due, time: r.time, end_time: r.end_time, repeat: r.repeat, parsed: true };
    // 끈 해석은 값을 비우되, 해석에 쓰인 표현이 제목에서 사라지지 않도록 원문을 제목으로 되돌린다
    if (off.size) {
      const orig = inp.value.trim().replace(/\s+/g, " ");
      if (off.has("due") || off.has("time") || off.has("repeat")) return { title: orig, due: dayDefault || "", time: "", end_time: "", repeat: "", parsed: false };
    }
    if (!o.due) o.due = dayDefault || "";
    return o;
  };
  const paint = () => {
    const p = plan(), c = [];
    if (p.parsed) {
      if (p.due) c.push(el("span", { class: "qchip" }, "📅 " + fmtChipDate(p.due)));
      if (p.time) c.push(el("span", { class: "qchip" }, "🕒 " + fmtTime(p.time) + (p.end_time ? " – " + fmtTime(p.end_time) : "")));
      if (p.repeat) c.push(el("span", { class: "qchip" }, "↻ " + p.repeat));
      c.push(el("button", { class: "qoff", type: "button", "aria-label": "날짜·시각 해석 끄기", title: "해석하지 않고 입력한 그대로 저장", onclick: () => { off.add("due"); paint(); inp.focus(); }, text: "해석 끄기" }));
    }
    chips.replaceChildren(...c);
    chips.hidden = !c.length;
  };
  inp.addEventListener("input", () => { off.clear(); paint(); });
  inp.addEventListener("keydown", async (e) => {
    if (e.key !== "Enter" || e.isComposing || e.keyCode === 229) return;       // 한글 조합 중의 Enter 는 글자 확정이므로 무시
    e.preventDefault();
    const p = plan(); if (!p.title) return;
    const body = { title: p.title };
    for (const k of ["due", "time", "end_time", "repeat"]) if (p[k]) body[k] = p[k];
    inp.disabled = true;
    try { const made = await api("POST", "items", body); toast("추가했습니다."); if (!dayDefault) showTab(made); await refresh(); }
    catch (err) { banner(err.message, true); }
    const again = $("quickAdd"); if (again) { again.disabled = false; again.value = ""; again.focus(); paint(); }
  });
  const wrap = el("div", { class: "qwrap" }, inp, chips);
  if (dayDefault) {                                                              // 달력에서 날짜를 골라 둔 상태: 그 날 대신 ‘날짜 미정’으로 넣는 길
    const later = el("button", { class: "qlater", type: "button", id: "btnQuickLater", text: "날짜 없이(나중에) 추가", onclick: async () => {
      const t = inp.value.trim().replace(/\s+/g, " "); if (!t) { inp.focus(); return; }
      inp.disabled = true;
      try { await api("POST", "items", { title: t }); toast("‘나중에’에 추가했습니다."); await refresh(); }
      catch (err) { banner(err.message, true); }
      const again = $("quickAdd"); if (again) { again.disabled = false; again.value = ""; again.focus(); paint(); }
    } });
    wrap.append(later);
  }
  chips.hidden = true;
  return wrap;
}

/* ───────── 왼쪽 주인공: 구간별 목록 ───────── */
const SECTIONS = [
  { k: "overdue", label: "기한 지남", warn: true, limit: 20 },     // limit: 처음 보여줄 개수. 넘으면 ‘N건 더 보기’. 기한 지남·완료는 자기 탭이 있어 오늘 할 일을 밀어내지 않으므로 넉넉하게
  { k: "today", label: "오늘" },
  { k: "tomorrow", label: "내일" },
  { k: "doing", label: "날짜는 없지만 진행 중", limit: 12 },                      // 날짜는 없지만 지금 하고 있는 일(진행 중·확인 필요)
  { k: "week", label: "이번 주", limit: 8 },
  { k: "later", label: "이후", limit: 6 },
  { k: "undated", label: "날짜 미정", limit: 10 },
  { k: "done", label: "완료", limit: 20 },
];
/* 목록 위 탭. 모든 구간은 정확히 한 탭에 속한다(tests/app_sections.test.js 가 지킨다). 당장 할 일만 먼저 보이고, 기한 지남·완료는 따로 본다. */
const TABS = [
  { k: "now", label: "지금", sections: ["today", "tomorrow", "week", "doing"], default: true },
  { k: "overdue", label: "기한 지남", sections: ["overdue"], warn: true },
  { k: "later", label: "나중에", sections: ["later", "undated"] },
  { k: "done", label: "완료", sections: ["done"] },
];
function tabOfSection(k) { const t = TABS.find((x) => x.sections.includes(k)); return t ? t.k : null; }
function sectionOf(it, t) {                                                    // t: 기준일(ISO). 한 할 일은 정확히 한 구간에만 들어간다
  t = t || todayIso();
  if (isDone(it)) return "done";
  const s = it.start || it.due, e = it.due || it.start;
  if (!s) return it.status === "진행 중" || it.status === "확인 필요" ? "doing" : "undated";
  if (e < t) return "overdue";
  if (s <= t) return "today";                                                  // 기간 일정이 오늘을 지나는 중
  const n = dayDiff(t, s);
  if (n === 1) return "tomorrow";
  return n <= 6 - dowOf(t) ? "week" : "later";                                 // 이번 주 일요일까지
}
function collapsedSet() { try { return new Set(JSON.parse(store.get("th.collapsed", "null")) || SECTIONS.filter((x) => x.collapsed).map((x) => x.k)); } catch (e) { return new Set(); } }
function toggleSection(k) { const c = collapsedSet(); c.has(k) ? c.delete(k) : c.add(k); store.set("th.collapsed", JSON.stringify([...c])); renderLeft(); }
function dayFilterBar() {
  if (!state.day) return null;
  return el("div", { class: "day-chip" }, el("span", { text: `${dayTitle(state.day)} · ${relDay(state.day)}` }),
    el("button", { class: "x", type: "button", "aria-label": "날짜 필터 해제", text: "전체 보기 ✕", onclick: clearDay }));
}
function listItems() {                                                          // 검색어와 날짜 필터를 적용한 목록 대상
  let items = matchQuery(state.items);
  if (state.day) items = items.filter((it) => !isDone(it) && !!(it.start || it.due) && (it.start || it.due) <= state.day && state.day <= (it.due || it.start));
  return items;
}
/* 한 구간에서 처음 보여줄 개수와 ‘더 보기/접기’ 버튼. 제한이 없거나, 좁혀서 보는 중이거나, 개수가 제한 이하이면 버튼 없이 전부 보여 준다. */
function rowLimit(sec, total, narrowed, expanded) {
  if (!sec.limit || narrowed || total <= sec.limit) return { shown: total, control: "none" };
  return expanded ? { shown: total, control: "less" } : { shown: sec.limit, control: "more" };
}
function tabBar(counts) {
  return el("div", { class: "ltabs", role: "tablist", "aria-label": "할 일 보기" }, TABS.map((t) => {
    const n = counts[t.k] || 0, on = state.tab === t.k;
    return el("button", { class: "ltab" + (on ? " on" : "") + (t.warn && n ? " warn" : ""), type: "button", role: "tab", "data-tab": t.k, "aria-selected": String(on),
      onclick: () => { if (!confirmLeave()) return; state.detail = null; state.tab = t.k; render(); } },
      t.label, n ? el("span", { class: "n", text: String(n) }) : null);
  }));
}
function renderSections() {
  const items = listItems(), by = {};
  for (const it of items) (by[sectionOf(it)] = by[sectionOf(it)] || []).push(it);
  const narrowed = !!state.day || !!state.q.trim();                              // 날짜를 고르거나 검색 중이면 결과가 구간을 가로지르므로 탭 없이 전부 모아 본다
  const counts = {};
  for (const t of TABS) counts[t.k] = t.sections.reduce((n, k) => n + (by[k] || []).length, 0);
  if (!narrowed && !TABS.some((t) => t.k === state.tab)) state.tab = TABS.find((t) => t.default).k;
  const col = state.day ? new Set() : collapsedSet();
  const parts = [quickAdd(state.day), dayFilterBar(), narrowed ? null : tabBar(counts)];
  let shown = 0;
  for (const sec of SECTIONS) {
    if (!narrowed && tabOfSection(sec.k) !== state.tab) continue;
    const arr = (by[sec.k] || []).sort(sec.k === "done" ? (a, b) => (b.updated || "").localeCompare(a.updated || "") : cmpAny);
    if (!arr.length) continue;
    shown += arr.length;
    const closed = col.has(sec.k);
    const lim = rowLimit(sec, arr.length, narrowed, state.expanded.has(sec.k));
    const solo = !narrowed && TABS.find((t) => t.k === state.tab).sections.length === 1;        // 이 탭에 구간이 하나뿐이면 제목줄은 탭과 중복이라 감춘다
    const more = (closed && !solo) || lim.control === "none" ? null
      : lim.control === "more" ? el("button", { class: "more-rows", type: "button", "data-more": sec.k, onclick: () => { state.expanded.add(sec.k); renderLeft(); }, text: `${arr.length - lim.shown}건 더 보기` })
      : el("button", { class: "more-rows", type: "button", "data-less": sec.k, onclick: () => { state.expanded.delete(sec.k); renderLeft(); }, text: "접기" });
    const hide = closed && !solo;
    parts.push(el("section", { class: "sec" + (sec.warn ? " warn" : "") + (hide ? " closed" : "") + (solo ? " solo" : ""), "data-sec": sec.k },
      solo ? null : el("button", { class: "sec-h", type: "button", "aria-expanded": String(!closed), onclick: () => toggleSection(sec.k) },
        el("span", { class: "caret", text: closed ? "▸" : "▾" }), el("span", { class: "sec-t", text: sec.label }), el("span", { class: "n", text: String(arr.length) })),
      hide ? null : el("div", { class: "list" }, arr.slice(0, lim.shown).map((it) => row(it, { showDate: sec.k !== "today" && sec.k !== "tomorrow" }))),
      more));
  }
  if (!shown) {
    const msg = state.q.trim() ? "검색 결과가 없습니다." : state.day ? "이 날은 할 일이 없습니다."
      : state.tab === "now" ? "오늘·이번 주 할 일이 없습니다." : state.tab === "overdue" ? "기한이 지난 일이 없습니다." : state.tab === "done" ? "완료한 일이 없습니다." : "나중에 할 일이 없습니다.";
    const hint = state.day || state.q.trim() ? null : state.tab === "now" ? "위 입력칸에 적고 Enter 를 누르면 추가됩니다." : null;
    parts.push(el("div", { class: "empty" }, el("b", { text: msg }), hint));
  }
  if (!state.day && state.inbox.length && !state.q.trim()) parts.push(el("section", { class: "sec", "data-sec": "inbox" },
    el("div", { class: "sec-h static" }, el("span", { class: "sec-t", text: "제안함" }), el("span", { class: "n", text: String(state.inbox.length) })),
    el("p", { class: "help", text: "다른 곳에서 가져온 후보입니다. 수락해야 내 할 일이 됩니다." }), el("div", { class: "list" }, state.inbox.map(inboxRow))));
  return el("div", { class: "sections" }, parts);
}

/* ───────── 보드·전체 목록 ───────── */
function renderBoard() {
  const items = matchQuery(state.items), cols = state.meta.statuses.filter((s) => s !== "취소");
  return el("div", { class: "board" }, cols.map((s) => {
    let arr = items.filter((it) => it.status === s).sort(cmpAny); const hidden = Math.max(0, arr.length - (s === "완료" ? MAX_DONE_IN_BOARD : 9999));
    if (hidden) arr = arr.slice(0, MAX_DONE_IN_BOARD);
    const col = el("div", { class: "col" + (arr.length ? "" : " empty-col"), "data-status": s },
      el("h3", {}, s, " ", el("span", { class: "cnt", text: String(arr.length + hidden) })),
      arr.map((it) => bcard(it)), hidden ? el("div", { class: "more-note", text: `외 ${hidden}건` }) : null);
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
function bcard(it) {
  const sub = [endOf(it) && endOf(it).slice(5), it.domain].filter(Boolean).join(" · ");
  const c = el("div", { class: "bcard" + (isOverdue(it) ? " od" : ""), role: "button", tabindex: "0", draggable: "true", "data-id": it.id, onclick: () => openDetail(it.id),
    onkeydown: (e) => { if (e.key === "Enter") openDetail(it.id); } },
    el("div", { class: "row-title", text: it.title }), sub ? el("div", { class: "row-sub", text: sub }) : null);
  c.addEventListener("dragstart", (e) => { e.dataTransfer.setData("text/plain", it.id); e.dataTransfer.effectAllowed = "move"; });
  return c;
}
/* ───────── 상세·등록 ───────── */
function fld(label, input, opts = {}) {
  return el("div", { class: "f" + (opts.full ? " full" : "") + (opts.big ? " big" : "") }, el("label", { text: label, for: input.id }), input, opts.help ? el("div", { class: "help", text: opts.help }) : null);
}
function inputEl(id, type, value, attrs) { return el("input", Object.assign({ id, type, value: value || "" }, attrs)); }
function selectEl(id, options, value) { return el("select", { id }, options.map((o) => el("option", { value: o, selected: o === value, text: o || "(없음)" }))); }
function textareaEl(id, value, rows) { const t = el("textarea", { id, rows: String(rows || 3) }); t.value = value || ""; return t; }
function actRow(a) {
  const r = el("div", { class: "act" },
    el("input", { type: "checkbox", checked: !!a.done, "aria-label": "완료" }),
    el("input", { type: "text", value: a.text || "", placeholder: "해야 할 일" }),
    el("input", { type: "date", value: a.due || "", "aria-label": "기한" }),
    el("button", { type: "button", class: "rm", "aria-label": "삭제", text: "×", onclick: () => r.remove() }));
  return r;
}
function renderDetail() {
  const d = state.detail, existing = d.id ? state.items.find((x) => x.id === d.id) : null, isNew = !existing;
  const it = existing || Object.assign({ title: "", status: "미착수", priority: "보통", repeat: "", base_date: todayIso(), actions: [], people: [], tags: [], links: [] }, d.preset);
  const actsBox = el("div", { class: "acts", id: "f_acts" }, (it.actions || []).map(actRow));
  const dl = $("dl_domain") || el("datalist", { id: "dl_domain" });
  dl.replaceChildren(...[...new Set(state.items.map((x) => x.domain).filter(Boolean))].map((x) => el("option", { value: x })));
  if (!dl.parentNode) document.body.append(dl);
  return el("form", { class: "detail", id: "form", autocomplete: "off", onsubmit: submitForm },
    el("div", { class: "d-head" },
      el("button", { class: "back", type: "button", id: "btnBack", text: "‹ 목록", onclick: () => closeDetail() }),
      el("div", { class: "spacer" }),
      el("label", { class: "pill-label", for: "f_status", text: "상태" }), selectEl("f_status", state.meta.statuses, it.status),
      isNew ? null : el("button", { class: "link danger", type: "button", id: "btnDelete", text: "삭제", onclick: deleteItem })),
    inputEl("f_title", "text", it.title, { class: "d-title", placeholder: "무엇을 할까요?", required: true, maxlength: "200", "aria-label": "제목" }),
    el("div", { class: "block" },
      fld("날짜", inputEl("f_due", "date", it.due), { full: true, help: "선택 사항입니다. 비워 두면 ‘나중에’ 탭에 ‘날짜 미정’으로 보관됩니다." }),
      el("div", { class: "later-row" },
        el("button", { type: "button", class: "btn sm", id: "btnLater", text: "나중에 / 미정으로", title: "날짜·시각을 비웁니다", onclick: () => { for (const id of ["f_due", "f_start", "f_time", "f_end_time"]) $(id).value = ""; $("spanMore").open = false; } }),
        el("span", { class: "help", text: "날짜를 정하지 않아도 저장할 수 있습니다." })),
      el("div", { class: "row2" },
        fld("시작 시각", inputEl("f_time", "time", it.time)),
        fld("종료 시각", inputEl("f_end_time", "time", it.end_time))),
      el("details", { class: "span-more", id: "spanMore", open: !!(it.start && it.start !== it.due) },
        el("summary", { text: "여러 날에 걸치나요?" }),
        fld("시작일", inputEl("f_start", "date", it.start), { help: "시작일부터 위의 날짜까지 모든 날에 달력에 표시됩니다." }))),
    !isNew && state.clips.some((c) => c.item === it.id) ? relatedClips(it.id) : null,
    el("div", { class: "pri-row" }, fld("우선순위", selectEl("f_priority", state.meta.priorities, it.priority)), fld("도메인", inputEl("f_domain", "text", it.domain, { list: "dl_domain", placeholder: CFG.domainHint || "예: 업무 영역 이름" }))),
    fld("개요", textareaEl("f_summary", it.summary, 4), { full: true, big: true, help: "한두 문장으로 무슨 일인지. 목록에 이 글이 보입니다." }),
    fld("세부사항", textareaEl("f_detail", it.detail, 9), { full: true, big: true }),
    el("div", { class: "f full big" }, el("label", { text: "액션플랜 (해야 할 일 체크리스트)" }), actsBox,
      el("div", {}, el("button", { type: "button", class: "btn sm", text: "+ 항목 추가", onclick: () => { const r = actRow({}); actsBox.append(r); r.querySelector("input[type=text]").focus(); } }))),
    docField(it, isNew),
    fld("결과", textareaEl("f_result", it.result, 5), { full: true, big: true, help: "끝난 뒤 어떻게 됐는지. 주간보고의 ‘금주 완료’ 옆에 이 글이 붙습니다." }),
    el("details", { class: "more", id: "more", ontoggle: (e) => { if (e.target.open) setTimeout(() => e.target.scrollIntoView({ block: "nearest", behavior: "smooth" }), 30); } },
      el("summary", { text: "더보기 (반복 · 관련인물 · 분류표시 · 링크 …)" }),
      el("div", { class: "more-grid" },
        fld("반복", selectEl("f_repeat", state.meta.repeats, it.repeat), { help: "완료하면 다음 회차가 자동 생성됩니다" }),
        fld("기준일자", inputEl("f_base_date", "date", it.base_date), { help: "이 내용을 작성·확인한 날짜" }),
        fld("관련인물", inputEl("f_people", "text", (it.people || []).join(", "), { placeholder: "쉼표로 구분" })),
        fld("분류표시 (태그)", inputEl("f_tags", "text", (it.tags || []).join(", "), { placeholder: "예: 긴급, 분기마감" }), { help: "할 일에 붙이는 짧은 꼬리표. 검색에 걸립니다." }),
        fld("링크", inputEl("f_links", "text", (it.links || []).join(", ")), { full: true, help: "관련 문서·페이지 주소" }),
        it.source ? el("div", { class: "f full help", text: sourceNote(it) }) : null)),
    el("div", { class: "d-foot" },
      el("span", { class: "msg", id: "formMsg", role: "alert" }),
      el("button", { class: "btn", type: "button", id: "btnCancel", text: "취소", onclick: () => closeDetail() }),
      el("button", { class: "btn primary", type: "submit", id: "btnSave", text: "저장" })));
}
/* 출처: 이 할 일이 어디서 왔는지(예: 엑셀에서 가져옴). 직접 만든 할 일에는 없다. 사람이 읽는 말로 풀어 보여 준다 */
function sourceNote(it) {
  const s = String(it.source || "");
  const m = /^excel:(.+)$/.exec(s);
  return "출처: " + (m ? `엑셀 ‘${m[1]}’ 에서 가져온 할 일` : s) + " (가져온 할 일에만 표시되며 바꿀 수 없습니다)";
}
/* 기획서: 문서 파일을 올리면 보관함에도 같이 들어가고(이 할 일에 연결), 여기에서 바로 내려받을 수 있다. 링크나 파일명은 아래 칸에 적는다 */
function docField(it, isNew) {
  const docs = isNew ? [] : state.clips.filter((c) => c.item === it.id && c.kind === "file" && (c.tags || []).includes("기획서"));
  const pick = el("input", { type: "file", id: "docPick", hidden: true, multiple: true });
  pick.addEventListener("change", async () => { const fs = [...pick.files]; pick.value = ""; await uploadDocs(fs); });
  const list = docs.map((c) => el("div", { class: "docrow", "data-id": c.id },
    el("button", { class: "doclink", type: "button", title: "내려받기", onclick: () => downloadFile(c) }, el("span", { class: "ext", text: (c.name.split(".").pop() || "").toUpperCase().slice(0, 4) }), el("span", { class: "dn", text: c.name }), el("span", { class: "ds", text: fmtBytes(c.bytes) })),
    el("button", { class: "rm", type: "button", "aria-label": c.name + " 삭제", title: "보관함에서도 지웁니다", onclick: () => removeDoc(c) , text: "×" })));
  return el("div", { class: "f full big" }, el("label", { text: "기획서" }),
    list.length ? el("div", { class: "docs" }, list) : null,
    isNew ? el("p", { class: "help", text: "먼저 저장하면 기획서 파일을 올릴 수 있습니다. 링크나 파일명은 아래 칸에 바로 적어도 됩니다." })
      : el("div", { class: "docbtns" }, el("button", { type: "button", class: "btn sm", id: "btnDocUpload", text: "＋ 기획서 파일 올리기", onclick: () => pick.click() }), pick,
        el("span", { class: "help", text: "올린 파일은 보관함(파일)에도 같이 보관됩니다." })),
    textareaEl("f_doc", it.doc, 2), el("div", { class: "help", text: "문서 링크나 파일명을 적어 둘 수도 있습니다." }));
}
async function uploadDocs(files) {
  const d = state.detail; if (!d || !d.id || !files.length) return;
  if (isDirty() && !confirm("저장하지 않은 입력이 있습니다. 먼저 저장한 뒤 파일을 올립니다.")) return;
  if (isDirty()) { try { const r = await api("PUT", `item/${d.id}`, readForm()); void r; } catch (e) { $("formMsg").textContent = e.message; return; } }
  let ok = 0, bad = "";
  for (const f of files) {
    try { await uploadOneFile(f, { title: "", tags: ["기획서"], item: d.id }); ok++; }
    catch (e) { bad = `${f.name}: ${e.message}`; }
  }
  if (ok) toast(ok === 1 ? "기획서를 올렸습니다. 보관함에도 들어갔습니다." : `기획서 ${ok}개를 올렸습니다. 보관함에도 들어갔습니다.`);
  if (bad) banner(bad, true);
  await refresh();
  if (state.detail && state.detail.id === d.id) { state.detail.snap = JSON.stringify(readForm()); }
}
async function removeDoc(c) {
  if (!confirm(`‘${c.name}’ 파일을 지울까요? 보관함에서도 함께 지워지며 되돌릴 수 없습니다.`)) return;
  try { await api("DELETE", `clips/${c.id}`); toast("지웠습니다."); await refresh(); } catch (e) { banner(e.message, true); }
}
function relatedClips(taskId) {                                                // 이 할 일에 연결된 보관함 항목(링크·메모·사진)
  const list = state.clips.filter((c) => c.item === taskId);
  return el("section", { class: "related", "aria-label": "관련 자료" },
    el("div", { class: "menu-label", text: `관련 자료 ${list.length ? list.length : ""}`.trim() }),
    list.length ? el("div", { class: "rel-list" }, list.map((c) => el("button", { class: "rel", type: "button", "data-id": c.id, onclick: () => {
      if (!confirmLeave()) return; state.detail = null; state.page = "clips"; store.set("th.page", "clips"); state.clipDetail = { id: c.id, preset: {} }; render();
    } }, el("span", { class: "rk", text: CLIP_LABEL[c.kind] }), el("span", { class: "rt", text: c.title || c.host || (c.body || "").slice(0, 40) || "사진" })))) : el("p", { class: "help", text: "보관함에서 항목을 열어 ‘연결할 할 일’을 고르면 여기에 나타납니다." }));
}
function readForm() {
  const v = (id) => $(id).value;
  const acts = [...document.querySelectorAll("#f_acts .act")].map((r) => {
    const [cb, tx, dd] = r.querySelectorAll("input");
    return { text: tx.value, done: cb.checked, due: dd.value };
  }).filter((a) => a.text.trim());
  return { title: v("f_title"), base_date: v("f_base_date"), domain: v("f_domain"), status: v("f_status"), priority: v("f_priority"),
    start: v("f_start"), due: v("f_due"), time: v("f_time"), end_time: v("f_end_time"), repeat: v("f_repeat"), people: v("f_people"),
    summary: v("f_summary"), detail: v("f_detail"), actions: acts, doc: v("f_doc"), result: v("f_result"), tags: v("f_tags"), links: v("f_links") };
}
function isDirty() { return !!(state.detail && state.detail.snap && $("f_title") && JSON.stringify(readForm()) !== state.detail.snap); }
function confirmLeave() { return !isDirty() || confirm("저장하지 않은 변경이 있습니다. 버릴까요?"); }
function openDetail(id, preset) {
  if (!confirmLeave()) return;
  state.detail = { id: id || null, preset: preset || {} };
  render();
}
function closeDetail() {
  if (!confirmLeave()) return false;
  state.detail = null; render(); return true;
}
function newPreset() { return state.day ? { due: state.day } : {}; }
function jumpTo(it) {                                  // 방금 저장한 할 일이 보이게 한다: 날짜 필터 밖이면 필터를 풀고, 현재 탭에 안 나오면 그 할 일이 속한 탭으로 옮긴다
  if (state.day) {
    const s = it.start || it.due, e = it.due || it.start;
    if (!s || !(s <= state.day && state.day <= e)) state.day = "";
  }
  if (!state.day) showTab(it);
}
function showTab(it) { const t = tabOfSection(sectionOf(it)); if (t) state.tab = t; }
async function submitForm(e) {
  e.preventDefault();
  const body = readForm(); $("formMsg").textContent = "";
  const d = state.detail, old = d.id ? state.items.find((x) => x.id === d.id) : null;
  try {
    let saved;
    if (d.id) {
      const r = await api("PUT", `item/${d.id}`, body); saved = r.item || r;
      if (r.spawned) toast(`반복 과제: 다음 회차(${r.spawned.due})를 만들었습니다.`); else toast("저장했습니다.");
    } else { saved = await api("POST", "items", body); toast("추가했습니다."); }
    state.detail = null;
    if (!old || (old.start || "") !== (saved.start || "") || (old.due || "") !== (saved.due || "")) jumpTo(saved);   // 날짜가 바뀌었을 때만 따라간다
    await refresh();
  } catch (err) { $("formMsg").textContent = err.message; }                  // 상세를 닫지 않고 입력을 보존한다
}
async function deleteItem() {
  const d = state.detail; if (!d || !d.id) return;
  const it = state.items.find((x) => x.id === d.id);
  if (!confirm(`‘${it ? it.title : ""}’ 을(를) 삭제할까요? 되돌릴 수 없습니다.`)) return;
  try { await api("DELETE", `item/${d.id}`); state.detail = null; toast("삭제했습니다."); await refresh(); }
  catch (err) { $("formMsg").textContent = err.message; }
}
async function setDone(it, done) {
  try {
    const r = await api("PUT", `item/${it.id}`, { status: done ? "완료" : "미착수" });
    if (r.spawned) toast(`반복 과제: 다음 회차(${r.spawned.due})를 만들었습니다.`);
    await refresh();
  } catch (e) { banner(e.message, true); }
}
async function changeStatus(id, status) {
  const r = await api("PUT", `item/${id}`, { status });
  if (r.spawned) toast(`반복 과제: 다음 회차(${r.spawned.due})를 만들었습니다.`);
  await refresh();
}
function setView(v) {
  if (!confirmLeave()) return;
  state.detail = null; state.view = v; store.set("th.view3", v); render();
}

/* ───────── 보관함(링크·사진·메모) ───────── */
const CLIP_LABEL = { link: "링크", photo: "사진", note: "메모", file: "파일" };
const photoUrls = new Map();                                                    // 사진 id → 화면용 주소(바꿀 때 해제해서 메모리가 새지 않게 한다)
function revokePhotoUrls() { for (const u of photoUrls.values()) URL.revokeObjectURL(u); photoUrls.clear(); }
function safeHref(u) { return typeof u === "string" && /^https?:\/\//i.test(u) && !/[\s\x00-\x1f\x7f]/.test(u) ? u : ""; }   // 저장된 값이 조작됐어도 http/https 만 링크로 만든다
function layoutClips() {
  const main = $("main");
  if (!$("clipMain")) main.replaceChildren(el("section", { class: "stage-main", id: "clipMain" }), el("aside", { class: "side", id: "side", "aria-label": "보관함 필터" }));
  main.className = "stage has-side"; main.dataset.view = "clips";
  document.body.classList.toggle("detail-open", !!state.clipDetail);
}
async function loadPhoto(c, img) {
  try {
    let url = photoUrls.get(c.id);
    if (!url) {
      if (LOCAL) url = URL.createObjectURL(await window.THLocal.photoBlob(c.id));
      else url = `/api/clips/${encodeURIComponent(c.id)}/file?space=${state.space}`;
      if (LOCAL) photoUrls.set(c.id, url);
    }
    img.src = url;
  } catch (e) { img.replaceWith(el("div", { class: "ph-missing", text: "사진 없음", title: e.message })); }
}
function fmtBytes(n) { return n < 1024 ? n + "B" : n < 1048576 ? Math.round(n / 1024) + "KB" : (n / 1048576).toFixed(1) + "MB"; }
function clipCard(c, opts = {}) {
  const head = c.kind === "photo" ? el("div", { class: "thumb" }, (() => { const i = el("img", { alt: c.title || "사진", loading: "lazy", decoding: "async" }); loadPhoto(c, i); return i; })())
    : c.kind === "link" ? el("div", { class: "linkhead" }, el("span", { class: "fav", text: (c.host || "?").slice(0, 1).toUpperCase() }), el("span", { class: "host", text: c.host }))
    : c.kind === "file" ? el("div", { class: "filehead" }, el("span", { class: "ext", text: (c.name.split(".").pop() || "").toUpperCase().slice(0, 4) }), el("span", { class: "fname", text: c.name }))
    : null;
  return el("div", { class: "ccard " + c.kind, role: "button", tabindex: "0", "data-id": c.id, onclick: () => openClip(c.id), onkeydown: (e) => { if (e.key === "Enter") openClip(c.id); } },
    head,
    c.title ? el("div", { class: "ct", text: c.title }) : (c.kind === "link" ? el("div", { class: "ct sub", text: c.url }) : null),
    c.kind === "file" ? el("div", { class: "ct sub", text: fmtBytes(c.bytes) }) : null,
    c.body ? el("div", { class: "cb", text: c.body }) : null,
    (c.tags || []).length ? el("div", { class: "ctags" }, c.tags.map((t) => el("span", { class: "tag", text: t }))) : null,
    opts.showTime && fmtClockIso(c.created) ? el("div", { class: "cwhen", text: fmtClockIso(c.created) }) : null);
}
/* 보관함 이력: 보관한 날짜(created 의 날짜 부분)별로 묶는다. 최근 날짜 먼저, 같은 날은 늦게 보관한 것 먼저. 날짜 없는 것은 따로. */
function clipDay(c) { return /^\d{4}-\d{2}-\d{2}/.test(c.created || "") ? c.created.slice(0, 10) : ""; }
function fmtClockIso(iso) {                                                    // "2026-10-28T15:42:00" → "오후 3:42"
  const m = /T(\d{2}):(\d{2})/.exec(iso || ""); if (!m) return "";
  const h = +m[1]; return `${h < 12 ? "오전" : "오후"} ${h % 12 || 12}:${m[2]}`;
}
function clipMonths(clips) { return [...new Set(clips.map(clipDay).filter(Boolean).map((d) => d.slice(0, 7)))].sort().reverse(); }
function clipGroups(clips, month) {
  const dated = clips.filter((c) => clipDay(c) && (!month || clipDay(c).startsWith(month))), by = new Map();
  for (const c of dated) { const d = clipDay(c); if (!by.has(d)) by.set(d, []); by.get(d).push(c); }
  const t = todayIso(), ty = t.slice(0, 4);
  const groups = [...by.keys()].sort().reverse().map((d) => {
    const n = dayDiff(t, d), items = by.get(d).sort((a, b) => (a.created === b.created ? (a.id < b.id ? 1 : -1) : a.created < b.created ? 1 : -1));
    const label = n === 0 ? "오늘" : n === -1 ? "어제" : `${d.slice(0, 4) === ty ? "" : d.slice(0, 4) + "년 "}${+d.slice(5, 7)}월 ${+d.slice(8)}일 ${DOW[dowOf(d)]}요일`;
    return { date: d, label, items };
  });
  return { groups, undated: month ? [] : clips.filter((c) => !clipDay(c)) };
}
const CLIP_ICON = { link: "링크", photo: "사진", note: "메모", file: "파일" };
/* ───────── 저장 공간 · 정리 ─────────
   자동으로 지우는 일은 없다(기한 없음). 공간이 80% 이상 차면 ‘정리하기’ 안내만 띄우고, 무엇을 지울지는 사용자가 고른다. */
async function getStorage() {
  try {
    if (LOCAL) return await window.THLocal.storage();
    const s = await api("GET", "storage");
    return { used: s.used, files: s.files, clips: s.clips, free: s.free, total: s.total, known: true, low: !!s.low };
  } catch (e) { return null; }
}
async function checkStorage() {                                                  // 앱을 열 때 한 번: 거의 찼으면 안내
  const s = await getStorage();
  state.storage = s;
  if (s && s.low) banner(`저장 공간이 거의 찼습니다(남은 공간 ${fmtBytes(s.free)}). 메뉴 ‘저장 공간 정리’에서 큰 자료부터 지울 수 있습니다. 자동으로 지워지는 것은 없습니다.`, false);
}
async function showCleanup() {
  const s = (await getStorage()) || { used: 0, files: 0, free: 0, total: 0, known: false, low: false };
  const big = state.clips.filter((c) => (c.kind === "photo" || c.kind === "file") && c.bytes).sort((a, b) => b.bytes - a.bytes);
  const sel = new Set();
  const total = el("div", { class: "help", id: "cleanTotal", role: "status" });
  const delBtn = el("button", { class: "btn danger", type: "button", id: "btnCleanDelete", text: "선택한 자료 지우기", disabled: true });
  const sync = () => {
    const bytes = big.filter((c) => sel.has(c.id)).reduce((n, c) => n + c.bytes, 0);
    total.textContent = sel.size ? `${sel.size}개 선택 · ${fmtBytes(bytes)} 확보` : "지울 자료를 고르세요. 지운 자료는 되돌릴 수 없습니다.";
    delBtn.disabled = !sel.size;
  };
  const list = big.length ? el("div", { class: "clean-list" }, big.slice(0, 200).map((c) => {
    const cb = el("input", { type: "checkbox", "aria-label": (c.name || c.title || CLIP_LABEL[c.kind]) + " 선택", onchange: (e) => { e.target.checked ? sel.add(c.id) : sel.delete(c.id); sync(); } });
    return el("label", { class: "clean-row" }, cb, el("span", { class: "hkind", text: CLIP_ICON[c.kind] }),
      el("span", { class: "cn", text: c.kind === "file" ? c.name : (c.title || "사진") }),
      el("span", { class: "cd", text: clipDay(c) ? `${+clipDay(c).slice(5, 7)}/${+clipDay(c).slice(8)}` : "" }), el("span", { class: "cs", text: fmtBytes(c.bytes) }));
  })) : el("p", { class: "help", text: "사진·파일이 없습니다. 링크와 메모는 용량이 거의 없어 정리할 필요가 없습니다." });
  const pct = s.known && s.total ? Math.min(100, Math.round((s.used / s.total) * 100)) : null;
  delBtn.onclick = async () => {
    const n = sel.size, bytes = big.filter((c) => sel.has(c.id)).reduce((x, c) => x + c.bytes, 0);
    if (!confirm(`선택한 ${n}개(${fmtBytes(bytes)})를 지울까요? 되돌릴 수 없습니다.`)) return;
    delBtn.disabled = true;
    let done = 0;
    for (const id of [...sel]) { try { await api("DELETE", `clips/${id}`); done++; } catch (e) { /* 이미 없는 것은 건너뛴다 */ } }
    toast(`${done}개를 지웠습니다.`); $("modal").hidden = true; await refresh(); await checkStorage();
  };
  openModal("저장 공간 정리", el("div", { class: "cleanup" },
    el("div", { class: "meter", role: "img", "aria-label": pct === null ? "사용량 알 수 없음" : `사용량 ${pct}%` }, el("i", { style: `width:${pct === null ? 0 : pct}%` , class: s.low ? "hot" : "" })),
    el("p", { class: "help" }, s.known ? `사진·파일 ${fmtBytes(s.files)} · 이 기기에서 쓸 수 있는 공간 ${fmtBytes(s.free)} 남음${LOCAL ? "(브라우저가 허락한 범위)" : "(디스크 여유)"}.` : "이 브라우저는 남은 공간을 알려주지 않습니다."),
    s.low ? el("p", { class: "banner", text: "거의 찼습니다. 큰 자료부터 정리하세요." }) : null,
    el("p", { class: "help", text: "오래된 자료가 저절로 지워지는 일은 없습니다. 아래 목록은 큰 순서이며, 지울 것만 직접 고릅니다." }),
    list, total, el("div", { class: "row-btns" }, delBtn)), false);
  sync();
}
function clipRow(c) {                                                           // 이력 보기의 한 줄: 종류 · 제목/내용 요약 · 보관한 시각
  const text = c.kind === "file" ? c.name : c.title || (c.kind === "link" ? c.host : (c.body || "").split("\n")[0]) || CLIP_ICON[c.kind];
  const sub = c.kind === "link" ? c.url : c.kind === "file" ? fmtBytes(c.bytes) : c.title && c.body ? c.body.split("\n")[0] : "";
  const thumb = c.kind === "photo" ? (() => { const i = el("img", { alt: "", loading: "lazy", decoding: "async" }); loadPhoto(c, i); return el("span", { class: "hthumb" }, i); })() : null;
  return el("div", { class: "hrow " + c.kind, role: "button", tabindex: "0", "data-id": c.id, onclick: () => openClip(c.id), onkeydown: (e) => { if (e.key === "Enter") openClip(c.id); } },
    thumb || el("span", { class: "hkind", text: CLIP_ICON[c.kind] }),
    el("span", { class: "hmain" }, el("span", { class: "ht", text: text }), sub ? el("span", { class: "hs", text: sub }) : null,
      (c.tags || []).length ? el("span", { class: "hs tags", text: c.tags.map((t) => "#" + t).join(" ") }) : null),
    el("span", { class: "hwhen", text: fmtClockIso(c.created) }));
}
function clipsShown() {
  let list = state.clips.filter((c) => state.clipKind === "all" || c.kind === state.clipKind);
  if (state.clipTag) list = list.filter((c) => (c.tags || []).includes(state.clipTag));
  return window.THCore ? window.THCore.clipFilter(list, state.q) : list.filter((c) => [c.title, c.body, c.url, (c.tags || []).join(" ")].join(" ").toLowerCase().includes(state.q.trim().toLowerCase()));
}
function clipAdder() {
  const inp = el("textarea", { id: "clipAdd", class: "qa multi", rows: "1", placeholder: "링크·메모 붙여넣기 (Enter)", autocomplete: "off", "aria-label": "보관함에 추가" });
  inp.addEventListener("input", () => { inp.style.height = "auto"; inp.style.height = Math.min(inp.scrollHeight, 160) + "px"; });      // 입력한 줄 수만큼 늘어난다
  const add = async () => {
    const v = inp.value.trim(); if (!v) return;
    const isUrl = /^https?:\/\/\S+$/i.test(v);
    inp.disabled = true;
    try { await api("POST", "clips", isUrl ? { kind: "link", url: v } : { kind: "note", body: v }); toast("보관했습니다."); inp.value = ""; await refreshClips(); }
    catch (err) { banner(err.message, true); }
    const again = $("clipAdd"); if (again) { again.disabled = false; again.style.height = ""; again.focus(); }
  };
  inp.addEventListener("keydown", (e) => { if (e.key !== "Enter" || e.shiftKey || e.isComposing || e.keyCode === 229) return; e.preventDefault(); add(); });   // Shift+Enter 는 줄바꿈
  const file = el("input", { type: "file", multiple: true, hidden: true, id: "clipFile" });
  file.addEventListener("change", () => { addFiles([...file.files]); file.value = ""; });
  return el("div", { class: "clip-add" }, inp, el("button", { class: "btn", id: "btnPhoto", type: "button", "aria-label": "파일·사진 추가", text: "📎 파일·사진", onclick: () => file.click() }), file);
}
async function uploadOneFile(f, extra) {                                        // 파일 하나를 보관함에 올린다(내투두: 브라우저 저장소, 업투두: 서버로 조각 전송)
  const meta = Object.assign({ name: f.name, title: "" }, extra || {});
  if (LOCAL) return window.THLocal.addFile(f, meta);
  const res = await fetch(`/api/clips/file?space=${state.space}`, { method: "POST", headers: { "Content-Type": "application/octet-stream", "X-TaskHub": "1", "X-Clip-Meta": encodeURIComponent(JSON.stringify(meta)) }, body: f });
  const d = await res.json().catch(() => null);
  if (!res.ok) throw new Error((d && d.error) || `업로드 실패 (${res.status})`);
  return d;
}
async function addFiles(files) {                                                // 이미지는 줄여서 사진으로, 그 외는 파일로 보관한다
  const imgs = files.filter((f) => /^image\//.test(f.type) && !/\.svg$/i.test(f.name || ""));
  const docs = files.filter((f) => !imgs.includes(f));
  if (imgs.length) await addPhotos(imgs);
  let ok = 0, bad = "";
  for (const f of docs) {
    try { await uploadOneFile(f); ok++; }
    catch (e) { bad = `${f.name}: ${e.message}`; }
  }
  if (ok) toast(ok === 1 ? "파일을 보관했습니다." : `파일 ${ok}개를 보관했습니다.`);
  if (bad) banner(bad, true);
  if (docs.length) await refreshClips();
}
async function addPhotos(files) {
  files = files.filter((f) => /^image\//.test(f.type) || !f.type);
  if (!files.length) { toast("이미지 파일만 올릴 수 있습니다."); return; }
  let ok = 0, bad = "";
  for (const f of files) {
    try {
      const out = await window.THPhoto.shrink(f);
      const meta = { title: (f.name || "").replace(/\.[^.]+$/, "").slice(0, 80), w: out.w, h: out.h };
      if (LOCAL) await window.THLocal.addPhoto(out.blob, meta);
      else {
        const res = await fetch(`/api/clips/photo?space=${state.space}`, { method: "POST", headers: { "Content-Type": out.mime, "X-TaskHub": "1", "X-Clip-Meta": encodeURIComponent(JSON.stringify(meta)) }, body: out.blob });
        const d = await res.json().catch(() => null);
        if (!res.ok) throw new Error((d && d.error) || `업로드 실패 (${res.status})`);
      }
      ok++;
    } catch (e) { bad = e.message; }
  }
  if (ok) toast(ok === 1 ? "사진을 보관했습니다." : `사진 ${ok}장을 보관했습니다.`);
  if (bad) banner(bad, true);
  await refreshClips();
}
function renderClips(opts = {}) {
  const box = $("clipMain");
  if (opts.keepDirty && state.clipDetail && isClipDirty()) return;
  revokePhotoUrls();
  if (state.clipDetail && state.clipDetail.id && !state.clips.some((c) => c.id === state.clipDetail.id)) state.clipDetail = null;
  document.body.classList.toggle("detail-open", !!state.clipDetail);
  if (state.clipDetail) { box.replaceChildren(renderClipDetail()); state.clipDetail.snap = JSON.stringify(readClipForm()); renderClipSide(); return; }
  const list = clipsShown();
  const hist = state.clipLayout === "history";
  const g = hist ? clipGroups(list, state.clipMonth) : null;
  const body = !list.length ? null
    : hist ? el("div", { class: "history" }, g.groups.map((x) => el("section", { class: "day", "data-date": x.date },
        el("h3", { class: "day-h" }, x.label, el("span", { class: "n", text: String(x.items.length) })), el("div", { class: "hlist" }, x.items.map(clipRow)))),
        g.undated.length ? el("section", { class: "day", "data-date": "" }, el("h3", { class: "day-h" }, "보관한 날짜를 알 수 없음", el("span", { class: "n", text: String(g.undated.length) })), el("div", { class: "hlist" }, g.undated.map(clipRow))) : null)
    : el("div", { class: "cgrid" }, list.map((c) => clipCard(c)));
  box.replaceChildren(clipAdder(),
    body ? body
      : el("div", { class: "empty" }, el("b", { text: state.q.trim() || state.clipKind !== "all" || state.clipTag ? "조건에 맞는 자료가 없습니다." : "보관함이 비어 있습니다." }),
          state.q.trim() || state.clipKind !== "all" || state.clipTag ? null : "링크를 붙여넣거나 메모를 적고 Enter, 사진은 📷 로 올리세요."));
  renderClipSide();
}
function renderClipSide() {
  const n = (k) => state.clips.filter((c) => k === "all" || c.kind === k).length;
  const tags = [...new Set(state.clips.flatMap((c) => c.tags || []))].sort((a, b) => a.localeCompare(b, "ko"));
  const months = clipMonths(state.clips);
  $("side").replaceChildren(el("div", { class: "cfilter" },
    el("h2", { class: "cal-title", text: "보관함" }),
    el("div", { class: "seg lay", role: "group", "aria-label": "보기" }, [["history", "이력"], ["grid", "모아보기"]].map(([k, label]) =>
      el("button", { type: "button", class: state.clipLayout === k ? "on" : "", "data-layout": k, onclick: () => { state.clipLayout = k; store.set("th.cliplayout", k); render(); } }, label))),
    months.length > 1 ? el("select", { id: "clipMonth", class: "monthsel", "aria-label": "월 선택", onchange: (e) => { state.clipMonth = e.target.value; render(); } },
      el("option", { value: "", text: "전체 기간" }), months.map((m) => el("option", { value: m, selected: m === state.clipMonth, text: `${m.slice(0, 4)}년 ${+m.slice(5)}월` }))) : null,
    el("div", { class: "seg", role: "group", "aria-label": "종류" }, [["all", "전체"], ["link", "링크"], ["photo", "사진"], ["file", "파일"], ["note", "메모"]].map(([k, label]) =>
      el("button", { type: "button", class: state.clipKind === k ? "on" : "", "data-kind": k, onclick: () => { if (!confirmLeaveClip()) return; state.clipDetail = null; state.clipKind = k; render(); } }, label + " ", el("span", { class: "n", text: String(n(k)) })))),
    tags.length ? el("div", { class: "tagbar" }, el("div", { class: "menu-label", text: "태그" }), el("div", { class: "ctags" }, tags.map((t) =>
      el("button", { type: "button", class: "tag" + (state.clipTag === t ? " on" : ""), onclick: () => { if (!confirmLeaveClip()) return; state.clipDetail = null; state.clipTag = state.clipTag === t ? "" : t; render(); }, text: t })))) : null,
    LOCAL && !(window.THLocal && window.THLocal.blobs && window.THLocal.blobs.kind === "indexeddb") ? el("p", { class: "help warn", text: "이 브라우저에서는 사진을 영구 저장할 수 없어 새로고침하면 사라집니다." }) : null));
}
async function refreshClips() {
  try { state.clips = await api("GET", "clips"); clearConnBanner(); } catch (e) { banner(e.message, true, "conn"); }
  render({ keepDirty: true });
}
function clipPreset() { return {}; }
function openClip(id, preset) { if (!confirmLeaveClip()) return; state.clipDetail = { id: id || null, preset: preset || {} }; render(); }
function closeClip() { if (!confirmLeaveClip()) return false; state.clipDetail = null; render(); return true; }
function readClipForm() {
  const v = (i) => ($(i) ? $(i).value : "");
  return { title: v("c_title"), url: v("c_url"), body: v("c_body"), tags: v("c_tags"), item: v("c_item") };
}
function isClipDirty() { return !!(state.clipDetail && state.clipDetail.snap && $("c_title") && JSON.stringify(readClipForm()) !== state.clipDetail.snap); }
function confirmLeaveClip() { return !isClipDirty() || confirm("저장하지 않은 변경이 있습니다. 버릴까요?"); }
function renderClipDetail() {
  const d = state.clipDetail, c = state.clips.find((x) => x.id === d.id), isNew = !c, kind = c ? c.kind : (d.preset.kind || "note");
  const cl = c || Object.assign({ kind, title: "", url: "", body: "", tags: [], item: "" }, d.preset);
  const href = kind === "link" ? safeHref(cl.url) : "";
  const taskOpts = [{ id: "", title: "(연결 안 함)" }].concat(state.items.filter((x) => !isDone(x)).map((x) => ({ id: x.id, title: x.title })));
  return el("form", { class: "detail clipdetail", id: "clipForm", autocomplete: "off", onsubmit: submitClip },
    el("div", { class: "d-head" }, el("button", { class: "back", type: "button", id: "btnBack", text: "‹ 보관함", onclick: closeClip }), el("div", { class: "spacer" }),
      el("span", { class: "pill-label", text: CLIP_LABEL[kind] }),
      isNew ? null : el("button", { class: "link danger", type: "button", id: "btnClipDelete", text: "삭제", onclick: deleteClip })),
    kind === "file" ? el("div", { class: "linkbox" }, el("button", { class: "open-link dl", type: "button", id: "btnDownload", text: `⬇ ${cl.name} 내려받기 (${fmtBytes(cl.bytes)})`, onclick: () => downloadFile(cl) }), el("div", { class: "help", text: "보관한 파일은 화면에서 열지 않고 내려받아 엽니다." })) : null,
    !isNew && cl.created ? el("div", { class: "help when", text: `보관한 때: ${cl.created.slice(0, 10)} ${fmtClockIso(cl.created)}` }) : null,
    kind === "photo" ? el("div", { class: "bigthumb" }, (() => { const i = el("img", { alt: cl.title || "사진" }); loadPhoto(cl, i); return i; })()) : null,
    kind === "link" ? el("div", { class: "linkbox" }, href ? el("a", { class: "open-link", href, target: "_blank", rel: "noopener noreferrer", text: `${cl.host} 열기 ↗` }) : el("span", { class: "help", text: "열 수 없는 주소입니다." }), el("div", { class: "help url", text: cl.url })) : null,
    fld("제목", inputEl("c_title", "text", cl.title, { placeholder: kind === "link" ? "예: 금융위 보도자료 (비워도 됩니다)" : "비워도 됩니다", maxlength: "200" }), { full: true }),
    kind === "link" ? el("details", { class: "span-more", id: "urlMore", open: !href }, el("summary", { text: "주소 고치기" }),
      fld("주소", inputEl("c_url", "url", cl.url, { required: true, maxlength: "2048", placeholder: "https://" }), { full: true })) : null,
    kind === "note" || kind === "link" || kind === "photo" ? fld(kind === "note" ? "메모" : "내용", textareaEl("c_body", cl.body, kind === "note" ? 8 : 4), { full: true }) : null,
    fld("태그", inputEl("c_tags", "text", (cl.tags || []).join(", "), { placeholder: "쉼표로 구분" }), { full: true }),
    fld("연결할 할 일", el("select", { id: "c_item" }, taskOpts.map((o) => el("option", { value: o.id, selected: o.id === (cl.item || ""), text: o.title }))), { full: true, help: "할 일 상세의 ‘관련 자료’에 나타납니다." }),
    el("div", { class: "d-foot" }, el("span", { class: "msg", id: "formMsg", role: "alert" }),
      el("button", { class: "btn", type: "button", id: "btnCancel", text: "취소", onclick: closeClip }), el("button", { class: "btn primary", type: "submit", id: "btnSave", text: "저장" })));
}
async function downloadFile(c) {
  try {
    let href, revoke = false;
    if (LOCAL) { const r = await window.THLocal.fileBlob(c.id); href = URL.createObjectURL(new Blob([r.blob], { type: "application/octet-stream" })); revoke = true; }
    else href = `/api/clips/${encodeURIComponent(c.id)}/download?space=${state.space}`;
    const a = el("a", { href, download: c.name }); document.body.append(a); a.click(); a.remove();
    if (revoke) setTimeout(() => URL.revokeObjectURL(href), 4000);
  } catch (e) { banner(e.message, true); }
}
async function submitClip(e) {
  e.preventDefault();
  const body = readClipForm(); $("formMsg").textContent = "";
  const d = state.clipDetail;
  if (state.clips.find((x) => x.id === d.id)?.kind !== "link") delete body.url;
  if (state.clips.find((x) => x.id === d.id)?.kind === "file") body.name = body.name || state.clips.find((x) => x.id === d.id).name;
  try { await api("PUT", `clips/${d.id}`, body); toast("저장했습니다."); state.clipDetail = null; await refreshClips(); }
  catch (err) { $("formMsg").textContent = err.message; }
}
async function deleteClip() {
  const d = state.clipDetail; if (!d || !d.id) return;
  const c = state.clips.find((x) => x.id === d.id);
  if (!confirm(`‘${(c && (c.title || c.host)) || CLIP_LABEL[c.kind]}’ 을(를) 지울까요? 되돌릴 수 없습니다.`)) return;
  try { await api("DELETE", `clips/${d.id}`); state.clipDetail = null; toast("삭제했습니다."); await refreshClips(); }
  catch (err) { $("formMsg").textContent = err.message; }
}

/* ───────── 주간보고(업투두) · 백업(내투두) ───────── */
async function showReport() {
  if (LOCAL) { await showBackup(); return; }
  try { const r = await api("GET", "report"); openModal("주간보고 문안 (복사해서 붙여 넣기)", r.text, true); }
  catch (e) { banner(e.message, true); }
}
function openModal(title, content, copyable) {
  $("modalTitle").textContent = title;
  const box = $("modalText");
  box.classList.toggle("plain", typeof content !== "string");
  if (typeof content === "string") box.textContent = content; else box.replaceChildren(content);
  $("modalCopy").hidden = !copyable;
  $("modal").hidden = false;
}
function versionLine() {                                                  // build_phone.py 가 만든 version.js 가 있을 때만(내투두)
  const v = window.TH_VERSION;
  if (!v) return null;
  return el("p", { class: "help ver", text: `${APP_NAME} v${v.version} (빌드 ${v.build}${v.date ? ` · ${v.date}` : ""})` });
}
function fileStamp() { const n = new Date(), p = (x) => String(x).padStart(2, "0"); return `${n.getFullYear()}${p(n.getMonth() + 1)}${p(n.getDate())}_${p(n.getHours())}${p(n.getMinutes())}`; }
async function showBackup() {
  const L = window.THLocal, st = L.stats();
  const photoCount = state.clips.filter((c) => c.kind === "photo" || c.kind === "file").length;       // 본체를 따로 갖는 항목(사진·파일). 기본 백업에는 이 본체가 들어가지 않는다
  const msg = el("div", { class: "help", role: "status" });
  const fileIn = el("input", { type: "file", accept: "application/json,.json", hidden: true, id: "restoreFile" });
  const note = (t, bad) => { msg.textContent = t; msg.style.color = bad ? "var(--red)" : "var(--green)"; };
  const BACKUP_BODY_CAP = 300 * 1024 * 1024;                                    // base64 로 한 덩어리 문자열을 만들므로(약 1.33배 + 복사본) 본체 합계 300MB 까지만
  const bodyBytes = state.clips.filter((c) => c.kind === "photo" || c.kind === "file").reduce((n, c) => n + (c.bytes || 0), 0);
  const save = async (withPhotos) => {
    if (withPhotos && bodyBytes > BACKUP_BODY_CAP) {
      note(`사진·파일이 ${fmtBytes(bodyBytes)}라 한 파일로 묶으면 브라우저가 멈출 수 있어 중단했습니다(상한 ${fmtBytes(BACKUP_BODY_CAP)}). 큰 파일은 ‘저장 공간 정리’로 줄이거나, 중요한 파일은 보관함에서 직접 내려받아 따로 보관하세요. ‘백업 파일 저장’은 할 일·링크·메모에 쓸 수 있습니다.`, true);
      return;
    }
    try {
      note(withPhotos ? "사진을 모으는 중입니다…" : "");
      const data = await L.exportData({ withPhotos });
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const a = el("a", { href: URL.createObjectURL(blob), download: `naetodo_${fileStamp()}${withPhotos ? "_사진파일포함" : ""}.json` });
      document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      const mb = (blob.size / 1048576).toFixed(1);
      note(`백업 파일을 저장했습니다(${mb}MB). 파일 앱/다운로드에서 확인하세요.` + (!withPhotos && data.counts.photosWithoutData ? ` 사진·파일 ${data.counts.photosWithoutData}개의 본체는 이 파일에 없습니다.` : ""));
    } catch (e) { note("백업하지 못했습니다: " + e.message, true); }
  };
  const body = el("div", { class: "backup" },
    el("p", {}, `저장된 할 일 ${st.count}건 · 보관함 ${st.clips}건` + (photoCount ? ` (사진·파일 ${photoCount}개)` : "")),
    st.persistent ? null : el("p", { class: "banner err", text: "이 브라우저는 저장을 막고 있어 새로고침하면 데이터가 사라집니다. 일반 모드(비공개 모드 아님)로 여세요." }),
    st.recovered ? el("p", { class: "banner", text: "저장된 데이터가 손상돼 복구용 사본을 남기고 새로 시작했습니다." }) : null,
    el("p", { class: "help", text: "데이터는 이 기기의 이 브라우저에만 있습니다. 기기를 바꾸거나 브라우저 데이터를 지우면 사라지므로, 정기적으로 파일로 저장해 두세요. 폰과 PC 사이로 옮길 때도 이 파일을 씁니다." }),
    photoCount ? el("p", { class: "banner", text: `‘백업 파일 저장’에는 사진·파일 ${photoCount}개의 본체가 들어가지 않습니다. 함께 옮기려면 ‘사진·파일 포함 백업’을 쓰세요(백업 파일이 커집니다).` }) : null,
    el("div", { class: "row-btns" },
      el("button", { class: "btn primary", type: "button", id: "btnBackup", text: "백업 파일 저장", onclick: () => save(false) }),
      photoCount ? el("button", { class: "btn", type: "button", id: "btnBackupPhotos", text: `사진·파일 포함 백업 (${fmtBytes(bodyBytes)})`, onclick: () => save(true) }) : null,
      el("button", { class: "btn", type: "button", text: "백업에서 복원", onclick: () => fileIn.click() }),
      L.hasPrev() ? el("button", { class: "btn", type: "button", text: "복원 취소(직전 상태로)", onclick: async () => {
        if (!confirm("방금 복원하기 전 상태로 되돌릴까요?")) return;
        try { L.restorePrev(); note("직전 상태로 되돌렸습니다."); await refresh(); await refreshClips(); } catch (e) { note(e.message, true); }
      } }) : null),
    msg, fileIn, versionLine());
  fileIn.addEventListener("change", async () => {
    const f = fileIn.files && fileIn.files[0]; if (!f) return;
    if (f.size > 200_000_000) { note("파일이 너무 큽니다(200MB 초과).", true); return; }
    const parsed = L.sanitizeImport(await f.text());
    if (!parsed.ok) { note("복원하지 못했습니다: " + parsed.error, true); return; }
    const noBody = parsed.clips ? parsed.clips.filter((c) => c.kind === "photo" && !(parsed.photos && parsed.photos[c.blob])).length : 0;
    const lines = [`백업 파일의 할 일 ${parsed.items.length}건` + (parsed.clips ? `, 보관함 ${parsed.clips.length}건` : "") + `으로 현재 ${st.count}건을 바꿉니다.`];
    if (!parsed.clips) lines.push("(이 백업에는 보관함 정보가 없어 현재 보관함은 그대로 둡니다.)");
    if (noBody) lines.push(`※ 사진 ${noBody}장은 본체가 백업에 없어 ‘사진 없음’으로 보입니다.`);
    lines.push("(바꾸기 전 상태는 ‘복원 취소’로 되돌릴 수 있습니다.)");
    if (!confirm(lines.join("\n"))) { fileIn.value = ""; return; }
    try { await L.replaceAll(parsed.items, parsed.clips, parsed.photos); note(`${parsed.items.length}건을 복원했습니다.` + (noBody ? ` 사진 ${noBody}장은 본체가 없습니다.` : "")); state.detail = null; state.clipDetail = null; await refresh(); }
    catch (e) { note(e.message, true); }
    fileIn.value = "";
  });
  openModal("백업 / 복원", body, false);
}

/* ───────── 데이터 새로고침·초기화 ───────── */
async function refresh() {
  try {
    const [items, inbox, clips] = await Promise.all([api("GET", "items?period=all"), api("GET", "inbox"), api("GET", "clips")]);
    Object.assign(state, { items, inbox, clips }); clearConnBanner();
  } catch (e) { banner(e.message, true, "conn"); }
  render({ keepDirty: true });
}
async function init() {
  buildShell();
  state.density = store.get("th.density", "roomy") === "tight" ? "tight" : "roomy"; document.body.dataset.density = state.density;
  state.view = store.get("th.view3", "list"); if (!VIEWS.some(([k]) => k === state.view)) state.view = "list";
  state.page = store.get("th.page", "tasks") === "clips" ? "clips" : "tasks";
  state.clipLayout = store.get("th.cliplayout", "history") === "grid" ? "grid" : "history";
  try { state.meta = await api("GET", "meta"); }
  catch (e) { banner(e.message, true); return; }
  { const t = todayIso(); state.cal.y = +t.slice(0, 4); state.cal.m = +t.slice(5, 7); }
  document.title = APP_NAME;
  document.body.classList.toggle("local", LOCAL);
  $("btnNew").onclick = $("btnFab").onclick = () => { if (state.page === "clips") { const i = $("clipAdd"); if (i) i.focus(); } else openDetail(null, newPreset()); };
  $("btnMenu").onclick = (e) => { e.stopPropagation(); toggleMenu(); };
  $("viewMode").addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; toggleMenu(false); setView(b.dataset.v); });
  $("densityMode").addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; setDensity(b.dataset.d); });
  $("btnReport").onclick = () => { toggleMenu(false); showReport(); };
  $("btnCleanup").onclick = () => { toggleMenu(false); showCleanup(); };
  $("modalClose").onclick = $("modalBg").onclick = () => ($("modal").hidden = true);
  $("modalCopy").onclick = async () => { try { await navigator.clipboard.writeText($("modalText").textContent); toast("복사했습니다."); } catch (e) { toast("복사하지 못했습니다. 직접 선택해 복사하세요."); } };
  document.querySelectorAll(".pg").forEach((b) => b.addEventListener("click", () => setPage(b.dataset.page)));
  $("search").addEventListener("input", (e) => { state.q = e.target.value; if (state.page === "clips") renderClips(); else { renderLeft(); renderCal(); } });
  document.addEventListener("paste", (e) => {                                  // 스크린샷·복사한 이미지를 Ctrl+V 로 바로 보관
    if (state.page !== "clips" || /INPUT|TEXTAREA/.test(document.activeElement.tagName)) return;
    const files = [...(e.clipboardData ? e.clipboardData.files : [])];
    if (files.length) { e.preventDefault(); addFiles(files); }
  });
  document.addEventListener("dragover", (e) => { if (state.page === "clips" && e.dataTransfer && [...e.dataTransfer.types].includes("Files")) e.preventDefault(); });
  document.addEventListener("drop", (e) => {
    if (state.page !== "clips" || !e.dataTransfer || !e.dataTransfer.files.length) return;
    e.preventDefault(); addFiles([...e.dataTransfer.files]);
  });
  document.addEventListener("click", (e) => { if (!e.target.closest(".menu-wrap")) toggleMenu(false); if (!e.target.closest(".datepick, .adddate")) closeDatePick(); });
  document.addEventListener("keydown", (e) => {
    const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName);
    if (e.key === "Escape" && $("datepick")) { closeDatePick(); return; }
    if (e.key === "Escape") { if (!$("modal").hidden) $("modal").hidden = true; else if (!$("menu").hidden) toggleMenu(false); else if (state.detail) closeDetail(); else if (state.clipDetail) closeClip(); }
    else if (e.key === "n" && !e.metaKey && !e.ctrlKey && !e.altKey && !typing && $("modal").hidden) { e.preventDefault(); if (state.page === "clips") { const i = $("clipAdd"); if (i) i.focus(); } else openDetail(null, newPreset()); }
    else if (e.key === "/" && !typing) { e.preventDefault(); $("search").focus(); }
  });
  if (LOCAL && navigator.storage && navigator.storage.persist) { try { await navigator.storage.persist(); } catch (e) { /* 지원 안 하면 무시 */ } }
  await refresh();
  checkStorage();
}
init();
