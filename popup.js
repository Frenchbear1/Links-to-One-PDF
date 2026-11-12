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

async function init() {
  const s = await loadSettings();
  for (const f of FIELDS) $(f).value = s[f];
  for (const c of CHECKS) $(c).checked = s[c];
  [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  $("startUrl").value = activeTab?.url || "";

  for (const id of [...FIELDS, ...CHECKS, "startUrl"]) {
    $(id).addEventListener("change", () => { saveForm(); preview(); });
  }
  $("rescan").addEventListener("click", preview);
  $("start").addEventListener("click", async () => {
    const startUrl = $("startUrl").value.trim();
    if (!normalizeUrl(startUrl)) { $("preview").textContent = "Enter a valid http(s) start page."; return; }
    await saveForm();
    await chrome.storage.local.set({ job: { startUrl, settings: readForm(), created: Date.now() } });
    await chrome.tabs.create({ url: chrome.runtime.getURL("runner.html"), index: (activeTab?.index ?? 0) + 1 });
    window.close();
  });
  preview();
}

init();
