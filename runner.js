/* Runner page: crawls the links level by level in background tabs, prints each page
   to PDF through the Chrome DevTools protocol, then merges everything with pdf-lib. */

const { PDFDocument, PDFName, PDFHexString, PDFNull } = PDFLib;
const $ = id => document.getElementById(id);

const PAPER = { letter: [8.5, 11], a4: [8.27, 11.69] };
const MAX_PARALLEL = 16;
let workerWindowId = null;      // minimized window the background tabs open in
let pump = null;                // nudges the pool when "pages at once" changes
const LOAD_TIMEOUT = 45000;

let job, settings, keep;
let nodes = [];                 // every page we decided to capture, in discovery order
const seen = new Set();         // normalised URLs already queued
const openTabs = new Set();     // background tabs currently open (closed on cancel)
let stopRequested = false, cancelled = false;
let doneCount = 0, failCount = 0, readOnlyCount = 0, currentLevel = 0;
const t0 = Date.now();

// ---------- UI ----------
function setStatus(text) { $("status").textContent = text; document.title = text + " – Links to One PDF"; }
function refreshStats() {
  const finished = doneCount + failCount + readOnlyCount;
  $("nDone").textContent = doneCount;
  $("nTotal").textContent = nodes.length;
  $("nFailed").textContent = failCount;
  $("nLevel").textContent = currentLevel;
  $("bar").style.width = nodes.length ? (100 * finished / nodes.length).toFixed(1) + "%" : "0";
}
setInterval(() => {
  const s = Math.floor((Date.now() - t0) / 1000);
  $("elapsed").textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}, 1000);

function addRow(node) {
  const li = document.createElement("li");
  li.className = "lvl" + Math.max(1, node.depth);
  li.innerHTML = `<span class="icon">⏳</span><div><div class="title"></div><div class="url"></div></div><span class="meta">queued</span>`;
  li.querySelector(".title").textContent = node.depth === 0 ? "Start page" : "…";
  li.querySelector(".url").textContent = node.url;
  $("list").appendChild(li);
  node.li = li;
}
function updateRow(node, icon, meta) {
  if (!node.li) return;
  node.li.querySelector(".icon").textContent = icon;
  node.li.querySelector(".meta").textContent = meta;
  if (node.title) node.li.querySelector(".title").textContent = node.title;
  node.li.classList.toggle("failed", node.status === "failed");
}

// ---------- helpers ----------
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Runs in every background page before the site's own code. Background tabs never draw frames,
// so sites that wait for a frame (requestAnimationFrame) or for content to scroll into view
// (IntersectionObserver) never fill in their content, e.g. Obsidian Publish sites print blank.
// This makes both fire right away, as if the page were on screen and everything were visible.
const PAGE_SHIM = `(() => {
  if (window.__ltpShim) return; window.__ltpShim = true;
  let q = [], idn = 0, scheduled = false, flushes = 0;
  const ch = new MessageChannel();
  const flush = () => {
    scheduled = false; flushes++;
    const now = performance.now(), run = q; q = [];
    for (const [, cb] of run) { try { cb(now); } catch (e) { setTimeout(() => { throw e; }); } }
  };
  ch.port1.onmessage = flush;
  window.requestAnimationFrame = cb => {
    const n = ++idn; q.push([n, cb]);
    if (!scheduled) { scheduled = true; if (flushes < 3000) ch.port2.postMessage(0); else setTimeout(flush, 50); }
    return n;
  };
  window.cancelAnimationFrame = n => { q = q.filter(x => x[0] !== n); };
  window.IntersectionObserver = class {
    constructor(cb) { this.cb = cb; this.els = new Set(); }
    observe(el) {
      this.els.add(el);
      setTimeout(() => {
        if (!this.els.has(el)) return;
        const r = el.getBoundingClientRect();
        try { this.cb([{ target: el, isIntersecting: true, intersectionRatio: 1, boundingClientRect: r, intersectionRect: r, rootBounds: null, time: performance.now() }], this); } catch (e) {}
      }, 0);
    }
    unobserve(el) { this.els.delete(el); }
    disconnect() { this.els.clear(); }
    takeRecords() { return []; }
  };
})();`;

// Wait until the tab has left about:blank and finished loading the real page.
async function waitForPageLoad(tabId) {
  const t0 = Date.now();
  while (Date.now() - t0 < LOAD_TIMEOUT) {
    const t = await chrome.tabs.get(tabId);
    if (t.url && !t.url.startsWith("about:") && t.status === "complete") return;
    await sleep(250);
  }
}

function waitForTabLoad(tabId) {
  return new Promise(resolve => {
    let finished = false;
    const done = () => {
      if (finished) return;
      finished = true;
      chrome.tabs.onUpdated.removeListener(onUpd);
      clearTimeout(timer);
      resolve();
    };
    const onUpd = (id, info) => { if (id === tabId && info.status === "complete") done(); };
    const timer = setTimeout(done, LOAD_TIMEOUT); // print whatever loaded if the page never finishes
    chrome.tabs.onUpdated.addListener(onUpd);
    chrome.tabs.get(tabId).then(t => { if (t.status === "complete") done(); }).catch(done);
  });
}

// Runs inside the captured page: make lazy images load, wait a moment, return title + links.
// selectors: "all" = every link on the page, an array = only links inside elements you picked, null = none.
async function probePage(waitMs, selectors) {
  for (const img of document.images) {
    if (img.loading === "lazy") img.loading = "eager";
    const ds = img.dataset.src || img.dataset.lazySrc || img.dataset.original;
    if (ds && (!img.getAttribute("src") || img.src.startsWith("data:"))) img.src = ds;
  }
  await new Promise(r => setTimeout(r, waitMs));
  const pending = [...document.images].filter(i => !i.complete);
  await Promise.race([
    Promise.all(pending.map(i => new Promise(r => { i.addEventListener("load", r); i.addEventListener("error", r); }))),
    new Promise(r => setTimeout(r, 6000))
  ]);
  let links = [];
  if (selectors === "all") {
    links = [...document.querySelectorAll("a[href]")].map(a => a.href);
  } else if (Array.isArray(selectors)) {
    const grab = sel => {
      let els = [];
      try { els = [...document.querySelectorAll(sel)]; } catch {}
      for (const el of els) {
        const a = el.closest("a[href]");
        if (a) links.push(a.href);
        else for (const x of el.querySelectorAll("a[href]")) links.push(x.href);
      }
    };
    for (const g of selectors) {
      const sel = typeof g === "string" ? g : g.sel;
      let tabs = [];
      if (g.tabSel) { try { tabs = [...document.querySelectorAll(g.tabSel)]; } catch {} }
      if (!tabs.length) { grab(sel); continue; }
      // Click each tab on the page and read the same spot every time.
      for (const t of tabs) {
        try { t.click(); } catch {}
        await new Promise(r => setTimeout(r, 1000));
        grab(sel);
      }
    }
  }
  // Sites that squeeze the article into a one-screen scrolling box would print only the first
  // screen. Find the clipped box holding the most text and let it (and its parents) grow.
  try {
    const set = (el, k, v) => el.style.setProperty(k, v, "important");
    let main = null, best = 200;
    for (const e of document.querySelectorAll("body *")) {
      if (e.clientHeight < 100 || e.scrollHeight <= e.clientHeight + 20) continue;
      if (!/(auto|scroll|hidden|clip)/.test(getComputedStyle(e).overflowY)) continue;
      const n = (e.innerText || "").length;
      if (n > best) { best = n; main = e; }
    }
    if (main) {
      for (let e = main; e; e = e.parentElement) {
        set(e, "height", "auto"); set(e, "max-height", "none");
        set(e, "overflow", "visible"); set(e, "overflow-y", "visible");
      }
    }
  } catch {}
  return { title: document.title || location.href, links };
}

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Open a PDF file. Many PDFs (FAA handbooks, etc.) are "locked" against editing but open without
// a password; those get unlocked here. Merging them without unlocking turns their pages into
// blank or rainbow-static garbage.
async function openPdf(bytes) {
  const probe = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  if (!probe.isEncrypted) return probe;
  let doc;
  try {
    doc = await PDFDocument.load(bytes, { password: "", updateMetadata: false });
  } catch {
    throw new Error("this PDF needs a password, so it was left out");
  }
  doc.unlocked = true;
  return doc;
}

// Read every page the way PDF readers like pdf.js (and Instant Search) do, and report pages
// that fail. Chrome's own viewer quietly skips damaged parts, so they're easy to miss there.
let pdfjsPromise = null;
function loadPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import(chrome.runtime.getURL("lib/pdf.min.mjs")).then(m => {
      m.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("lib/pdf.worker.min.mjs");
      return m;
    });
  }
  return pdfjsPromise;
}
async function findDamagedPages(bytes) {
  const pdfjs = await loadPdfjs();
  const doc = await pdfjs.getDocument({ data: bytes.slice(0), isEvalSupported: false, stopAtErrors: true, verbosity: 0 }).promise;
  const bad = [];
  try {
    for (let i = 1; i <= doc.numPages; i++) {
      try {
        const page = await doc.getPage(i);
        await page.getTextContent();
        await page.getOperatorList();   // also decodes the page's pictures
        page.cleanup();
      } catch {
        bad.push(i - 1);
      }
    }
  } finally {
    doc.destroy();
  }
  return bad;
}

// Copy of a PDF without the given pages (0-based).
async function withoutPages(doc, bad) {
  const out = await PDFDocument.create();
  const keep = doc.getPageIndices().filter(i => !bad.includes(i));
  (await out.copyPages(doc, keep)).forEach(p => out.addPage(p));
  return out.save();
}

// Some sites' print styles hide the whole page (Obsidian Publish hides everything but a box only
// its desktop app creates), so the printout comes out blank. In "auto" we compare how much text
// shows in print mode vs on screen, and print it as it looks on screen when print mode hides most of it.
async function pickMedia(target) {
  const look = settings.look || "auto";
  if (look !== "auto") return look === "screen" ? "screen" : "print";
  const textLen = async media => {
    await chrome.debugger.sendCommand(target, "Emulation.setEmulatedMedia", { media });
    const r = await chrome.debugger.sendCommand(target, "Runtime.evaluate",
      { expression: "(document.body && document.body.innerText || '').trim().length", returnByValue: true });
    return (r && r.result && r.result.value) || 0;
  };
  const onPrint = await textLen("print");
  const onScreen = await textLen("screen");
  return onScreen > 100 && onPrint < onScreen * 0.3 ? "screen" : "print";
}

// Prints the tab to PDF. The debugger must already be attached (processNode does that).
async function printTab(tabId) {
  const target = { tabId };
  {
    const media = await pickMedia(target);
    await chrome.debugger.sendCommand(target, "Emulation.setEmulatedMedia", { media: media === "screen" ? "screen" : "" });
    const [w, h] = PAPER[settings.paper] || PAPER.letter;
    const footer = settings.footer;
    const res = await chrome.debugger.sendCommand(target, "Page.printToPDF", {
      printBackground: true,
      paperWidth: w,
      paperHeight: h,
      marginTop: 0.4,
      marginBottom: footer ? 0.55 : 0.4,
      marginLeft: 0.4,
      marginRight: 0.4,
      displayHeaderFooter: footer,
      headerTemplate: "<div></div>",
      footerTemplate:
        '<div style="font-size:7px;color:#888;width:100%;padding:0 0.4in;display:flex;justify-content:space-between;font-family:sans-serif">' +
        '<span class="url" style="overflow:hidden;white-space:nowrap;text-overflow:ellipsis;max-width:85%"></span>' +
        '<span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>'
    });
    return b64ToBytes(res.data);
  }
}

// ---------- capture one page ----------
// What to do with a page: save it as PDF? read which links from it?
function planFor(node) {
  if (job.mode === "recipe") {
    const L = job.recipe.levels;
    const sels = lv => lv.groups || lv.selectors; // (older saved picks used "selectors")
    // The start page: use exactly the pages you picked there.
    if (node.depth === 0) return { pdf: settings.includeStart, selectors: null, preset: L[0] ? (L[0].urls || null) : null, fallback: L[0] && sels(L[0]) };
    const lv = L[node.depth - 1], next = L[node.depth];
    const follow = lv.role !== "download" && next;
    return { pdf: lv.role !== "follow" || !next, selectors: follow ? sels(next) : null };
  }
  return { pdf: node.depth > 0 || settings.includeStart, selectors: node.depth < settings.depth ? "all" : null };
}

async function processNode(node) {
  if (cancelled) return;
  const plan = planFor(node);
  if (plan.preset === null && plan.fallback) plan.selectors = plan.fallback;
  const needLinks = !!plan.selectors;
  const needPdf = plan.pdf;

  // Start page that isn't going in the PDF: no need to even open it.
  if (plan.preset && !needPdf) {
    node.links = plan.preset;
    node.title = "Start page";
    node.status = "done"; readOnlyCount++;
    updateRow(node, "✅", "your picked pages");
    refreshStats();
    return;
  }
  node.status = "loading";
  updateRow(node, "🔄", "loading");

  // Links that already point at a PDF file: just download the bytes.
  if (isPdfUrl(node.url)) {
    try {
      const r = await fetch(node.url, { credentials: "include" });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const bytes = new Uint8Array(await r.arrayBuffer());
      const doc = await openPdf(bytes);
      // Locked PDFs were unlocked by openPdf; save an unlocked copy so the merge reads it correctly.
      let clean = doc.unlocked ? await doc.save() : bytes;
      const total = doc.getPageCount();
      updateRow(node, "🔎", `checking ${total} pages`);
      let bad = [];
      try { bad = await findDamagedPages(clean); } catch { bad = doc.getPageIndices(); }
      if (bad.length >= total) throw new Error("this PDF is damaged and can't be read, so it was left out");
      if (bad.length) clean = await withoutPages(await openPdf(clean), bad);
      node.pdf = clean;
      node.title = doc.getTitle() || decodeURIComponent(new URL(node.url).pathname.split("/").pop());
      node.links = [];
      node.status = "done"; doneCount++;
      const notes = [doc.unlocked && "unlocked", bad.length && `${bad.length} damaged page${bad.length === 1 ? "" : "s"} left out`].filter(Boolean);
      updateRow(node, "✅", `PDF file · ${total - bad.length} page${total - bad.length === 1 ? "" : "s"}${notes.length ? " (" + notes.join(", ") + ")" : ""}`);
    } catch (e) {
      node.status = "failed"; failCount++;
      updateRow(node, "⚠️", "failed: " + (e.message || e));
    }
    refreshStats();
    return;
  }

  let tab, attached = false;
  try {
    // Open a blank tab, install PAGE_SHIM, then load the real page so the shim runs first.
    tab = await openWorkerTab("about:blank");
    openTabs.add(tab.id);
    await waitForTabLoad(tab.id);
    await chrome.debugger.attach({ tabId: tab.id }, "1.3");
    attached = true;
    await chrome.debugger.sendCommand({ tabId: tab.id }, "Page.enable");
    await chrome.debugger.sendCommand({ tabId: tab.id }, "Page.addScriptToEvaluateOnNewDocument", { source: PAGE_SHIM });
    await chrome.debugger.sendCommand({ tabId: tab.id }, "Page.navigate", { url: node.url });
    await waitForPageLoad(tab.id);
    if (cancelled) return;

    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: probePage,
      args: [settings.waitMs, plan.selectors]
    });
    node.title = (result.title || node.url).trim();
    node.links = plan.preset || (needLinks ? result.links : []);

    // If the page redirected somewhere else, remember that address too so it isn't captured twice.
    const finalUrl = normalizeUrl((await chrome.tabs.get(tab.id)).url);
    if (finalUrl) seen.add(finalUrl);

    if (needPdf) {
      updateRow(node, "🖨️", "printing");
      node.pdf = await printTab(tab.id);
    }
    node.status = "done";
    if (needPdf) doneCount++; else readOnlyCount++;
    updateRow(node, "✅", needPdf ? `${(node.pdf.length / 1024).toFixed(0)} KB` : "links read");
  } catch (e) {
    node.status = "failed"; failCount++;
    updateRow(node, "⚠️", "failed: " + (e.message || e));
  } finally {
    if (attached) await chrome.debugger.detach({ tabId: tab.id }).catch(() => {});
    if (tab) {
      openTabs.delete(tab.id);
      chrome.tabs.remove(tab.id).catch(() => {});
    }
    refreshStats();
  }
}

// Keeps `settings.parallel` pages going at once; changing it mid-run takes effect right away.
function runPool(items, fn) {
  return new Promise(resolve => {
    let i = 0, running = 0;
    pump = () => {
      while (running < settings.parallel && i < items.length && !stopRequested && !cancelled) {
        running++;
        fn(items[i++]).catch(() => {}).finally(() => { running--; pump(); });
      }
      if (running === 0 && (i >= items.length || stopRequested || cancelled)) resolve();
    };
    pump();
  });
}

// Background pages open in their own minimized window so they don't crowd your tab bar.
async function openWorkerTab(url) {
  if (workerWindowId !== null) {
    try { return await chrome.tabs.create({ windowId: workerWindowId, url, active: false }); }
    catch { workerWindowId = null; } // you closed that window; make a new one
  }
  try {
    const w = await chrome.windows.create({ url: "about:blank", focused: false, state: "minimized" });
    workerWindowId = w.id;
    return await chrome.tabs.create({ windowId: workerWindowId, url, active: false });
  } catch {
    return await chrome.tabs.create({ url, active: false }); // fall back to this window
  }
}
async function closeWorkerWindow() {
  if (workerWindowId === null) return;
  const id = workerWindowId; workerWindowId = null;
  await chrome.windows.remove(id).catch(() => {});
}

function showParallel() { $("nParallel").textContent = settings.parallel; }
function setParallel(n) {
  settings.parallel = Math.max(1, Math.min(MAX_PARALLEL, n));
  showParallel();
  chrome.storage.local.get("settings").then(({ settings: s }) =>
    chrome.storage.local.set({ settings: { ...(s || {}), parallel: settings.parallel, speedV2: true } }));
  if (pump) pump();
}

function makeNode(url, depth, parent) {
  const node = { id: nodes.length, url, depth, parent, children: [], status: "queued" };
  nodes.push(node);
  if (parent) parent.children.push(node);
  addRow(node);
  return node;
}

// ---------- merge ----------
// Build the order pages go in, plus a bookmark tree. Pages that failed are left out and
// their children move up a level so nothing is lost from the bookmarks.
function orderedEntries(root) {
  if (settings.order === "level") {
    return nodes.filter(n => n.pdf).map(n => ({ node: n, children: [] }));
  }
  const walk = n => {
    const kids = n.children.flatMap(walk);
    return n.pdf ? [{ node: n, children: kids }] : kids;
  };
  return walk(root);
}

function addOutline(doc, entries) {
  const ctx = doc.context;
  const build = (parentRef, list) => {
    const refs = list.map(() => ctx.nextRef());
    list.forEach((e, i) => {
      const d = {
        Title: PDFHexString.fromText(e.node.title || e.node.url),
        Parent: parentRef,
        Dest: ctx.obj([e.pageRef, PDFName.of("XYZ"), PDFNull, PDFNull, PDFNull])
      };
      if (i > 0) d.Prev = refs[i - 1];
      if (i < list.length - 1) d.Next = refs[i + 1];
      if (e.children.length) {
        const sub = build(refs[i], e.children);
        d.First = sub.first; d.Last = sub.last;
        d.Count = -e.children.length; // collapsed by default
      }
      ctx.assign(refs[i], ctx.obj(d));
    });
    return { first: refs[0], last: refs[refs.length - 1] };
  };
  const outlineRef = ctx.nextRef();
  const top = build(outlineRef, entries);
  ctx.assign(outlineRef, ctx.obj({ Type: "Outlines", First: top.first, Last: top.last, Count: entries.length }));
  doc.catalog.set(PDFName.of("Outlines"), outlineRef);
  doc.catalog.set(PDFName.of("PageMode"), PDFName.of("UseOutlines"));
}

async function mergeAndSave(root) {
  const entries = orderedEntries(root);
  const flat = [];
  const flatten = list => list.forEach(e => { flat.push(e); flatten(e.children); });
  flatten(entries);
  if (!flat.length) { setStatus("Nothing was captured, so there's no PDF to save."); return; }

  const out = await PDFDocument.create();
  out.setTitle(root.title || job.startUrl);
  out.setCreator("Links to One PDF");
  let k = 0;
  for (const e of flat) {
    k++;
    setStatus(`Merging ${k} of ${flat.length}…`);
    try {
      const src = await openPdf(e.node.pdf);
      const pages = await out.copyPages(src, src.getPageIndices());
      pages.forEach(p => out.addPage(p));
      e.pageRef = pages[0]?.ref;
    } catch (err) {
      updateRow(e.node, "⚠️", "couldn't merge");
    }
    e.node.pdf = null; // free memory as we go
    if (k % 10 === 0) await sleep(0);
  }
  // Drop bookmarks for anything that couldn't be merged (keeping their children).
  const prune = list => list.flatMap(e => {
    e.children = prune(e.children);
    return e.pageRef ? [e] : e.children;
  });
  const marks = prune(entries);
  if (marks.length) addOutline(out, marks);

  setStatus("Saving the merged PDF…");
  const bytes = await out.save();
  const blobUrl = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
  const name = (root.title || new URL(job.startUrl).hostname)
    .replace(/[\\/:*?"<>|~\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 90) || "merged";
  const filename = `${name} (${out.getPageCount()} pages).pdf`;

  const a = $("download");
  a.href = blobUrl; a.download = filename; a.hidden = false;
  try {
    await chrome.downloads.download({ url: blobUrl, filename, saveAs: false });
  } catch {
    a.click();
  }
  const mb = (bytes.length / 1048576).toFixed(1);
  setStatus(`Done – ${flat.length} pages merged into one PDF (${out.getPageCount()} PDF pages, ${mb} MB). Saved to your Downloads folder.`);
}

// ---------- main ----------
async function main() {
  ({ job } = await chrome.storage.local.get("job"));
  if (!job) { setStatus("No job found. Start one from the extension's toolbar button."); return; }
  settings = { ...DEFAULT_SETTINGS, ...job.settings };
  settings.parallel = Math.max(1, Math.min(MAX_PARALLEL, Number(settings.parallel) || DEFAULT_SETTINGS.parallel));
  showParallel();
  const startUrl = normalizeUrl(job.startUrl);
  const recipe = job.mode === "recipe";
  const maxDepth = recipe ? job.recipe.levels.length : settings.depth;
  $("start").textContent = recipe
    ? `${job.startUrl}  ·  ${maxDepth} picked level${maxDepth === 1 ? "" : "s"}: ` +
      job.recipe.levels.map((l, i) => `L${i + 1} ${{ download: "download", follow: "more links", both: "download + more links" }[l.role]}`).join(" → ")
    : `${job.startUrl}  ·  depth ${settings.depth}  ·  ${{ site: "same website", folder: "same folder", any: "any website" }[settings.scope]}`;
  // Picked links are used as-is (you chose them); automatic mode applies the scope filters.
  keep = recipe
    ? (u => !SKIP_EXT.test(new URL(u).pathname) && (settings.linkedPdfs || !isPdfUrl(u)))
    : makeFilter(startUrl, settings);

  seen.add(startUrl);
  const root = makeNode(startUrl, 0, null);
  let level = [root];
  let capped = false;

  for (let d = 0; level.length && !stopRequested && !cancelled; d++) {
    currentLevel = d;
    setStatus(d === 0 ? "Reading the start page…" : `Level ${d}: capturing ${level.length} pages…`);
    refreshStats();
    await runPool(level, processNode);
    if (d >= maxDepth || stopRequested || cancelled) break;

    // Queue new links found on this level, in page order, skipping anything already seen.
    const next = [];
    for (const node of level) {
      for (const href of node.links || []) {
        const u = normalizeUrl(href, node.url);
        if (!u || seen.has(u) || !keep(u)) continue;
        if (nodes.length >= settings.maxPages) { capped = true; break; }
        seen.add(u);
        next.push(makeNode(u, d + 1, node));
      }
      node.links = null;
    }
    level = next;
    refreshStats();
  }

  // Anything still queued (after a stop) is marked skipped.
  await closeWorkerWindow();
  for (const n of nodes) if (n.status === "queued") { n.status = "skipped"; updateRow(n, "⏭️", "skipped"); }
  $("stop").disabled = true; $("cancel").disabled = true;
  if (cancelled) { setStatus("Cancelled. Nothing was saved."); return; }
  await mergeAndSave(root);
  if (capped) $("status").textContent += ` Stopped at the ${settings.maxPages}-page limit (raise "Max pages" to get more).`;
}

$("slower").addEventListener("click", () => setParallel(settings.parallel - 1));
$("faster").addEventListener("click", () => setParallel(settings.parallel + 1));
$("stop").addEventListener("click", () => {
  stopRequested = true;
  $("stop").disabled = true;
  setStatus("Stopping after the pages in progress finish…");
});
$("cancel").addEventListener("click", async () => {
  cancelled = stopRequested = true;
  $("stop").disabled = true; $("cancel").disabled = true;
  for (const id of openTabs) chrome.tabs.remove(id).catch(() => {});
  closeWorkerWindow();
  setStatus("Cancelled. Nothing was saved.");
});
window.addEventListener("beforeunload", e => {
  if (!cancelled && $("stop").disabled === false) { e.preventDefault(); e.returnValue = ""; }
});

main().catch(e => setStatus("Something went wrong: " + (e.message || e)));
