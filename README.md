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

1. Open the start page and click the extension icon → **Start picking on this page**. A panel appears on the page.
2. **Level 1:** click a link. With "Also select similar items" on, the whole list or row it belongs to gets selected (blue boxes). Use **−** / **+** on the selection to make it narrower or wider. Click a selected link again to unselect it. You can make several selections on one level.
   - You can also click a whole box (for example a sidebar) to take every link inside it.
   - Hold **Alt** while clicking, or switch to **Use page normally**, to click the page itself. Use that to open a tab on the page before picking the links inside it.
3. Tell it what those pages are:
   - **Pages to download** – this is the last level.
   - **Pages with more links** – click **Pick next level →**. It opens one of those pages as a sample so you can pick level 2 there. Use ◀ ▶ to look at other sample pages.
   - **Both** – download them *and* pick links inside them.
4. Repeat for as many levels as you need, then press **Make PDF**.

Your picks get applied to every page at that level, not just the sample. They're saved, so the popup's **Edit picks** / **Make PDF** buttons let you change or rerun them later.

### Example: CFI Notebook

- Level 1 (start page): click a link in the Flight Training tab → *Pages with more links*
- Level 2 (a chapter page): click a link in the right-hand list → *Pages with more links*
- Level 3: click an article link → *Pages to download* → **Make PDF**

## Automatic mode

Under "Automatic mode" in the popup: grab every link on the page, 1–3 levels deep, filtered to the same website/folder and optional text filters.

## Notes

- Keep the progress tab open until it finishes. **Stop & save what I have** merges whatever is done so far.
- Chrome shows a "started debugging this browser" bar while a job runs. That's how pages get printed to PDF, and it goes away when the job ends.
- The same page is never captured twice, and `#anchor` links count as the same page.
- PDF options (paper size, page order, URL footer, pages at once, max pages) are under **PDF options** in the popup.
- Pages behind a login work as long as you're logged in in Chrome.
