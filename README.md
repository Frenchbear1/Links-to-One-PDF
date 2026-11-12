# Links to One PDF

Chrome extension that opens the links you choose in background tabs, saves each page as a PDF, and merges them all into one big PDF with clickable bookmarks.

## Install

1. Download this repo (green **Code** button → **Download ZIP**) and unzip it somewhere permanent. Chrome runs it from that folder, so don't delete it.
2. In Chrome, go to `chrome://extensions`
3. Turn on **Developer mode** (top-right switch).
4. Click **Load unpacked** and pick the folder that has `manifest.json` in it.
5. Click the puzzle-piece icon in the toolbar and pin **Links to One PDF**.

After pulling an update, click the ↻ reload icon on the extension's card in `chrome://extensions`.

## Pick the links yourself (main way)

1. Open the start page, click the extension icon, then **Start picking on this page**. A panel shows up on the page.
2. **Step 1:** move your mouse over a link. An orange outline shows what you'll get ("Click to add 12 pages"). Click it and those pages turn green. They're added to your list in the panel.
   - Click a green link again to remove it. Use **Fewer** / **More** if it grabbed too little or too much.
   - Untick "Pick the whole list when I click one link" to pick links one at a time.
3. **Tabs on the page:** hold **Alt** (Option on a Mac) and click a tab to open it. You can also switch the panel to **Clicking works normally**. Your earlier picks stay in your list, and the new tab starts with nothing highlighted. If it looks like the same kind of list, the panel asks **"Want the same list from all 7 tabs?"**. Say yes and it clicks through every tab for you. Or just pick from each tab yourself, since picks keep adding up.
4. Answer **"What should I do with these pages?"**
   - **Put them in the PDF**: you're done, press **Make my PDF**.
   - **Open them, they have more links to pick**: press **Next**. It opens one of those pages as an example (◀ ▶ shows others). Pick the links there and they get picked on every one of those pages, including "every tab" if you said yes.
   - **Both**: puts them in the PDF and lets you pick links inside them.
5. Keep going for as many steps as you need, then press **Make my PDF**.

Your picks are saved, so the popup's **Edit picks** / **Make PDF** buttons let you change or rerun them later.

### Example: CFI Notebook

- Step 1 (start page): click a link in the Flight Training tab. Alt-click another tab and say **Yes** if you want every tab. Then pick *Open them, they have more links to pick*.
- Step 2 (a chapter page): click a link in the list on the right (same tab trick if it has tabs). Then pick *Open them…*
- Step 3: click an article link, pick *Put them in the PDF*, then press **Make my PDF**.

## Automatic mode

Under "Automatic mode" in the popup: grab every link on the page, 1–3 levels deep, filtered to the same website/folder and optional text filters.

## Notes

- Keep the progress tab open until it finishes. **Stop & save what I have** merges whatever is done so far.
- Chrome shows a "started debugging this browser" bar while a job runs. That's how pages get printed to PDF, and it goes away when the job ends.
- The same page is never captured twice, and `#anchor` links count as the same page.
- PDF options (paper size, page order, URL footer, pages at once (up to 16, default 8), max pages) are under **PDF options** in the popup.
- Pages behind a login work as long as you're logged in in Chrome.
- Links that point straight at PDF files (FAA handbooks, charts) are added as-is, and "locked" PDFs get unlocked first. Turn this off with **Include links that are PDF files** under PDF options. A PDF that needs a real password is skipped and marked in the progress list. Every page of a linked PDF is also test-read; damaged pages (which Chrome's viewer hides but other PDF readers choke on) are left out and counted in the progress list.
- To find where a page in the big PDF came from, open the bookmarks (☰ in Chrome's PDF viewer). Every source page is bookmarked by name.
