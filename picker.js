/* On-page link picker. Injected by background.js into the tab you're picking in
   (and re-injected after every page load in that tab while picking is on).

   State lives in chrome.storage.local "pick":
   { active, tabId, startUrl, current, sampleIdx,
     levels: [{ rules: [{ candidates: [{sel, count}], idx }], role: "download"|"follow"|"both", urls: [] }] } */
(() => {
  if (window.__ltpPicker) { window.__ltpPicker.reload(); return; }
  const api = {};
  window.__ltpPicker = api;

  let state = null;
  let picking = true, smart = true, altDown = false, side = "right", minimized = false;
  let hoverEl = null;
  let ruleEls = [];   // elements matched by each rule of the current level
  let matched = [];   // all of them, flattened

  // ---------- URL helpers ----------
  const norm = href => {
    try {
      const u = new URL(href, location.href);
      if (u.protocol !== "http:" && u.protocol !== "https:") return null;
      u.hash = "";
      return u.href;
    } catch { return null; }
  };
  const here = () => norm(location.href);

  // Turn matched elements into page links: a link itself, the link around it, or every link inside it.
  function linksOf(els) {
    const out = [], seen = new Set();
    let inPage = 0;
    for (const el of els) {
      const a = el.closest("a[href]");
      const as = a ? [a] : [...el.querySelectorAll("a[href]")];
      for (const x of as) {
        const u = norm(x.href);
        if (!u) continue;
        if (u === here()) { inPage++; continue; }
        if (!seen.has(u)) { seen.add(u); out.push(u); }
      }
    }
    return { urls: out, inPage };
  }

  // ---------- selector building ("smart" similar elements) ----------
  const BAD_CLASS = /^(active|current|selected|hover|hovered|focus|focused|open|opened|show|shown|visible|hidden|in|on|first|last|odd|even|is-|has-|js-|ng-|v-|css-|sc-|jsx-|ltp-)/i;
  const stableClass = c => c.length < 40 && !BAD_CLASS.test(c) && !/\d{3,}/.test(c) && !/[:[\]/@!]/.test(c);
  const stableId = el => {
    if (!el.id || !/^[A-Za-z][\w-]*$/.test(el.id) || /\d{3,}/.test(el.id)) return false;
    try { return document.querySelectorAll("#" + CSS.escape(el.id)).length === 1; } catch { return false; }
  };

  function seg(el) {
    const tag = el.localName;
    const cls = [...el.classList].filter(stableClass).slice(0, 3).map(c => "." + CSS.escape(c)).join("");
    let n = 1;
    for (let s = el.previousElementSibling; s; s = s.previousElementSibling) if (s.localName === tag) n++;
    const generic = (/^[a-z][a-z0-9-]*$/.test(tag) ? tag : "*") + cls;
    return { generic, exact: generic + `:nth-of-type(${n})` };
  }
  // useIds: stop at the nearest ancestor with a unique id (short, sturdy selectors).
  // Without it the path runs all the way to <body>, so selections can widen past that ancestor.
  function pathOf(el, useIds) {
    const segs = [];
    let root = "body";
    for (let e = el; e && e !== document.body && e !== document.documentElement; e = e.parentElement) {
      if (useIds && e !== el && stableId(e)) { root = "#" + CSS.escape(e.id); break; }
      segs.push(seg(e));
    }
    return { segs, root }; // segs[0] is the clicked element
  }
  const build = (p, isGeneric) =>
    [p.root, ...p.segs.map((s, j) => (isGeneric(j) ? s.generic : s.exact)).reverse()].join(" > ");

  // Every way of loosening the clicked element's path, sorted from "just this" to "everything like it".
  function candidatesFor(el) {
    const sels = new Set();
    for (const p of [pathOf(el, true), pathOf(el, false)]) {
      sels.add(build(p, () => false));
      for (let i = 0; i < p.segs.length; i++) {
        sels.add(build(p, j => j === i));  // loosen one level (e.g. same column in every row)
        sels.add(build(p, j => j <= i));   // loosen everything below a level (e.g. whole list)
      }
    }
    const list = [];
    for (const sel of sels) {
      let els;
      try { els = [...document.querySelectorAll(sel)]; } catch { continue; }
      if (!els.includes(el)) continue;
      list.push({ sel, count: els.length });
    }
    list.sort((a, b) => a.count - b.count || a.sel.length - b.sel.length);
    const out = [];
    for (const x of list) if (!out.length || out[out.length - 1].count !== x.count) out.push(x);
    return out;
  }

  // ---------- state ----------
  const level = () => state.levels[state.current];
  const save = () => chrome.storage.local.set({ pick: state });

  function recompute() {
    ruleEls = level().rules.map(r => {
      try { return [...document.querySelectorAll(r.candidates[r.idx].sel)]; } catch { return []; }
    });
    matched = ruleEls.flat();
    const { urls } = linksOf(matched);
    level().urls = urls;          // remembered so the next level can open one as a sample
    level().pickedOn = location.href;
  }

  function toggleRuleFor(el) {
    const hit = ruleEls.findIndex(list => list.some(m => m === el || m.contains(el) || el.contains(m)));
    if (hit >= 0) {
      level().rules.splice(hit, 1);
    } else {
      const candidates = candidatesFor(el);
      if (!candidates.length) return;
      let idx = 0;
      if (smart) {
        const i = candidates.findIndex(c => c.count > 1);
        idx = i >= 0 ? i : 0;
      }
      level().rules.push({ candidates, idx });
    }
    recompute(); save(); render();
  }

  // ---------- UI ----------
  const host = document.createElement("div");
  host.id = "ltp-picker-host";
  host.style.cssText = "all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483647;";
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `
<style>
  :host { all: initial; }
  * { box-sizing: border-box; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }
  #boxes div { position: fixed; background: rgba(37,99,235,.18); outline: 2px solid #2563eb; border-radius: 3px; pointer-events: none; }
  #hover { position: fixed; outline: 2px dashed #ea580c; background: rgba(234,88,12,.08); pointer-events: none; display: none; border-radius: 3px; }
  #tip { position: fixed; background: #111; color: #fff; font-size: 11px; padding: 2px 6px; border-radius: 4px; pointer-events: none; display: none; white-space: nowrap; }
  #panel { position: fixed; bottom: 16px; right: 16px; width: 320px; max-height: calc(100vh - 32px); overflow: auto; pointer-events: auto;
           background: #fff; color: #1d1d1f; border: 1px solid #d9d9de; border-radius: 12px; box-shadow: 0 10px 30px rgba(0,0,0,.22); font-size: 13px; line-height: 1.4; }
  #panel.left { right: auto; left: 16px; }
  #panel.min .body { display: none; }
  .head { display: flex; align-items: center; gap: 6px; padding: 9px 10px; border-bottom: 1px solid #eee; background: #fafafa; border-radius: 12px 12px 0 0; }
  .head b { flex: 1; font-size: 13px; }
  .body { padding: 10px; display: grid; gap: 10px; }
  button { font: inherit; font-size: 12px; font-weight: 600; padding: 5px 9px; border-radius: 7px; border: 1px solid #d9d9de; background: #fff; color: #1d1d1f; cursor: pointer; }
  button:hover { background: #f2f2f4; }
  button.primary { background: #c82828; border-color: #c82828; color: #fff; }
  button.primary:hover { background: #b02020; }
  button:disabled { opacity: .45; cursor: default; }
  button.icon { padding: 3px 7px; }
  .levels { display: flex; gap: 4px; flex-wrap: wrap; }
  .levels button.on { background: #1d1d1f; color: #fff; border-color: #1d1d1f; }
  .muted { color: #6e6e73; font-size: 12px; }
  .url { color: #6e6e73; font-size: 11.5px; word-break: break-all; }
  .seg { display: grid; grid-template-columns: 1fr 1fr; gap: 0; border: 1px solid #d9d9de; border-radius: 8px; overflow: hidden; }
  .seg button { border: 0; border-radius: 0; }
  .seg button.on { background: #2563eb; color: #fff; }
  .rules { display: grid; gap: 4px; }
  .rule { display: grid; grid-template-columns: 1fr auto auto auto; gap: 4px; align-items: center; background: #f4f6fb; border-radius: 7px; padding: 4px 6px; }
  .rule .t { font-size: 12px; }
  .rule .s { font-size: 10.5px; color: #6e6e73; word-break: break-all; }
  label.opt { display: flex; gap: 6px; align-items: flex-start; font-size: 12.5px; cursor: pointer; }
  label.opt input { margin-top: 2px; }
  .roles { display: grid; gap: 4px; }
  .total { font-weight: 600; }
  .warn { color: #b45309; font-size: 12px; }
  .row { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
  .grow { flex: 1; }
</style>
<div id="boxes"></div><div id="hover"></div><div id="tip"></div>
<div id="panel"><div class="head"><b>Links to One PDF — picker</b>
  <button class="icon" data-act="side" title="Move to other side">⇆</button>
  <button class="icon" data-act="min" title="Minimize">–</button>
  <button class="icon" data-act="close" title="Close picker (your picks are kept)">✕</button></div>
  <div class="body" id="body"></div></div>`;
  const $ = s => root.querySelector(s);
  const boxes = $("#boxes"), hoverBox = $("#hover"), tip = $("#tip"), panel = $("#panel"), body = $("#body");

  const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const short = u => u.replace(/^https?:\/\/(www\.)?/, "");

  function describe(els, i) {
    const r = level().rules[i];
    const { urls } = linksOf(els);
    const c = r.candidates[r.idx];
    return `<div class="rule"><div><div class="t"><b>${urls.length}</b> link${urls.length === 1 ? "" : "s"} · ${els.length} element${els.length === 1 ? "" : "s"}</div>
      <div class="s">${esc(c.sel.split(" > ").slice(-2).join(" > "))}</div></div>
      <button class="icon" data-act="narrow" data-i="${i}" title="Fewer (narrower)" ${r.idx === 0 ? "disabled" : ""}>−</button>
      <button class="icon" data-act="widen" data-i="${i}" title="More (wider)" ${r.idx >= r.candidates.length - 1 ? "disabled" : ""}>+</button>
      <button class="icon" data-act="del" data-i="${i}" title="Remove">✕</button></div>`;
  }

  function render() {
    panel.classList.toggle("left", side === "left");
    panel.classList.toggle("min", minimized);
    const L = state.levels, k = state.current, lv = level();
    const { urls, inPage } = linksOf(matched);
    const prev = k > 0 ? L[k - 1] : null;
    const samples = prev ? prev.urls || [] : [];
    const isLast = k === L.length - 1;
    const follow = lv.role !== "download";

    body.innerHTML = `
      <div class="levels">
        ${L.map((_, i) => `<button data-act="level" data-i="${i}" class="${i === k ? "on" : ""}">Level ${i + 1}</button>`).join("")}
      </div>
      <div>
        <div class="muted">${k === 0 ? "Picking on the start page:" : `Level ${k + 1} = links inside the level ${k} pages. Picking on a sample:`}</div>
        <div class="url">${esc(short(location.href))}</div>
        ${k > 0 && samples.length ? `<div class="row" style="margin-top:4px">
          <button class="icon" data-act="sample" data-d="-1" ${state.sampleIdx <= 0 ? "disabled" : ""}>◀</button>
          <span class="muted">sample ${Math.min(state.sampleIdx + 1, samples.length)} of ${samples.length}</span>
          <button class="icon" data-act="sample" data-d="1" ${state.sampleIdx >= samples.length - 1 ? "disabled" : ""}>▶</button></div>` : ""}
      </div>
      <div class="seg">
        <button data-act="mode" data-v="pick" class="${picking ? "on" : ""}">Pick links</button>
        <button data-act="mode" data-v="browse" class="${!picking ? "on" : ""}">Use page normally</button>
      </div>
      <div class="muted">Click a link or a box of links to select it. Click it again to unselect. Hold <b>Alt</b> to click the page normally (e.g. to open a tab on the page).</div>
      <label class="opt"><input type="checkbox" data-act="smart" ${smart ? "checked" : ""}> Also select similar items (the whole list/row)</label>
      <div class="rules">${lv.rules.length ? ruleEls.map((els, i) => describe(els, i)).join("") : `<div class="muted">Nothing selected on this level yet.</div>`}</div>
      <div class="total">${urls.length} page${urls.length === 1 ? "" : "s"} selected on this level</div>
      ${inPage ? `<div class="warn">${inPage} selected link${inPage === 1 ? " jumps" : "s jump"} to a spot on this same page, so ${inPage === 1 ? "it's" : "they're"} ignored. If it's a tab, hold Alt and click it to open it, then pick the links inside.</div>` : ""}
      <div class="roles">
        <div class="muted">What are these pages?</div>
        <label class="opt"><input type="radio" name="role" data-act="role" value="download" ${lv.role === "download" ? "checked" : ""}> Pages to download</label>
        <label class="opt"><input type="radio" name="role" data-act="role" value="follow" ${lv.role === "follow" ? "checked" : ""}> Pages with more links (pick the next level)</label>
        <label class="opt"><input type="radio" name="role" data-act="role" value="both" ${lv.role === "both" ? "checked" : ""}> Both (download them and pick links inside)</label>
      </div>
      ${!follow && !isLast ? `<div class="warn">Levels after this one are ignored while this is set to "Pages to download".</div>` : ""}
      <div class="row">
        ${follow ? `<button data-act="next" ${urls.length ? "" : "disabled"}>${isLast ? "Pick next level →" : `Go to level ${k + 2} →`}</button>` : ""}
        ${!isLast ? `<button data-act="droplater" title="Delete the levels after this one">Delete later levels</button>` : ""}
        <span class="grow"></span>
        <button class="primary" data-act="run">Make PDF</button>
      </div>`;
    draw();
  }

  function draw() {
    const frag = document.createDocumentFragment();
    let n = 0;
    for (const el of matched) {
      const r = el.getBoundingClientRect();
      if (!r.width && !r.height) continue;
      if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) continue;
      const d = document.createElement("div");
      d.style.cssText = `left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px`;
      frag.appendChild(d);
      if (++n > 1500) break;
    }
    boxes.replaceChildren(frag);
    if (hoverEl && picking && !altDown) {
      const r = hoverEl.getBoundingClientRect();
      Object.assign(hoverBox.style, { display: "block", left: r.left + "px", top: r.top + "px", width: r.width + "px", height: r.height + "px" });
      const a = hoverEl.closest("a[href]");
      const inner = a ? 1 : hoverEl.querySelectorAll("a[href]").length;
      tip.textContent = a ? "link: " + (a.textContent.trim().slice(0, 40) || short(a.href).slice(0, 40)) : `box with ${inner} link${inner === 1 ? "" : "s"}`;
      Object.assign(tip.style, { display: "block", left: Math.max(4, r.left) + "px", top: Math.max(4, r.top - 20) + "px" });
    } else {
      hoverBox.style.display = tip.style.display = "none";
    }
  }
  let rafQueued = false;
  const queueDraw = () => { if (!rafQueued) { rafQueued = true; requestAnimationFrame(() => { rafQueued = false; draw(); }); } };

  // ---------- page events ----------
  const fromPanel = e => e.composedPath().includes(host);
  const active = e => picking && !e.altKey && !fromPanel(e);

  function targetOf(e) {
    const el = e.target;
    if (!(el instanceof Element) || el === host) return null;
    return el.closest("a[href]") || el;
  }
  const onMove = e => {
    altDown = e.altKey;
    const t = active(e) ? targetOf(e) : null;
    if (t !== hoverEl) { hoverEl = t; queueDraw(); }
  };
  const swallow = e => { if (active(e)) { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); } };
  const onClick = e => {
    if (!active(e)) return;
    swallow(e);
    const t = targetOf(e);
    if (t && t !== document.body && t !== document.documentElement) toggleRuleFor(t);
  };
  const onKey = e => {
    if (e.key === "Alt") { altDown = e.type === "keydown"; queueDraw(); }
    if (e.key === "Escape" && e.type === "keydown") { hoverEl = null; queueDraw(); }
  };

  const listeners = [
    ["mousemove", onMove], ["click", onClick], ["mousedown", swallow], ["mouseup", swallow],
    ["pointerdown", swallow], ["pointerup", swallow], ["auxclick", swallow], ["dblclick", swallow],
    ["keydown", onKey], ["keyup", onKey], ["scroll", queueDraw], ["resize", queueDraw]
  ];
  for (const [t, f] of listeners) window.addEventListener(t, f, true);

  // ---------- panel events ----------
  function go(url) { if (url && norm(url) !== here()) location.href = url; else { recompute(); render(); } }

  root.addEventListener("click", async e => {
    const b = e.target.closest("[data-act]");
    if (!b || b.tagName === "INPUT") return;
    const act = b.dataset.act, i = Number(b.dataset.i);
    const lv = level();
    if (act === "side") { side = side === "right" ? "left" : "right"; render(); }
    else if (act === "min") { minimized = !minimized; render(); }
    else if (act === "close") { state.active = false; await save(); api.destroy(); }
    else if (act === "mode") { picking = b.dataset.v === "pick"; hoverEl = null; render(); }
    else if (act === "narrow") { lv.rules[i].idx--; recompute(); save(); render(); }
    else if (act === "widen") { lv.rules[i].idx++; recompute(); save(); render(); }
    else if (act === "del") { lv.rules.splice(i, 1); recompute(); save(); render(); }
    else if (act === "droplater") { state.levels.length = state.current + 1; save(); render(); }
    else if (act === "level") {
      if (i === state.current) return;
      state.current = i; state.sampleIdx = 0; await save();
      const target = i === 0 ? state.startUrl : (state.levels[i - 1].urls || [])[0] || state.levels[i].pickedOn;
      go(target);
    }
    else if (act === "sample") {
      const list = state.levels[state.current - 1].urls || [];
      state.sampleIdx = Math.max(0, Math.min(list.length - 1, state.sampleIdx + Number(b.dataset.d)));
      await save();
      go(list[state.sampleIdx]);
    }
    else if (act === "next") {
      const urls = lv.urls || [];
      if (!urls.length) return;
      if (!state.levels[state.current + 1]) state.levels.push({ rules: [], role: "download", urls: [] });
      state.current++; state.sampleIdx = 0; await save();
      go(urls[0]);
    }
    else if (act === "run") {
      const problems = [];
      for (let j = 0; j < state.levels.length; j++) {
        const L = state.levels[j];
        if (!L.rules.length) problems.push(`Level ${j + 1} has nothing selected.`);
        if (L.role === "download") break;
      }
      if (problems.length && !confirm(problems.join("\n") + "\n\nMake the PDF anyway?")) return;
      await save();
      chrome.runtime.sendMessage({ type: "runRecipe" });
    }
  });
  root.addEventListener("change", e => {
    const el = e.target;
    if (el.dataset.act === "smart") smart = el.checked;
    if (el.dataset.act === "role") { level().role = el.value; save(); render(); }
  });

  const onStorage = (changes, area) => {
    if (area === "local" && changes.pick && changes.pick.newValue && !changes.pick.newValue.active) api.destroy();
  };
  chrome.storage.onChanged.addListener(onStorage);

  api.destroy = () => {
    for (const [t, f] of listeners) window.removeEventListener(t, f, true);
    chrome.storage.onChanged.removeListener(onStorage);
    clearInterval(timer);
    host.remove();
    delete window.__ltpPicker;
  };
  api.reload = async () => {
    const got = await chrome.storage.local.get("pick");
    if (!got.pick || !got.pick.active) return api.destroy();
    state = got.pick;
    recompute(); render();
  };

  // Pages that build their content late (or switch tabs) get re-scanned every couple of seconds.
  const timer = setInterval(() => {
    if (!state) return;
    const before = matched.length;
    recompute();
    if (matched.length !== before) { save(); render(); } else queueDraw();
  }, 2000);

  document.documentElement.appendChild(host);
  api.reload().then(() => state && save());
})();
