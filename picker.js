/* On-page link picker. Injected by background.js into the tab you're picking in
   (and re-injected after every page load in that tab while picking is on).

   What you pick is remembered as a list of pages (URLs), so switching tabs on a
   page never makes old picks "jump" onto the new tab's links.

   State lives in chrome.storage.local "pick":
   { active, tabId, startUrl, current, sampleIdx, nextId,
     levels: [{ role: "download"|"follow"|"both", pickedOn,
                groups: [{ id, candidates: [{sel, count}], idx, items: [{url, text}], tabSel }] }] } */
(() => {
  if (window.__ltpPicker) { window.__ltpPicker.reload(); return; }
  const api = {};
  window.__ltpPicker = api;

  let state = null;
  let picking = true, smart = true, side = "right", minimized = false, showList = false;
  let automating = false, busyText = "";
  let hoverEl = null, preview = null;     // preview = { els, add, n, group }
  let pickedEls = [];                     // links on screen that are already picked
  let offer = null;                       // pending "same list from every tab?" question
  let lastTabEl = null;                   // last thing you clicked normally (probably a tab)
  let note = "";
  const dismissed = new Set();

  const sleep = ms => new Promise(r => setTimeout(r, ms));

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
  const short = u => u.replace(/^https?:\/\/(www\.)?/, "");
  const visible = el => el.getClientRects().length > 0;

  // Matched elements -> page links: the link itself, the link around it, or every link inside it.
  function itemsOfEls(els) {
    const out = [], seen = new Set();
    let inPage = 0;
    for (const el of els) {
      const a = el.closest("a[href]");
      for (const x of a ? [a] : el.querySelectorAll("a[href]")) {
        const url = norm(x.href);
        if (!url) continue;
        if (url === here()) { inPage++; continue; }
        if (seen.has(url)) continue;
        seen.add(url);
        out.push({ url, text: (x.textContent || x.title || "").replace(/\s+/g, " ").trim().slice(0, 80) });
      }
    }
    return { items: out, inPage };
  }
  const qsa = sel => { try { return [...document.querySelectorAll(sel)]; } catch { return []; } };
  const itemsOf = sel => itemsOfEls(qsa(sel)).items;

  // ---------- selector building ("similar links") ----------
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
  function pathOf(el, useIds) {
    const segs = [];
    let root = "body";
    for (let e = el; e && e !== document.body && e !== document.documentElement; e = e.parentElement) {
      if (useIds && e !== el && stableId(e)) { root = "#" + CSS.escape(e.id); break; }
      segs.push(seg(e));
    }
    return { segs, root };
  }
  const build = (p, isGeneric) =>
    [p.root, ...p.segs.map((s, j) => (isGeneric(j) ? s.generic : s.exact)).reverse()].join(" > ");

  // Every way of loosening the element's path, from "just this" up to "everything like it".
  const candCache = new WeakMap();
  function candidatesFor(el) {
    if (candCache.has(el)) return candCache.get(el);
    const sels = new Set();
    for (const p of [pathOf(el, true), pathOf(el, false)]) {
      sels.add(build(p, () => false));
      for (let i = 0; i < p.segs.length; i++) {
        sels.add(build(p, j => j === i));
        sels.add(build(p, j => j <= i));
      }
    }
    const list = [];
    for (const sel of sels) {
      const els = qsa(sel);
      if (els.includes(el)) list.push({ sel, count: els.length });
    }
    list.sort((a, b) => a.count - b.count || a.sel.length - b.sel.length);
    const out = [];
    for (const x of list) if (!out.length || out[out.length - 1].count !== x.count) out.push(x);
    candCache.set(el, out);
    return out;
  }
  const smartIdx = cands => {
    if (!smart) return 0;
    const i = cands.findIndex(c => c.count > 1);
    return i >= 0 ? i : 0;
  };

  // ---------- state ----------
  const level = () => state.levels[state.current];
  const save = () => chrome.storage.local.set({ pick: state });

  function pickedItems(lv = level()) {
    const out = [], seen = new Set();
    for (const g of lv.groups) for (const it of g.items) if (!seen.has(it.url)) { seen.add(it.url); out.push(it); }
    return out;
  }
  function refreshPickedEls() {
    const set = new Set(pickedItems().map(i => i.url));
    pickedEls = set.size ? [...document.querySelectorAll("a[href]")].filter(a => set.has(norm(a.href))) : [];
  }
  const groupOfUrl = url => level().groups.find(g => g.items.some(i => i.url === url));
  function labelOf(g) {
    const t = g.items.map(i => i.text).filter(Boolean);
    return t.length ? t.slice(0, 2).join(", ") + (t.length > 2 ? "…" : "") : short(g.items[0]?.url || "");
  }

  function addGroupFor(el) {
    const cands = candidatesFor(el);
    if (!cands.length) return;
    const idx = smartIdx(cands);
    const { items, inPage } = itemsOfEls(qsa(cands[idx].sel));
    if (!items.length) {
      note = inPage
        ? "That one only jumps to another spot on this same page (it's probably a tab). Hold Alt and click it to open it, then pick the links that show up."
        : "There's no link there to pick.";
      render();
      return;
    }
    note = "";
    const g = { id: state.nextId = (state.nextId || 0) + 1, candidates: cands, idx, items, tabSel: null };
    level().groups.push(g);
    checkSecondPick(g);
    changed();
  }
  function changed() { refreshPickedEls(); level().pickedOn = location.href; save(); render(); }

  // ---------- "same list in every tab?" ----------
  function tabSelFor(el) {
    const c = candidatesFor(el).find(x => x.count >= 2 && x.count <= 40);
    return c ? c.sel : null;
  }
  // A wider version of this group that adds links you can see right now (tabs that are hidden, not swapped).
  function widerWithNewVisible(g, extraUrls = []) {
    const have = new Set(g.items.map(i => i.url));
    for (let i = g.idx + 1; i < g.candidates.length; i++) {
      const els = qsa(g.candidates[i].sel);
      const items = itemsOfEls(els).items;
      if (items.length > 60 + have.size * 20) break; // don't jump to "half the website"
      const urls = new Set(items.map(x => x.url));
      if (![...have].every(u => urls.has(u)) || !extraUrls.every(u => urls.has(u))) continue;
      const newVisible = els.some(e => visible(e) && itemsOfEls([e]).items.some(x => !have.has(x.url)));
      if (newVisible && items.length > have.size) return { idx: i, total: items.length };
    }
    return null;
  }

  function checkAfterTabClick(el) {
    const g = [...level().groups].reverse().find(x => !x.tabSel);
    if (!g || dismissed.has(g.id) || offer) return;
    const now = itemsOf(g.candidates[g.idx].sel);
    const have = new Set(g.items.map(i => i.url));
    const tabSel = tabSelFor(el);
    if (now.length && now.some(i => !have.has(i.url)) && tabSel) {
      // The same spot now shows different links: the page swaps tab contents in place.
      offer = { kind: "swap", gid: g.id, tabSel, n: qsa(tabSel).length };
    } else {
      const w = widerWithNewVisible(g);
      if (w) offer = { kind: "widen", gid: g.id, idx: w.idx, n: tabSel ? qsa(tabSel).length : 0, total: w.total };
    }
  }

  // You picked the same list again on another tab yourself.
  function checkSecondPick(g) {
    if (offer) return;
    const sel = g.candidates[g.idx].sel;
    for (const e of level().groups) {
      if (e === g || e.tabSel || dismissed.has(e.id)) continue;
      const eSel = e.candidates[e.idx].sel;
      const tabSel = lastTabEl && lastTabEl.isConnected ? tabSelFor(lastTabEl) : null;
      if (eSel === sel && tabSel) {
        offer = { kind: "swap", gid: e.id, merge: [g.id], tabSel, n: qsa(tabSel).length };
        return;
      }
      const w = widerWithNewVisible(e, g.items.map(i => i.url));
      if (w) { offer = { kind: "widen", gid: e.id, merge: [g.id], idx: w.idx, total: w.total, n: 0 }; return; }
    }
  }

  async function acceptOffer() {
    const o = offer; offer = null;
    const lv = level();
    const g = lv.groups.find(x => x.id === o.gid);
    if (!g) return render();
    if (o.merge) lv.groups = lv.groups.filter(x => !o.merge.includes(x.id));
    if (o.kind === "widen") {
      g.idx = o.idx;
      g.items = itemsOf(g.candidates[g.idx].sel);
      return changed();
    }
    // Click through every tab and collect the same spot each time.
    automating = true;
    const tabs = qsa(o.tabSel);
    const seen = new Set(g.items.map(i => i.url));
    for (let i = 0; i < tabs.length; i++) {
      busyText = `Opening tab ${i + 1} of ${tabs.length}…`; render();
      try { tabs[i].click(); } catch {}
      await sleep(1000);
      for (const it of itemsOf(g.candidates[g.idx].sel)) if (!seen.has(it.url)) { seen.add(it.url); g.items.push(it); }
    }
    g.tabSel = o.tabSel;
    automating = false; busyText = "";
    changed();
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
  .box { position: fixed; pointer-events: none; border-radius: 3px; }
  .picked { background: rgba(22,163,74,.20); outline: 2px solid #16a34a; }
  .prev-add { background: rgba(234,88,12,.12); outline: 2px dashed #ea580c; }
  .prev-del { background: rgba(200,40,40,.15); outline: 2px dashed #c82828; }
  #tip { position: fixed; background: #111; color: #fff; font-size: 12px; font-weight: 600; padding: 4px 8px; border-radius: 6px; pointer-events: none; display: none; white-space: nowrap; }
  #panel { position: fixed; bottom: 16px; right: 16px; width: 340px; max-height: calc(100vh - 32px); overflow: auto; pointer-events: auto;
           background: #fff; color: #1d1d1f; border: 1px solid #d9d9de; border-radius: 14px; box-shadow: 0 10px 30px rgba(0,0,0,.22); font-size: 14px; line-height: 1.4; }
  #panel.left { right: auto; left: 16px; }
  #panel.min .body { display: none; }
  .head { display: flex; align-items: center; gap: 6px; padding: 9px 10px; border-bottom: 1px solid #eee; background: #fafafa; border-radius: 14px 14px 0 0; }
  .head b { flex: 1; font-size: 13px; }
  .body { padding: 12px; display: grid; gap: 12px; }
  button { font: inherit; font-size: 13px; font-weight: 600; padding: 7px 11px; border-radius: 8px; border: 1px solid #d9d9de; background: #fff; color: #1d1d1f; cursor: pointer; }
  button:hover { background: #f2f2f4; }
  button.primary { background: #c82828; border-color: #c82828; color: #fff; }
  button.primary:hover { background: #b02020; }
  button.go { background: #1d1d1f; border-color: #1d1d1f; color: #fff; }
  button.go:hover { background: #333; }
  button.big { width: 100%; padding: 11px; font-size: 14px; }
  button:disabled { opacity: .45; cursor: default; }
  button.icon { padding: 3px 8px; font-size: 12px; }
  .levels { display: flex; gap: 4px; flex-wrap: wrap; }
  .levels button { font-size: 12px; padding: 4px 9px; }
  .levels button.on { background: #1d1d1f; color: #fff; border-color: #1d1d1f; }
  .step { font-size: 15px; font-weight: 700; }
  .muted { color: #6e6e73; font-size: 12.5px; }
  .seg { display: grid; grid-template-columns: 1fr 1fr; border: 1px solid #d9d9de; border-radius: 9px; overflow: hidden; }
  .seg button { border: 0; border-radius: 0; font-size: 12.5px; }
  .seg button.on { background: #2563eb; color: #fff; }
  .offer { background: #fff7e6; border: 1px solid #f5c26b; border-radius: 10px; padding: 10px; display: grid; gap: 8px; }
  .note { background: #f4f6fb; border-radius: 10px; padding: 8px 10px; font-size: 12.5px; }
  .picked-box { background: #f0faf3; border: 1px solid #bfe5cb; border-radius: 10px; padding: 10px; display: grid; gap: 6px; }
  .count { font-size: 15px; font-weight: 700; color: #15803d; }
  .group { display: grid; grid-template-columns: 1fr auto; gap: 6px; align-items: center; font-size: 12.5px; border-top: 1px solid #d7eedd; padding-top: 6px; }
  .group .btns { display: flex; gap: 3px; }
  .list { max-height: 160px; overflow: auto; font-size: 12px; color: #444; display: grid; gap: 2px; }
  .list div { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  label.opt { display: flex; gap: 8px; align-items: flex-start; font-size: 13.5px; cursor: pointer; padding: 3px 0; }
  label.opt input { margin-top: 3px; }
  .row { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
  .grow { flex: 1; }
  .link { background: none; border: 0; padding: 0; color: #2563eb; font-size: 12.5px; font-weight: 600; cursor: pointer; }
  .link:hover { background: none; text-decoration: underline; }
</style>
<div id="boxes"></div><div id="tip"></div>
<div id="panel"><div class="head"><b>Links to One PDF</b>
  <button class="icon" data-act="side" title="Move to the other side">⇆</button>
  <button class="icon" data-act="min" title="Make small">–</button>
  <button class="icon" data-act="close" title="Close (your picks are kept)">✕</button></div>
  <div class="body" id="body"></div></div>`;
  const $ = s => root.querySelector(s);
  const boxes = $("#boxes"), tip = $("#tip"), panel = $("#panel"), body = $("#body");
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;

  function offerHtml() {
    if (busyText) return `<div class="offer"><b>${esc(busyText)}</b><div class="muted">Please wait…</div></div>`;
    if (!offer) return "";
    const tabs = offer.n >= 2 ? `all ${offer.n} tabs` : "every tab";
    const extra = offer.kind === "widen" ? ` That makes <b>${plural(offer.total, "page")}</b>.` : "";
    return `<div class="offer"><b>Looks like this page has tabs.</b>
      <div>Want the same list from ${tabs}?${extra}</div>
      <div class="row"><button class="go" data-act="offer-yes">Yes, ${tabs}</button><button data-act="offer-no">No thanks</button></div></div>`;
  }

  function render() {
    panel.classList.toggle("left", side === "left");
    panel.classList.toggle("min", minimized);
    const L = state.levels, k = state.current, lv = level();
    const items = pickedItems();
    const prevItems = k > 0 ? pickedItems(L[k - 1]) : [];
    const roleWords = { download: "Put them in the PDF", follow: "Open them, they have more links to pick", both: "Both: put them in the PDF and pick links inside" };

    body.innerHTML = `
      ${L.length > 1 ? `<div class="levels">${L.map((_, i) => `<button data-act="level" data-i="${i}" class="${i === k ? "on" : ""}">Step ${i + 1}</button>`).join("")}</div>` : ""}
      <div>
        <div class="step">${k === 0 ? "Step 1: Click the links you want" : `Step ${k + 1}: Click the links you want inside these pages`}</div>
        ${k > 0 ? `<div class="muted">I opened one of the ${plural(prevItems.length, "page")} from step ${k} as an example. Whatever you pick here gets picked on all of them.</div>
          ${prevItems.length > 1 ? `<div class="row" style="margin-top:4px"><button class="icon" data-act="sample" data-d="-1" ${state.sampleIdx <= 0 ? "disabled" : ""}>◀</button>
          <span class="muted">example ${Math.min(state.sampleIdx + 1, prevItems.length)} of ${prevItems.length}</span>
          <button class="icon" data-act="sample" data-d="1" ${state.sampleIdx >= prevItems.length - 1 ? "disabled" : ""}>▶</button></div>` : ""}` : ""}
      </div>
      <div class="seg">
        <button data-act="mode" data-v="pick" class="${picking ? "on" : ""}">Clicking picks links</button>
        <button data-act="mode" data-v="browse" class="${!picking ? "on" : ""}">Clicking works normally</button>
      </div>
      <div class="muted">To open a tab or menu on the page without picking it, hold <b>Alt</b> (Option on a Mac) while you click.</div>
      <label class="opt"><input type="checkbox" data-act="smart" ${smart ? "checked" : ""}> Pick the whole list when I click one link</label>
      ${offerHtml()}
      ${note ? `<div class="note">${esc(note)}</div>` : ""}
      <div class="picked-box">
        <div class="row"><span class="count grow">${items.length ? "✓ " + plural(items.length, "page") + " picked" : "Nothing picked yet"}</span>
          ${items.length ? `<button class="link" data-act="list">${showList ? "Hide list" : "See list"}</button>` : ""}</div>
        ${lv.groups.map((g, i) => {
          const live = !g.tabSel && qsa(g.candidates[g.idx].sel).length > 0;
          return `<div class="group"><div><b>${plural(g.items.length, "page")}</b>${g.tabSel ? " from every tab" : ""}<div class="muted">${esc(labelOf(g))}</div></div>
            <div class="btns">${live ? `<button class="icon" data-act="narrow" data-i="${i}" title="Pick fewer" ${g.idx === 0 ? "disabled" : ""}>Fewer</button>
            <button class="icon" data-act="widen" data-i="${i}" title="Pick more" ${g.idx >= g.candidates.length - 1 ? "disabled" : ""}>More</button>` : ""}
            <button class="icon" data-act="del" data-i="${i}" title="Remove these">✕</button></div></div>`;
        }).join("")}
        ${showList && items.length ? `<div class="list">${items.map(i => `<div title="${esc(i.url)}">• ${esc(i.text || short(i.url))}</div>`).join("")}</div>` : ""}
      </div>
      ${items.length ? `<div>
        <div class="step" style="font-size:14px">What should I do with these pages?</div>
        ${["download", "follow", "both"].map(r => `<label class="opt"><input type="radio" name="role" data-act="role" value="${r}" ${lv.role === r ? "checked" : ""}> ${roleWords[r]}</label>`).join("")}
      </div>
      ${lv.role === "download"
        ? `<button class="primary big" data-act="run">Make my PDF</button>`
        : `<button class="go big" data-act="next">${k < L.length - 1 ? `Go to step ${k + 2} →` : "Next: pick the links inside them →"}</button>
           <div class="row"><span class="grow"></span><button data-act="run">Make PDF now</button></div>`}` : ""}`;
    draw();
  }

  function addBoxes(frag, els, cls) {
    let n = 0;
    for (const el of els) {
      const r = el.getBoundingClientRect();
      if (!r.width && !r.height) continue;
      if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) continue;
      const d = document.createElement("div");
      d.className = "box " + cls;
      d.style.cssText = `left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px`;
      frag.appendChild(d);
      if (++n > 1500) break;
    }
  }
  function draw() {
    const frag = document.createDocumentFragment();
    addBoxes(frag, pickedEls, "picked");
    if (preview && hoverEl && picking && !automating) {
      addBoxes(frag, preview.els, preview.add ? "prev-add" : "prev-del");
      const r = hoverEl.getBoundingClientRect();
      tip.textContent = preview.add ? `Click to add ${plural(preview.n, "page")}` : `Click to remove ${plural(preview.n, "page")}`;
      Object.assign(tip.style, { display: "block", left: Math.max(4, Math.min(r.left, innerWidth - 200)) + "px", top: (r.top > 30 ? r.top - 28 : r.bottom + 6) + "px" });
    } else {
      tip.style.display = "none";
    }
    boxes.replaceChildren(frag);
  }
  let rafQueued = false;
  const queueDraw = () => { if (!rafQueued) { rafQueued = true; requestAnimationFrame(() => { rafQueued = false; draw(); }); } };

  // What would a click here do?
  function computePreview(el) {
    if (!el) return null;
    const { items } = itemsOfEls([el]);
    const hit = items.map(i => groupOfUrl(i.url)).find(Boolean);
    if (hit) {
      const set = new Set(hit.items.map(i => i.url));
      return { add: false, n: hit.items.length, els: pickedEls.filter(a => set.has(norm(a.href))), group: hit };
    }
    const cands = candidatesFor(el);
    if (!cands.length) return null;
    const els = qsa(cands[smartIdx(cands)].sel);
    const n = itemsOfEls(els).items.length;
    return n ? { add: true, n, els } : null;
  }

  // ---------- page events ----------
  const fromPanel = e => e.composedPath().includes(host);
  const active = e => picking && !automating && !e.altKey && !fromPanel(e);
  function targetOf(e) {
    const el = e.target;
    if (!(el instanceof Element) || el === host || el === document.body || el === document.documentElement) return null;
    return el.closest("a[href]") || el;
  }
  let hoverTimer = 0;
  const onMove = e => {
    const t = active(e) ? targetOf(e) : null;
    if (t === hoverEl) return;
    hoverEl = t; preview = null; queueDraw();
    clearTimeout(hoverTimer);
    if (t) hoverTimer = setTimeout(() => { if (hoverEl === t) { preview = computePreview(t); queueDraw(); } }, 80);
  };
  const swallow = e => { if (active(e)) { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); } };
  const onClick = e => {
    if (fromPanel(e) || automating) return;
    if (!active(e)) {
      // A normal click on the page, probably switching a tab. See if it revealed more of the same list.
      const el = e.target instanceof Element ? (e.target.closest("a,button,[role=tab],li,[onclick]") || e.target) : null;
      if (el) {
        lastTabEl = el;
        setTimeout(() => { if (state) { refreshPickedEls(); checkAfterTabClick(el); render(); } }, 900);
      }
      return;
    }
    swallow(e);
    const t = targetOf(e);
    if (!t) return;
    const p = computePreview(t);
    if (p && !p.add) {
      level().groups = level().groups.filter(g => g !== p.group);
      if (offer && offer.gid === p.group.id) offer = null;
      note = ""; changed();
    } else {
      addGroupFor(t);
    }
    preview = computePreview(t); queueDraw();
  };
  const onKey = e => { if (e.key === "Alt") { hoverEl = null; preview = null; queueDraw(); } };

  const listeners = [
    ["mousemove", onMove], ["click", onClick], ["mousedown", swallow], ["mouseup", swallow],
    ["pointerdown", swallow], ["pointerup", swallow], ["auxclick", swallow], ["dblclick", swallow],
    ["keydown", onKey], ["scroll", queueDraw], ["resize", queueDraw]
  ];
  for (const [t, f] of listeners) window.addEventListener(t, f, true);

  // ---------- panel events ----------
  function go(url) { if (url && norm(url) !== here()) location.href = url; else { refreshPickedEls(); render(); } }

  root.addEventListener("click", async e => {
    const b = e.target.closest("[data-act]");
    if (!b || b.tagName === "INPUT" || automating) return;
    const act = b.dataset.act, i = Number(b.dataset.i);
    const lv = level();
    if (act === "side") { side = side === "right" ? "left" : "right"; render(); }
    else if (act === "min") { minimized = !minimized; render(); }
    else if (act === "close") { state.active = false; await save(); api.destroy(); }
    else if (act === "mode") { picking = b.dataset.v === "pick"; hoverEl = preview = null; render(); }
    else if (act === "list") { showList = !showList; render(); }
    else if (act === "narrow" || act === "widen") {
      const g = lv.groups[i];
      g.idx += act === "widen" ? 1 : -1;
      g.items = itemsOf(g.candidates[g.idx].sel);
      changed();
    }
    else if (act === "del") {
      const g = lv.groups.splice(i, 1)[0];
      if (offer && g && offer.gid === g.id) offer = null;
      changed();
    }
    else if (act === "offer-yes") { await acceptOffer(); }
    else if (act === "offer-no") { if (offer) dismissed.add(offer.gid); offer = null; render(); }
    else if (act === "level") {
      if (i === state.current) return;
      state.current = i; state.sampleIdx = 0; offer = null; note = ""; await save();
      go(i === 0 ? state.startUrl : (pickedItems(state.levels[i - 1])[0] || {}).url || state.levels[i].pickedOn);
    }
    else if (act === "sample") {
      const list = pickedItems(state.levels[state.current - 1]);
      state.sampleIdx = Math.max(0, Math.min(list.length - 1, state.sampleIdx + Number(b.dataset.d)));
      await save();
      go(list[state.sampleIdx].url);
    }
    else if (act === "next") {
      const items = pickedItems();
      if (!items.length) return;
      if (!state.levels[state.current + 1]) state.levels.push({ groups: [], role: "download" });
      state.current++; state.sampleIdx = 0; offer = null; note = ""; await save();
      go(items[0].url);
    }
    else if (act === "run") {
      await save();
      chrome.runtime.sendMessage({ type: "runRecipe" });
    }
  });
  root.addEventListener("change", e => {
    const el = e.target;
    if (el.dataset.act === "smart") { smart = el.checked; preview = null; }
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
    if (state) { refreshPickedEls(); render(); return; } // already running on this page
    const got = await chrome.storage.local.get("pick");
    if (!got.pick || !got.pick.active) return api.destroy();
    state = got.pick;
    for (const L of state.levels) if (!L.groups) L.groups = []; // picks saved by an older version
    refreshPickedEls(); render();
  };

  // Pages that build their links late get re-checked every couple of seconds.
  const timer = setInterval(() => {
    if (!state || automating) return;
    const before = pickedEls.length;
    refreshPickedEls();
    if (pickedEls.length !== before) render(); else queueDraw();
  }, 2000);

  document.documentElement.appendChild(host);
  api.reload().then(() => state && save());
})();
