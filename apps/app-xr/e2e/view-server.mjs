/**
 * Minimal HTTP server for Playwright e2e tests.
 * Serves view-host HTML at /api/xr/view-host/:id without a full Eliza runtime.
 */
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const PORT = parseInt(process.env.XR_TEST_PORT ?? "31337", 10);

function viewHostHtml(viewId) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>XR View — ${viewId}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0 }
    html, body { height: 100%; overflow: hidden; background: #000; color: #fff; font-family: system-ui, sans-serif; }
    #xr-shell { position: fixed; inset: 0; display: flex; flex-direction: column; }
    #xr-bar { height: 44px; background: rgba(0,0,0,.8); display: flex; align-items: center; padding: 0 16px; gap: 12px; }
    #xr-bar-title { flex: 1; font-size: 0.9rem; font-weight: 600; }
    #btn-close { background: rgba(255,255,255,.15); border: none; color: #fff; border-radius: 8px; padding: 4px 12px; cursor: pointer; font-size: 0.85rem; }
    #xr-content { flex: 1; overflow: auto; padding: 16px; }
    #voice-indicator { width: 10px; height: 10px; border-radius: 50%; background: #333; transition: background 0.2s; }
    #voice-indicator.active { background: #ef4444; }
    #transcript-toast { position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%);
      background: rgba(0,0,0,.85); color: #fff; padding: 8px 20px; border-radius: 20px;
      font-size: 0.85rem; opacity: 0; transition: opacity 0.2s; pointer-events: none; }
    #transcript-toast.show { opacity: 1; }
    #view-mount { padding: 8px; }
  </style>
</head>
<body data-view-id="${viewId}">
  <div id="xr-shell">
    <div id="xr-bar">
      <div id="voice-indicator"></div>
      <span id="xr-bar-title">${viewId}</span>
      <button id="btn-close">Close</button>
    </div>
    <div id="xr-content">
      <div id="view-mount"></div>
    </div>
  </div>
  <div id="transcript-toast"></div>
  <script>
    document.getElementById('btn-close').addEventListener('click', function() {
      window.parent.postMessage({ type: 'xr:close-view', viewId: '${viewId}' }, '*');
    });

    window.addEventListener('message', function(e) {
      var d = e.data;
      if (!d || typeof d !== 'object') return;

      if (d.type === 'xr:transcript') {
        var text = String(d.text || '');
        var el = document.activeElement;
        if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
          el.value = text;
          el.dispatchEvent(new Event('input', { bubbles: true }));
        }
        var cb = document.querySelector('[role="combobox"]');
        if (cb) cb.setAttribute('aria-label', text);
        var toast = document.getElementById('transcript-toast');
        if (toast) {
          toast.textContent = text;
          toast.classList.add('show');
          setTimeout(function() { toast.classList.remove('show'); }, 2000);
        }
        return;
      }

      if (d.type === 'xr:focus-next') {
        var focusable = Array.from(document.querySelectorAll(
          'input:not([disabled]),textarea:not([disabled]),select:not([disabled]),button:not([disabled]),[tabindex]:not([tabindex="-1"])'
        ));
        var idx = focusable.indexOf(document.activeElement);
        if (idx >= 0 && idx < focusable.length - 1) {
          focusable[idx + 1].focus();
        }
        return;
      }

      if (d.type === 'xr:voice-start') {
        var ind = document.getElementById('voice-indicator');
        if (ind) ind.classList.add('active');
        return;
      }

      if (d.type === 'xr:voice-stop') {
        var ind2 = document.getElementById('voice-indicator');
        if (ind2) ind2.classList.remove('active');
        return;
      }
    });
  </script>
</body>
</html>`;
}

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const match = url.pathname.match(/^\/api\/xr\/view-host\/([^/]+)$/);
  if (match) {
    const viewId = decodeURIComponent(match[1]);
    const html = viewHostHtml(viewId);
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
    return;
  }
  res.writeHead(404);
  res.end("Not found");
});

server.listen(PORT, () => {
  process.stdout.write(`[view-server] listening on http://localhost:${PORT}\n`);
});

process.on("SIGTERM", () => server.close());
process.on("SIGINT", () => server.close(() => process.exit(0)));
