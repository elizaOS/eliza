/**
 * XR view-host route serves a self-contained HTML shell that mounts registered
 * app view bundles inside headset panels.
 *
 * The host page loads React and ReactDOM, imports `/api/views/:id/bundle.js`,
 * mounts the component with minimal elizaOS context, and bridges transcript,
 * navigation, readiness, and close events with the WebXR parent frame.
 */
import type { Route } from "@elizaos/core";
export const viewHostRoute: Route = {
  type: "GET",
  path: "/xr/view-host/:id",
  description:
    "Serves a self-contained XR-friendly HTML host page for a registered view",
  routeHandler: async (ctx) => {
    const viewId = (ctx.params as Record<string, string>)?.id ?? "";
    if (!viewId) {
      return { status: 400, body: { error: "Missing view id" } };
    }

    // Resolve the agent origin so the page can load the bundle
    const agentPort = (ctx.runtime as { port?: number }).port ?? 31337;
    const agentOrigin =
      process.env.XR_AGENT_URL ?? `http://localhost:${agentPort}`;
    const bundleUrl = `${agentOrigin}/api/views/${viewId}/bundle.js`;
    const viewsApiUrl = `${agentOrigin}/api/views`;

    const html = buildHostPage(viewId, bundleUrl, viewsApiUrl, agentOrigin);

    return {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        // Relax CSP for dynamic imports of view bundles (same agent origin only)
        "Content-Security-Policy":
          `default-src 'self' ${agentOrigin} https://esm.sh https://cdn.jsdelivr.net; ` +
          `script-src 'self' 'unsafe-inline' 'unsafe-eval' ${agentOrigin} https://esm.sh https://cdn.jsdelivr.net; ` +
          `style-src 'self' 'unsafe-inline'; ` +
          `connect-src 'self' ${agentOrigin} ws://localhost:*;`,
      },
      body: html,
    };
  },
};

// ─────────────────────────────────────────────────────────────────────────────

function buildHostPage(
  viewId: string,
  bundleUrl: string,
  viewsApiUrl: string,
  agentOrigin: string,
): string {
  return `<!DOCTYPE html>
<html lang="en" data-view-id="${viewId}">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <title>XR – ${viewId}</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0 }

    :root {
      --bg: #0d0d0f;
      --surface: #18181b;
      --border: rgba(255,255,255,0.08);
      --text: #f4f4f5;
      --muted: #a1a1aa;
      --accent: #6366f1;
      --radius: 12px;
      --font: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    }

    html, body {
      width: 100%; height: 100%;
      background: var(--bg);
      color: var(--text);
      font-family: var(--font);
      font-size: 18px; /* large for XR readability */
      line-height: 1.5;
      overflow: hidden;
    }

    #xr-shell {
      display: flex;
      flex-direction: column;
      height: 100%;
      position: relative;
    }

    /* XR header bar */
    #xr-bar {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 8px 16px;
      background: var(--surface);
      border-bottom: 1px solid var(--border);
      flex-shrink: 0;
      user-select: none;
    }
    #xr-bar-title {
      flex: 1;
      font-weight: 600;
      font-size: 1rem;
      color: var(--text);
    }
    .xr-btn {
      background: var(--border);
      border: none;
      border-radius: 8px;
      color: var(--text);
      cursor: pointer;
      font-size: 1rem;
      padding: 6px 12px;
      transition: background 0.15s;
    }
    .xr-btn:hover { background: rgba(255,255,255,0.15) }

    /* Voice indicator */
    #voice-indicator {
      display: none;
      align-items: center;
      gap: 6px;
      padding: 4px 10px;
      border-radius: 20px;
      background: var(--accent);
      font-size: 0.8rem;
      font-weight: 600;
    }
    #voice-indicator.active { display: flex }
    .voice-dot {
      width: 8px; height: 8px;
      border-radius: 50%;
      background: #fff;
      animation: pulse 1s ease-in-out infinite;
    }
    @keyframes pulse { 0%,100% { opacity: 1 } 50% { opacity: 0.4 } }

    /* Content area */
    #view-mount {
      flex: 1;
      overflow: auto;
      position: relative;
    }

    /* Loading / error states */
    #view-loader {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100%;
      gap: 12px;
      color: var(--muted);
    }
    .spinner {
      width: 36px; height: 36px;
      border: 3px solid var(--border);
      border-top-color: var(--accent);
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg) } }

    /* XR-friendly form overrides for injected views */
    #view-mount input, #view-mount textarea, #view-mount select {
      font-size: 1rem !important;
      min-height: 44px;
    }
    #view-mount button {
      min-height: 44px;
      min-width: 44px;
    }

    /* Transcript toast */
    #transcript-toast {
      position: fixed;
      bottom: 12px; left: 50%;
      transform: translateX(-50%);
      background: rgba(99,102,241,0.9);
      color: #fff;
      border-radius: 20px;
      padding: 6px 16px;
      font-size: 0.85rem;
      pointer-events: none;
      opacity: 0;
      transition: opacity 0.2s;
      white-space: nowrap;
      max-width: 90vw;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    #transcript-toast.show { opacity: 1 }
  </style>
</head>
<body>
  <div id="xr-shell">
    <div id="xr-bar">
      <span id="xr-bar-title">${viewId}</span>
      <div id="voice-indicator">
        <div class="voice-dot"></div>
        <span>Listening</span>
      </div>
      <button class="xr-btn" id="btn-close" title="Close panel">✕</button>
    </div>

    <div id="view-mount">
      <div id="view-loader">
        <div class="spinner"></div>
        <span>Loading ${viewId}…</span>
      </div>
    </div>
  </div>

  <div id="transcript-toast"></div>

  <!-- React from CDN — must match the version view bundles are built against -->
  <script type="importmap">
  {
    "imports": {
      "react": "https://esm.sh/react@18",
      "react-dom": "https://esm.sh/react-dom@18",
      "react-dom/client": "https://esm.sh/react-dom@18/client",
      "react/jsx-runtime": "https://esm.sh/react@18/jsx-runtime"
    }
  }
  </script>

  <script type="module">
    const VIEW_ID = "${viewId}";
    const BUNDLE_URL = "${bundleUrl}";
    const VIEWS_API = "${viewsApiUrl}";
    const AGENT_ORIGIN = "${agentOrigin}";

    // ── postMessage bridge ───────────────────────────────────────────────────

    function notifyParent(msg) {
      window.parent.postMessage(msg, "*");
    }

    window.addEventListener("message", (ev) => {
      if (ev.data?.type === "xr:transcript") fillFocusedInput(ev.data.text);
      if (ev.data?.type === "xr:focus-next") focusNext();
      if (ev.data?.type === "xr:voice-start") showVoiceIndicator(true);
      if (ev.data?.type === "xr:voice-end")   showVoiceIndicator(false);
    });

    // ── Voice input helpers ──────────────────────────────────────────────────

    function fillFocusedInput(text) {
      const el = document.activeElement;
      if (!el) return;
      const tag = el.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") {
        const native = Object.getOwnPropertyDescriptor(window[tag === "INPUT" ? "HTMLInputElement" : "HTMLTextAreaElement"].prototype, "value");
        native.set.call(el, text);
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        showTranscript(text);
      } else if (tag === "SELECT") {
        // Voice select: find option whose text matches transcript (case-insensitive)
        const select = /** @type {HTMLSelectElement} */ (el);
        const lower = text.toLowerCase();
        for (const opt of select.options) {
          if (opt.text.toLowerCase().includes(lower) || opt.value.toLowerCase().includes(lower)) {
            const native = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value");
            native.set.call(select, opt.value);
            select.dispatchEvent(new Event("change", { bubbles: true }));
            showTranscript(text);
            break;
          }
        }
      } else {
        // ARIA combobox / listbox — set aria-activedescendant or dispatch custom event
        const role = el.getAttribute("role");
        if (role === "combobox" || role === "listbox" || role === "searchbox") {
          el.dispatchEvent(new CustomEvent("xr:transcript", { detail: { text }, bubbles: true }));
          showTranscript(text);
        }
      }
    }

    function focusNext() {
      const all = Array.from(document.querySelectorAll("input,textarea,button,select,[tabindex]"))
        .filter(el => !el.disabled && !el.closest("[hidden]"));
      const idx = all.indexOf(document.activeElement);
      const next = all[idx + 1] ?? all[0];
      next?.focus();
    }

    function showVoiceIndicator(active) {
      const el = document.getElementById("voice-indicator");
      if (el) el.classList.toggle("active", active);
    }

    function showTranscript(text) {
      const toast = document.getElementById("transcript-toast");
      if (!toast) return;
      toast.textContent = text;
      toast.classList.add("show");
      clearTimeout(toast._t);
      toast._t = setTimeout(() => toast.classList.remove("show"), 3000);
    }

    // ── Close button ─────────────────────────────────────────────────────────

    document.getElementById("btn-close")?.addEventListener("click", () => {
      notifyParent({ type: "xr:close", viewId: VIEW_ID });
    });

    // ── Mount the view ───────────────────────────────────────────────────────

    async function mountView() {
      const mount = document.getElementById("view-mount");
      const loader = document.getElementById("view-loader");

      try {
        // Provide minimal elizaOS-like context so views can render
        window.__elizaXRContext = {
          agentBaseUrl: AGENT_ORIGIN,
          viewId: VIEW_ID,
          fetchViews: () => fetch(VIEWS_API).then(r => r.json()),
          navigate: (id) => notifyParent({ type: "xr:navigate", viewId: id }),
        };

        const mod = await import(/* @vite-ignore */ BUNDLE_URL);
        const component = mod.default ?? mod[Object.keys(mod)[0]];

        if (!component) throw new Error("No component export found in bundle");

        // Dynamically import React + ReactDOM
        const [React, ReactDOMClient] = await Promise.all([
          import("react"),
          import("react-dom/client"),
        ]);

        if (loader) loader.style.display = "none";

        // Render the view component
        const root = ReactDOMClient.createRoot(mount);
        root.render(React.createElement(component));

        notifyParent({ type: "xr:view-ready", viewId: VIEW_ID });

      } catch (err) {
        console.error("[xr-host] Failed to mount view:", err);
        if (loader) loader.innerHTML =
          \`<div style="color:#f87171;text-align:center;padding:24px">
            <div style="font-size:1.5rem;margin-bottom:8px">⚠ Load error</div>
            <div style="font-size:0.85rem;color:#a1a1aa">\${err.message}</div>
            <button class="xr-btn" style="margin-top:16px" onclick="mountView()">Retry</button>
          </div>\`;
        notifyParent({ type: "xr:view-error", viewId: VIEW_ID, error: err.message });
      }
    }

    mountView();
  </script>
</body>
</html>`;
}
