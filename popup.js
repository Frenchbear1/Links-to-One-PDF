const $ = id => document.getElementById(id);
const FIELDS = ["depth", "scope", "include", "exclude", "maxPages", "parallel", "waitMs", "paper", "order"];
const CHECKS = ["includeStart", "footer", "linkedPdfs"];
let activeTab = null;

function readForm() {
  const s = {};
  for (const f of FIELDS) {
    const el = $(f);
    s[f] = el.type === "number" || f === "depth" ? Number(el.value) : el.value;
  }
  for (const c of CHECKS) s[c] = $(c).checked;
  s.parallel = Math.max(1, Math.min(16, s.parallel || 8));
  s.speedV2 = true;
  return s;
}

async function saveForm() {
  await chrome.storage.local.set({ settings: readForm() });
}

// Count the links on the open page that match the current filters (first level only).
async function preview() {
  const box = $("preview");
  const startUrl = normalizeUrl($("startUrl").value);
  if (!startUrl) { box.textContent = "Enter a valid http(s) start page."; return; }
  if (!activeTab || normalizeUrl(activeTab.url) !== startUrl) {
    box.textContent = "Links will be read when the crawl opens this page.";
    return;
  }
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: activeTab.id },
      func: () => [...document.querySelectorAll("a[href]")].map(a => a.href)
    });
    const keep = makeFilter(startUrl, readForm());
    const seen = new Set([startUrl]);
    const urls = [];
    for (const h of result) {
      const u = normalizeUrl(h, startUrl);
      if (u && !seen.has(u) && keep(u)) { seen.add(u); urls.push(u); }
    }
    const depth = Number($("depth").value);
    box.innerHTML = `<b>${urls.length}</b> matching links on this page` +
      (depth > 1 ? ` (more will be found inside them at depth ${depth}).` : ".") +
      (urls.length ? "<br>" + urls.slice(0, 6).map(u => "• " + u.replace(/^https?:\/\//, "")).join("<br>") + (urls.length > 6 ? "<br>…" : "") : "");
  } catch (e) {
    box.textContent = "Can't read this page (Chrome blocks extensions on some pages, like the Web Store or chrome:// pages).";
  }
}

async function showSaved() {
  const { pick } = await chrome.storage.local.get("pick");
  const groups = l => l.groups || [];
  const pages = l => new Set(groups(l).flatMap(g => g.items.map(i => i.url))).size;
  const has = pick && pick.levels && pick.levels.some(l => groups(l).length);
  $("saved").hidden = !has;
  if (!has) return;
  const roles = { download: "download", follow: "more links", both: "download + more links" };
  const used = [];
  for (const l of pick.levels) { if (!groups(l).length) break; used.push(l); if (l.role === "download") break; }
  $("savedText").textContent =
    `Saved picks for ${pick.startUrl.replace(/^https?:\/\/(www\.)?/, "")}: ` +
    used.map((l, i) => i === 0 ? `step 1: ${pages(l)} pages (${roles[l.role]})` : `step ${i + 1}: ${roles[l.role]}`).join(" → ");
}

async function startPicking(resume) {
  if (!activeTab || !/^https?:/.test(activeTab.url || "")) {
    alert("Open a normal web page first (Chrome doesn't let extensions run on chrome:// pages).");
    return;
  }
  await saveForm();
  await chrome.runtime.sendMessage({ type: "startPicking", tabId: activeTab.id, url: activeTab.url, resume });
  window.close();
}

async function init() {
  const s = await loadSettings();
  for (const f of FIELDS) $(f).value = s[f];
  for (const c of CHECKS) $(c).checked = s[c];
  [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  $("startUrl").value = activeTab?.url || "";

  for (const id of [...FIELDS, ...CHECKS, "startUrl"]) {
    $(id).addEventListener("change", () => { saveForm(); preview(); });
  }
  $("pick").addEventListener("click", () => startPicking(false));
  $("resume").addEventListener("click", () => startPicking(true));
  $("runSaved").addEventListener("click", async () => {
    await saveForm();
    await chrome.runtime.sendMessage({ type: "runRecipe" });
    window.close();
  });
  $("clear").addEventListener("click", async () => {
    await chrome.storage.local.remove("pick");
    showSaved();
  });
  $("rescan").addEventListener("click", preview);
  $("autoBox").addEventListener("toggle", () => { if ($("autoBox").open) preview(); });
  $("start").addEventListener("click", async () => {
    const startUrl = $("startUrl").value.trim();
    if (!normalizeUrl(startUrl)) { $("preview").textContent = "Enter a valid http(s) start page."; return; }
    await saveForm();
    await chrome.storage.local.set({ job: { mode: "auto", startUrl, settings: readForm(), created: Date.now() } });
    await chrome.tabs.create({ url: chrome.runtime.getURL("runner.html"), index: (activeTab?.index ?? 0) + 1 });
    window.close();
  });
  showSaved();
}

init();
