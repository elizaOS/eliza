# carrot-clock

Window-mode reference carrot. Opens its own webview with a tiny live clock to validate the host's `mode: "window"` code path end-to-end.

## What it proves

- `manifest.mode === "window"` triggers `CarrotManager.openCarrotWindow`.
- BrowserView is created with `viewsRoot: <carrot.currentDir>` so `views://view/index.html` resolves correctly.
- The window's manifest dimensions (320×200) and title ("Carrot Clock") flow through.
- Closing the window calls `stopWorker(id)`.
- The worker runs in the background while the view ticks (no view ↔ worker bridge required for this demo — the view runs its own setInterval).

## Install + run

In **Settings → Carrots**:
1. Click the folder-picker button, select `packages/electrobun-carrots/examples/carrot-clock`.
2. Click **Install**.
3. Click **Start** on the new row.

You should see a small window pop up with the current time. Close the window → row state flips to `stopped`. Click Start again → window reopens.
