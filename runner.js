/* Runner page: crawls the links level by level in background tabs, prints each page
   to PDF through the Chrome DevTools protocol, then merges everything with pdf-lib. */

const { PDFDocument, PDFName, PDFHexString, PDFNull } = PDFLib;
const $ = id => document.getElementById(id);

const PAPER = { letter: [8.5, 11], a4: [8.27, 11.69] };
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
    for (const sel of selectors) {
      let els = [];
      try { els = [...document.querySelectorAll(sel)]; } catch {}
      for (const el of els) {
        const a = el.closest("a[href]");
        if (a) links.push(a.href);
        else for (const x of el.querySelectorAll("a[href]")) links.push(x.href);
      }
    }
  }
  return { title: document.title || location.href, links };
}

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function printTab(tabId) {
  const target = { tabId };
  await chrome.debugger.attach(target, "1.3");
  try {
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
  } finally {
    await chrome.debugger.detach(target).catch(() => {});
  }
}

// ---------- capture one page ----------
// What to do with a page: save it as PDF? read which links from it?
function planFor(node) {
  if (job.mode === "recipe") {
    const L = job.recipe.levels;
    if (node.depth === 0) return { pdf: settings.includeStart, selectors: L[0] ? L[0].selectors : null };
    const lv = L[node.depth - 1], next = L[node.depth];
    const follow = lv.role !== "download" && next;
    return { pdf: lv.role !== "follow" || !next, selectors: follow ? next.selectors : null };
  }
  return { pdf: node.depth > 0 || settings.includeStart, selectors: node.depth < settings.depth ? "all" : null };
}

async function processNode(node) {
  if (cancelled) return;
  const plan = planFor(node);
  const needLinks = !!plan.selectors;
  const needPdf = plan.pdf;
  node.status = "loading";
  updateRow(node, "🔄", "loading");

  // Links that already point at a PDF file: just download the bytes.
  if (isPdfUrl(node.url)) {
    try {
      const r = await fetch(node.url, { credentials: "include" });
      if (!r.ok) throw new Error("HTTP " + r.status);
      node.pdf = new Uint8Array(await r.arrayBuffer());
      await PDFDocument.load(node.pdf, { ignoreEncryption: true }); // make sure it's a real PDF
      node.title = decodeURIComponent(new URL(node.url).pathname.split("/").pop());
      node.links = [];
      node.status = "done"; doneCount++;
      updateRow(node, "✅", "PDF file");
    } catch (e) {
      node.status = "failed"; failCount++;
      updateRow(node, "⚠️", "failed: " + (e.message || e));
    }
    refreshStats();
    return;
  }

  let tab;
  try {
    tab = await chrome.tabs.create({ url: node.url, active: false });
    openTabs.add(tab.id);
    await waitForTabLoad(tab.id);
    if (cancelled) return;

    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: probePage,
      args: [settings.waitMs, plan.selectors]
    });
    node.title = (result.title || node.url).trim();
    node.links = needLinks ? result.links : [];

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
    if (tab) {
      openTabs.delete(tab.id);
      chrome.tabs.remove(tab.id).catch(() => {});
    }
    refreshStats();
  }
}

async function runPool(items, size, fn) {
  let i = 0;
  const worker = async () => {
    while (i < items.length && !stopRequested && !cancelled) await fn(items[i++]);
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(size, items.length)) }, worker));
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
      const src = await PDFDocument.load(e.node.pdf, { ignoreEncryption: true });
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
  const startUrl = normalizeUrl(job.startUrl);
  const recipe = job.mode === "recipe";
  const maxDepth = recipe ? job.recipe.levels.length : settings.depth;
  $("start").textContent = recipe
    ? `${job.startUrl}  ·  ${maxDepth} picked level${maxDepth === 1 ? "" : "s"}: ` +
      job.recipe.levels.map((l, i) => `L${i + 1} ${{ download: "download", follow: "more links", both: "download + more links" }[l.role]}`).join(" → ")
    : `${job.startUrl}  ·  depth ${settings.depth}  ·  ${{ site: "same website", folder: "same folder", any: "any website" }[settings.scope]}`;
  // Picked links are used as-is (you chose them); automatic mode applies the scope filters.
  keep = recipe ? (u => !SKIP_EXT.test(new URL(u).pathname)) : makeFilter(startUrl, settings);

  seen.add(startUrl);
  const root = makeNode(startUrl, 0, null);
  let level = [root];
  let capped = false;

  for (let d = 0; level.length && !stopRequested && !cancelled; d++) {
    currentLevel = d;
    setStatus(d === 0 ? "Reading the start page…" : `Level ${d}: capturing ${level.length} pages…`);
    refreshStats();
    await runPool(level, settings.parallel, processNode);
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
  for (const n of nodes) if (n.status === "queued") { n.status = "skipped"; updateRow(n, "⏭️", "skipped"); }
  $("stop").disabled = true; $("cancel").disabled = true;
  if (cancelled) { setStatus("Cancelled. Nothing was saved."); return; }
  await mergeAndSave(root);
  if (capped) $("status").textContent += ` Stopped at the ${settings.maxPages}-page limit (raise "Max pages" to get more).`;
}

$("stop").addEventListener("click", () => {
  stopRequested = true;
  $("stop").disabled = true;
  setStatus("Stopping after the pages in progress finish…");
});
$("cancel").addEventListener("click", async () => {
  cancelled = stopRequested = true;
  $("stop").disabled = true; $("cancel").disabled = true;
  for (const id of openTabs) chrome.tabs.remove(id).catch(() => {});
  setStatus("Cancelled. Nothing was saved.");
});
window.addEventListener("beforeunload", e => {
  if (!cancelled && $("stop").disabled === false) { e.preventDefault(); e.returnValue = ""; }
});

main().catch(e => setStatus("Something went wrong: " + (e.message || e)));
