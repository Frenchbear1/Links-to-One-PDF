LINKS TO ONE PDF - Chrome extension

INSTALL
1. Unzip this folder somewhere permanent (e.g. Documents\link-to-pdf). Don't delete it later - Chrome runs it from there.
2. In Chrome, go to chrome://extensions
3. Turn on "Developer mode" (top-right switch).
4. Click "Load unpacked" and pick the unzipped link-to-pdf folder (the one with manifest.json in it).
5. Click the puzzle-piece icon in the toolbar and pin "Links to One PDF".

USE
1. Open the page you want to start from.
2. Click the extension icon. It shows how many links it found.
3. Pick a depth:
     1 = every link on this page
     2 = every link on this page + every link inside those pages
     3 = one more level
4. Click "Make one PDF". A progress tab opens; pages open in background tabs, get saved as PDF and close.
5. When it's done, the merged PDF goes to your Downloads folder. It has clickable bookmarks for every page.

FOR CFI NOTEBOOK
Start page: https://www.cfinotebook.net/notebook/cfi-notebook
Depth: 2   Which links: Same website   Only links containing: /notebook/
Under "More options", raise Max pages to 1000 if you want the whole notebook.

NOTES
- Keep the progress tab open until it finishes. "Stop & save what I have" merges whatever is done so far.
- Chrome shows a "started debugging this browser" bar during the job. That's how it prints pages to PDF; it goes away afterward.
- The same page is never captured twice, and #anchor links count as the same page.
- Pages that need a login work as long as you're logged in in Chrome.
