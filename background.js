// Keeps the picker alive across page loads in the tab you're picking in,
// and starts the runner when you press "Make PDF" in the picker.
importScripts("common.js");

async function getPick() {
  const { pick } = await chrome.storage.local.get("pick");
  return pick;
}

async function inject(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["picker.js"] });
  } catch (e) {
    // Chrome blocks extensions on some pages (chrome://, the Web Store); nothing to do there.
  }
}

chrome.tabs.onUpdated.addListener(async (tabId, info) => {
  if (info.status !== "complete") return;
  const pick = await getPick();
  if (pick && pick.active && pick.tabId === tabId) inject(tabId);
});

chrome.tabs.onRemoved.addListener(async tabId => {
  const pick = await getPick();
  if (pick && pick.active && pick.tabId === tabId) {
    pick.active = false;
    await chrome.storage.local.set({ pick });
  }
});

// Turn the saved picks into a job the runner understands.
// Step 1 uses the exact pages you picked. Later steps use where you clicked (the same
// spot on every page), and click through the page's tabs if you said yes to "every tab".
function recipeFrom(pick) {
  const levels = [];
  for (const L of pick.levels) {
    const groups = L.groups || [];
    if (!groups.length) break;
    const seen = new Set(), urls = [];
    for (const g of groups) for (const it of g.items) if (!seen.has(it.url)) { seen.add(it.url); urls.push(it.url); }
    levels.push({
      groups: groups.map(g => ({ sel: g.candidates[g.idx].sel, tabSel: g.tabSel || null })),
      urls,
      role: L.role
    });
    if (L.role === "download") break; // nothing after a download-only step is used
  }
  return { levels };
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  (async () => {
    if (msg.type === "startPicking") {
      const old = await getPick();
      const pick = msg.resume && old
        ? { ...old, active: true, tabId: msg.tabId }
        : { active: true, tabId: msg.tabId, startUrl: msg.url, current: 0, sampleIdx: 0,
            levels: [{ groups: [], role: "download" }] };
      await chrome.storage.local.set({ pick });
      if (msg.resume && old && old.current > 0) {
        // Go back to the page that level was picked on.
        const L = old.levels[old.current];
        const prev = (old.levels[old.current - 1].groups || []).flatMap(g => g.items);
        const url = L.pickedOn || (prev[0] && prev[0].url) || old.startUrl;
        await chrome.tabs.update(msg.tabId, { url });
      } else if (msg.resume && old && normalizeUrl(msg.url) !== normalizeUrl(old.startUrl)) {
        await chrome.tabs.update(msg.tabId, { url: old.startUrl });
      } else {
        await inject(msg.tabId);
      }
      reply({ ok: true });
    } else if (msg.type === "runRecipe") {
      const pick = await getPick();
      if (!pick) return reply({ ok: false });
      const settings = await loadSettings();
      await chrome.storage.local.set({
        job: { mode: "recipe", startUrl: pick.startUrl, recipe: recipeFrom(pick), settings, created: Date.now() },
        pick: { ...pick, active: false }
      });
      const tab = sender.tab;
      await chrome.tabs.create({ url: chrome.runtime.getURL("runner.html"), index: tab ? tab.index + 1 : undefined, windowId: tab?.windowId });
      reply({ ok: true });
    }
  })();
  return true;
});
