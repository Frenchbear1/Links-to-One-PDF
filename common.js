// Shared helpers used by both the popup and the runner page.

const DEFAULT_SETTINGS = {
  depth: 2,            // 1 = links on the start page, 2 = + links inside those pages, 3 = one more level
  scope: "site",       // "site" | "folder" | "any"
  include: "",         // comma-separated: only keep URLs containing any of these
  exclude: "",         // comma-separated: drop URLs containing any of these
  maxPages: 300,
  parallel: 8,         // pages loading at the same time (1-16)
  waitMs: 1500,
  includeStart: true,
  footer: true,
  paper: "letter",     // "letter" | "a4"
  order: "reading",    // "reading" (each page followed by the pages it links to) | "level"
  linkedPdfs: true     // links that point straight at .pdf files are fetched and merged as-is
};

const SKIP_EXT = /\.(png|jpe?g|gif|webp|svg|ico|bmp|tiff?|zip|rar|7z|gz|tar|exe|msi|dmg|apk|mp3|m4a|wav|ogg|mp4|m4v|mov|avi|webm|mkv|docx?|xlsx?|pptx?|csv|json|xml|rss|atom|txt|ics)$/i;

function splitList(s) {
  return (s || "").split(",").map(x => x.trim().toLowerCase()).filter(Boolean);
}

// Normalise a URL so the same page is never captured twice (drops #fragments).
function normalizeUrl(href, base) {
  try {
    const u = new URL(href, base);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    u.hash = "";
    return u.href;
  } catch {
    return null;
  }
}

function isPdfUrl(url) {
  try { return /\.pdf$/i.test(new URL(url).pathname); } catch { return false; }
}

function siteOf(host) {
  // "www.example.com" and "example.com" count as the same site
  return host.replace(/^www\./i, "").toLowerCase();
}

// Returns a function that decides whether a (normalised) URL should be crawled.
function makeFilter(startUrl, settings) {
  const start = new URL(startUrl);
  const folder = start.pathname.replace(/[^/]*$/, ""); // "/notebook/cfi-notebook" -> "/notebook/"
  const inc = splitList(settings.include);
  const exc = splitList(settings.exclude);
  return url => {
    let u;
    try { u = new URL(url); } catch { return false; }
    if (settings.scope !== "any" && siteOf(u.hostname) !== siteOf(start.hostname)) return false;
    if (settings.scope === "folder" && !u.pathname.startsWith(folder)) return false;
    const path = u.pathname;
    if (SKIP_EXT.test(path)) return false;
    if (isPdfUrl(url) && !settings.linkedPdfs) return false;
    const low = url.toLowerCase();
    if (inc.length && !inc.some(s => low.includes(s))) return false;
    if (exc.some(s => low.includes(s))) return false;
    return true;
  };
}

async function loadSettings() {
  const { settings } = await chrome.storage.local.get("settings");
  const s = { ...DEFAULT_SETTINGS, ...(settings || {}) };
  // Older versions saved 2 as the default; bump those to the new faster default once.
  if (settings && !settings.speedV2) { if (s.parallel <= 2) s.parallel = DEFAULT_SETTINGS.parallel; s.speedV2 = true; }
  s.parallel = Math.max(1, Math.min(16, Number(s.parallel) || DEFAULT_SETTINGS.parallel));
  return s;
}
