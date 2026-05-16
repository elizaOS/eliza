import { D as require_jsx_runtime, k as __exportAll } from "./electrobun-runtime-zXJ9acDW.js";
import { d as client, n as useApp } from "./useApp-Dh-r7aR7.js";
import { Jr as openExternalUrl } from "./state-BC9WO-N8.js";
import { t as AppPageSidebar } from "./AppPageSidebar-myyOdXbd.js";
import { i as AppWorkspaceChrome, s as getBrowserPageScopeCopy } from "./AppWorkspaceChrome-aH27ucau.js";
import { Button, ConfirmDialog, Input, SidebarCollapsedActionButton, SidebarContent, SidebarPanel, SidebarScrollRegion, WorkspaceLayout, useConfirm, useIntervalWhenDocumentVisible } from "@elizaos/ui";
import { ChevronDown, ChevronRight, ExternalLink, FolderOpen, Plus, RefreshCw, X } from "lucide-react";
import * as React$1 from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/components/shared/CollapsibleSidebarSection.js
var import_jsx_runtime = require_jsx_runtime();
function CollapsibleSidebarSection({ addLabel, bodyClassName, children, collapsed, emptyClassName, emptyLabel, hoverActionsOnDesktop = true, icon, indicator, label, onAdd, onToggleCollapsed, sectionKey, testIdPrefix = "sidebar-section" }) {
	const Chevron = collapsed ? ChevronRight : ChevronDown;
	const hoverHideClass = hoverActionsOnDesktop ? " opacity-0 transition-opacity group-hover/section:opacity-100 focus-visible:opacity-100" : "";
	const bodyId = `${testIdPrefix}-body-${sectionKey}`;
	const hasChildren = React$1.Children.count(children) > 0;
	return (0, import_jsx_runtime.jsxs)("section", {
		"data-testid": `${testIdPrefix}-${sectionKey}`,
		className: "group/section space-y-0",
		children: [(0, import_jsx_runtime.jsxs)("div", {
			className: "flex items-center gap-1 pr-1",
			children: [(0, import_jsx_runtime.jsxs)("button", {
				type: "button",
				onClick: () => onToggleCollapsed(sectionKey),
				"aria-expanded": !collapsed,
				"aria-controls": bodyId,
				"data-testid": `${testIdPrefix}-toggle-${sectionKey}`,
				className: "inline-flex min-w-0 flex-1 items-center gap-1.5 rounded-[var(--radius-sm)] bg-transparent px-1.5 py-1 text-left text-[11px] leading-none font-semibold uppercase tracking-[0.16em] text-muted transition-colors hover:text-txt",
				children: [
					icon ? (0, import_jsx_runtime.jsx)("span", {
						className: "inline-flex shrink-0 items-center justify-center text-muted",
						children: icon
					}) : null,
					(0, import_jsx_runtime.jsx)("span", {
						className: "truncate",
						children: label
					}),
					indicator ? (0, import_jsx_runtime.jsx)("span", {
						className: "ml-0.5 inline-flex shrink-0 items-center",
						children: indicator
					}) : null,
					(0, import_jsx_runtime.jsx)(Chevron, {
						"aria-hidden": true,
						className: `ml-0.5 h-3 w-3 shrink-0 text-muted${hoverHideClass}`
					})
				]
			}), onAdd ? (0, import_jsx_runtime.jsx)("button", {
				type: "button",
				onClick: onAdd,
				"aria-label": addLabel ?? "Add",
				title: addLabel,
				"data-testid": `${testIdPrefix}-add-${sectionKey}`,
				className: `inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-[var(--radius-sm)] bg-transparent text-muted transition-colors hover:text-txt${hoverHideClass}`,
				children: (0, import_jsx_runtime.jsx)(Plus, {
					className: "h-3.5 w-3.5",
					"aria-hidden": true
				})
			}) : null]
		}), collapsed ? null : hasChildren ? (0, import_jsx_runtime.jsx)("div", {
			id: bodyId,
			className: bodyClassName,
			children
		}) : emptyLabel ? (0, import_jsx_runtime.jsx)("div", {
			id: bodyId,
			className: emptyClassName,
			children: emptyLabel
		}) : null]
	});
}

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/utils/browser-tabs-renderer-registry.js
/**
* Window-global handshake between the BrowserWorkspaceView React component
* (which owns the live <electrobun-webview> tag refs) and the Electrobun
* preload bridge (which holds the Electroview RPC handlers that bun calls
* into for evaluate/snapshot on a tab).
*
* Mirror of the type declared in
* platforms/electrobun/src/bridge/browser-tabs-renderer-registry.ts — both
* read/write the same `window.__ELIZA_BROWSER_TABS_REGISTRY__` key.
*/
const REGISTRY_KEY = "__ELIZA_BROWSER_TABS_REGISTRY__";
/**
* Preload script string injected into every <electrobun-webview> tab so the
* host page (running in the main webview) can request a script evaluation
* via tag.executeJavascript and receive the result back via the
* `host-message` event channel.
*
* Runs inside the OOPIF (the tab's content) before any page scripts. Two
* surfaces are installed:
*
*   1. `window.__elizaTabExec(requestId, script)` — the eval-bridge entry
*      that the renderer uses for arbitrary script evaluation. Results
*      return via `__electrobunSendToHost`. `__electrobunSendToHost`
*      JSON-stringifies the payload, so we pre-clone via
*      `JSON.parse(JSON.stringify(...))` to surface unserializable results
*      as a structured `{ __unserializable, type, repr }` marker rather
*      than letting the native send silently drop them or throw.
*
*   2. `window.__elizaTabKit` — see browser-tab-kit-types.ts. Visual cursor
*      overlay + faithful pointer-event sequences + React-compatible
*      typing. Used by the agent's realistic-* subactions so the user can
*      watch the cursor move and so events fire correctly on controlled
*      inputs.
*/
const BROWSER_TAB_PRELOAD_SCRIPT = `
(() => {
  const send = (payload) => {
    try {
      if (typeof window.__electrobunSendToHost === "function") {
        window.__electrobunSendToHost(payload);
      }
    } catch (_err) {
      // No fallback — if the host bridge is missing, swallow.
    }
  };

  const describeValue = (value) => {
    if (value === null) return "null";
    const t = typeof value;
    if (t !== "object") return t;
    try {
      const ctor = value && value.constructor && value.constructor.name;
      return ctor || "object";
    } catch {
      return "object";
    }
  };

  const toCloneable = (value) => {
    if (value === undefined) return undefined;
    try {
      return JSON.parse(JSON.stringify(value));
    } catch (_err) {
      let repr;
      try {
        repr = String(value);
      } catch {
        repr = "[unprintable value]";
      }
      return {
        __unserializable: true,
        type: describeValue(value),
        repr,
      };
    }
  };

  window.__elizaTabExec = (requestId, script) => {
    let value;
    try {
      // Indirect eval gives the script the global scope, matching the
      // behaviour of webview.executeJavascript on a top-level webview.
      value = (0, eval)(script);
    } catch (err) {
      send({
        type: "__elizaTabExecResult",
        requestId,
        ok: false,
        error: err && err.message ? String(err.message) : String(err),
      });
      return;
    }

    Promise.resolve(value)
      .then((resolved) => {
        send({
          type: "__elizaTabExecResult",
          requestId,
          ok: true,
          result: toCloneable(resolved),
        });
      })
      .catch((err) => {
        send({
          type: "__elizaTabExecResult",
          requestId,
          ok: false,
          error: err && err.message ? String(err.message) : String(err),
        });
      });
  };

  // ── Visual cursor + realistic event kit ───────────────────────────────
  // Installed lazily to avoid touching the DOM before the page is ready.
  // Idempotent — re-running just returns the existing kit.
  let kit = null;
  const ensureKit = () => {
    if (kit) return kit;
    if (!document || !document.documentElement) return null;

    let cursorRoot = null;
    let cursorVisible = false;
    let cursorPos = { x: 0, y: 0 };
    let activeAnim = 0;

    const easeOut = (t) => {
      // Approximation of cubic-bezier(.22,.61,.36,1) — a brief ease-out.
      const c = 1 - t;
      return 1 - c * c * c;
    };

    const buildCursorRoot = () => {
      const root = document.createElement("div");
      root.setAttribute("aria-hidden", "true");
      root.setAttribute("data-eliza-cursor", "1");
      root.style.cssText = [
        "position:fixed",
        "left:0",
        "top:0",
        "width:0",
        "height:0",
        "pointer-events:none",
        "z-index:2147483647",
        "display:none",
        "transform:translate3d(0,0,0)",
        "will-change:transform",
      ].join(";");
      // Inline SVG arrow + ripple ring. The arrow uses a soft drop-shadow
      // so it stays visible against any page background.
      root.innerHTML = [
        "<svg width='28' height='28' viewBox='0 0 28 28' style='display:block;filter:drop-shadow(0 1px 2px rgba(0,0,0,0.45));'>",
        "  <path d='M3 2 L3 22 L9 16 L13 25 L16 23 L12 14 L20 14 Z' fill='#ffffff' stroke='#111111' stroke-width='1' stroke-linejoin='round'/>",
        "</svg>",
        "<div data-eliza-cursor-ripple style='position:absolute;left:-12px;top:-12px;width:24px;height:24px;border-radius:50%;border:2px solid #38bdf8;opacity:0;transform:scale(0.4);transition:transform 220ms ease-out, opacity 220ms ease-out;pointer-events:none;'></div>",
      ].join("");
      return root;
    };

    const ensureCursorRoot = () => {
      if (cursorRoot && cursorRoot.isConnected) return cursorRoot;
      cursorRoot = buildCursorRoot();
      document.documentElement.appendChild(cursorRoot);
      return cursorRoot;
    };

    const showCursor = () => {
      cursorVisible = true;
      const root = ensureCursorRoot();
      root.style.display = "block";
    };
    const hideCursor = () => {
      cursorVisible = false;
      if (cursorRoot) cursorRoot.style.display = "none";
    };

    const placeCursor = (x, y) => {
      cursorPos = { x, y };
      const root = ensureCursorRoot();
      root.style.transform = "translate3d(" + x + "px," + y + "px,0)";
    };

    const moveTo = (target, options) =>
      new Promise((resolve) => {
        const root = ensureCursorRoot();
        if (!cursorVisible) {
          showCursor();
          // Snap to current pos so the first move animates from where we are.
          placeCursor(cursorPos.x || target.x, cursorPos.y || target.y);
        }
        const startX = cursorPos.x;
        const startY = cursorPos.y;
        const endX = target.x;
        const endY = target.y;
        const dur = Math.max(40, Math.min(2000, (options && options.durationMs) || 220));
        const startedAt = performance.now();
        const animId = ++activeAnim;
        const step = (now) => {
          if (animId !== activeAnim) return; // Superseded by another move.
          const t = Math.min(1, (now - startedAt) / dur);
          const eased = easeOut(t);
          placeCursor(startX + (endX - startX) * eased, startY + (endY - startY) * eased);
          if (t < 1) {
            requestAnimationFrame(step);
          } else {
            resolve();
          }
        };
        requestAnimationFrame(step);
      });

    const playRipple = () => {
      const root = ensureCursorRoot();
      const ripple = root.querySelector("[data-eliza-cursor-ripple]");
      if (!ripple) return;
      ripple.style.transition = "none";
      ripple.style.opacity = "0.85";
      ripple.style.transform = "scale(0.4)";
      // Force layout so the next frame animates.
      void ripple.offsetWidth;
      ripple.style.transition = "transform 320ms ease-out, opacity 320ms ease-out";
      ripple.style.opacity = "0";
      ripple.style.transform = "scale(1.6)";
    };

    const clickAt = (target) => moveTo(target).then(() => {
      playRipple();
    });

    const highlight = (element, durationMs) => {
      if (!element || !element.style) return;
      const prevOutline = element.style.outline;
      const prevOutlineOffset = element.style.outlineOffset;
      const prevTransition = element.style.transition;
      element.style.transition = "outline-color 180ms ease-out";
      element.style.outline = "2px solid #38bdf8";
      element.style.outlineOffset = "2px";
      const dur = Math.max(120, Math.min(2000, durationMs || 360));
      setTimeout(() => {
        element.style.outline = prevOutline;
        element.style.outlineOffset = prevOutlineOffset;
        element.style.transition = prevTransition;
      }, dur);
    };

    const elementCenter = (element) => {
      const rect = element.getBoundingClientRect();
      return {
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
      };
    };

    const fireMouseEvent = (target, type, x, y, button, buttons) => {
      // view is intentionally omitted — JSDOM rejects window references at
      // construction time, real browsers fill view in during dispatch, and
      // React synthetic events don't depend on it.
      const event = new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        composed: true,
        button: button,
        buttons: buttons,
        clientX: x,
        clientY: y,
        screenX: x,
        screenY: y,
      });
      target.dispatchEvent(event);
    };

    const firePointerEvent = (target, type, x, y, button, buttons) => {
      let event;
      try {
        event = new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          composed: true,
          pointerId: 1,
          pointerType: "mouse",
          isPrimary: true,
          button: button,
          buttons: buttons,
          clientX: x,
          clientY: y,
          screenX: x,
          screenY: y,
        });
      } catch (_err) {
        // Older WebKit may not have PointerEvent; fall back to mouse only.
        return;
      }
      target.dispatchEvent(event);
    };

    const dispatchPointerSequence = (target, options) => {
      if (!target) return Promise.resolve();
      const opts = options || {};
      const center = elementCenter(target);
      const x = typeof opts.x === "number" ? opts.x : center.x;
      const y = typeof opts.y === "number" ? opts.y : center.y;
      const button = typeof opts.button === "number" ? opts.button : 0;

      return moveTo({ x: x, y: y }).then(() => {
        firePointerEvent(target, "pointerover", x, y, button, 0);
        fireMouseEvent(target, "mouseover", x, y, button, 0);
        firePointerEvent(target, "pointermove", x, y, button, 0);
        fireMouseEvent(target, "mousemove", x, y, button, 0);
        firePointerEvent(target, "pointerdown", x, y, button, 1);
        fireMouseEvent(target, "mousedown", x, y, button, 1);
        // Most form controls expect focus between mousedown and click.
        if (typeof target.focus === "function") {
          try { target.focus({ preventScroll: true }); } catch (_e) { try { target.focus(); } catch (_e2) {} }
        }
        firePointerEvent(target, "pointerup", x, y, button, 0);
        fireMouseEvent(target, "mouseup", x, y, button, 0);
        fireMouseEvent(target, "click", x, y, button, 0);
        if (opts.doubleClick) {
          fireMouseEvent(target, "dblclick", x, y, button, 0);
        }
        playRipple();
      });
    };

    // React's controlled inputs check the value setter against the
    // prototype's own descriptor to detect "real" user input. Mutating
    // .value directly bypasses that. This helper sets value via the
    // prototype descriptor so React/Preact/Solid all see the change.
    const setNativeValue = (element, value) => {
      const proto = Object.getPrototypeOf(element);
      const protoDesc = proto ? Object.getOwnPropertyDescriptor(proto, "value") : null;
      const ownDesc = Object.getOwnPropertyDescriptor(element, "value");
      if (protoDesc && protoDesc.set && (!ownDesc || ownDesc.set !== protoDesc.set)) {
        protoDesc.set.call(element, value);
      } else {
        element.value = value;
      }
    };

    const fireKey = (target, type, key) => {
      const isChar = key.length === 1;
      const code = isChar
        ? (/[a-z]/i.test(key) ? "Key" + key.toUpperCase() : ("Digit" + key))
        : key;
      const init = {
        key: key,
        code: code,
        bubbles: true,
        cancelable: true,
        composed: true,
      };
      try {
        target.dispatchEvent(new KeyboardEvent(type, init));
      } catch (_err) {
        // KeyboardEvent always exists in modern browsers; ignore.
      }
    };

    const typeRealistic = (target, text, options) => {
      if (!target) return Promise.resolve();
      const opts = options || {};
      const delay = Math.max(0, Math.min(200, typeof opts.perCharDelayMs === "number" ? opts.perCharDelayMs : 18));
      try { target.focus({ preventScroll: true }); } catch (_e) { try { target.focus(); } catch (_e2) {} }
      if (opts.replace) {
        try {
          if (typeof target.setSelectionRange === "function") {
            target.setSelectionRange(0, (target.value || "").length);
          }
        } catch (_e) {}
        setNativeValue(target, "");
        target.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
      }

      const chars = Array.from(text);
      let index = 0;
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

      const stepOne = () => {
        if (index >= chars.length) return Promise.resolve();
        const ch = chars[index++];
        fireKey(target, "keydown", ch);
        try {
          target.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, cancelable: true, composed: true, data: ch, inputType: "insertText" }));
        } catch (_e) {}
        const next = (target.value || "") + ch;
        setNativeValue(target, next);
        try {
          target.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, data: ch, inputType: "insertText" }));
        } catch (_e) {
          target.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
        }
        fireKey(target, "keyup", ch);
        if (delay > 0) return sleep(delay).then(stepOne);
        return Promise.resolve().then(stepOne);
      };

      return stepOne().then(() => {
        target.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
      });
    };

    const setFileInput = async (target, url, options) => {
      if (!target || target.tagName !== "INPUT" || target.type !== "file") {
        throw new Error("setFileInput requires an HTMLInputElement of type=file");
      }
      const opts = options || {};
      const response = await fetch(url, { credentials: "omit" });
      if (!response.ok) {
        throw new Error("setFileInput fetch failed: HTTP " + response.status);
      }
      const blob = await response.blob();
      const mimeType = opts.mimeType || blob.type || "application/octet-stream";
      const ext = (() => {
        if (/png/i.test(mimeType)) return "png";
        if (/jpe?g/i.test(mimeType)) return "jpg";
        if (/webp/i.test(mimeType)) return "webp";
        if (/gif/i.test(mimeType)) return "gif";
        return "bin";
      })();
      const fileName = opts.fileName || "upload-" + Date.now() + "." + ext;
      const file = new File([blob], fileName, { type: mimeType });
      // The DataTransfer constructor is supported in WebKit, Blink, and
      // Gecko; this is the standard "set <input type=file> from script"
      // workaround. Direct .files= assignment is sandbox-blocked.
      const dt = new DataTransfer();
      dt.items.add(file);
      target.files = dt.files;
      try { target.focus({ preventScroll: true }); } catch (_e) {}
      target.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
      target.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
      return { name: file.name, size: file.size, type: file.type };
    };

    kit = {
      cursor: {
        moveTo: moveTo,
        click: clickAt,
        highlight: highlight,
        show: showCursor,
        hide: hideCursor,
      },
      dispatchPointerSequence: dispatchPointerSequence,
      typeRealistic: typeRealistic,
      setFileInput: setFileInput,
    };
    window.__elizaTabKit = kit;
    return kit;
  };

  // Defer first-time installation until the document is parseable.
  if (document && document.documentElement) {
    ensureKit();
  } else if (typeof document !== "undefined") {
    document.addEventListener("DOMContentLoaded", () => ensureKit(), { once: true });
  }
  // Also re-install after navigations within the same OOPIF (in case the
  // document was replaced and our cursor root went with it).
  if (typeof window !== "undefined") {
    window.addEventListener("pageshow", () => ensureKit());
  }

  // ── Wallet provider shims ────────────────────────────────────────────
  // Inject EIP-1193 (window.ethereum) and Phantom-shaped (window.solana,
  // window.phantom.solana) wallet adapters that route every call through
  // __electrobunSendToHost to the React host, which forwards to the
  // existing client.sendBrowserWalletTransaction /
  // client.sendBrowserSolanaTransaction / etc. The host calls back into
  // the tab via tag.executeJavascript("window.__elizaWalletReply(...)")
  // to deliver responses.
  //
  // Without this, launchpad pages in our <electrobun-webview> tabs see no
  // wallet provider and refuse to connect.
  if (typeof window !== "undefined" && !window.__elizaWalletInstalled) {
    window.__elizaWalletInstalled = true;

    const walletPending = new Map();
    let nextWalletReq = 1;

    window.__elizaWalletReply = (requestId, payload) => {
      const entry = walletPending.get(requestId);
      if (!entry) return;
      walletPending.delete(requestId);
      if (payload && typeof payload === "object" && payload.error) {
        entry.reject(new Error(String(payload.error)));
      } else {
        entry.resolve(payload && typeof payload === "object" ? payload.result : payload);
      }
    };

    const callHost = (protocol, method, params) =>
      new Promise((resolve, reject) => {
        if (typeof window.__electrobunSendToHost !== "function") {
          reject(new Error("Wallet bridge unavailable: not running in an Eliza tab."));
          return;
        }
        const requestId = nextWalletReq++;
        walletPending.set(requestId, { resolve: resolve, reject: reject });
        // Include the page's origin/hostname so the host can show a
        // "<domain> wants to ..." consent dialog without an extra eval
        // round-trip.
        let originValue;
        let hostnameValue;
        try {
          originValue = location.origin;
          hostnameValue = location.hostname;
        } catch (_e) {
          originValue = "";
          hostnameValue = "";
        }
        window.__electrobunSendToHost({
          type: "__elizaWalletRequest",
          requestId: requestId,
          protocol: protocol,
          method: method,
          params: params,
          origin: originValue,
          hostname: hostnameValue,
        });
      });

    // ── EIP-1193 ──
    const eventListeners = { accountsChanged: new Set(), chainChanged: new Set(), connect: new Set(), disconnect: new Set() };
    const ethereum = {
      isMetaMask: false,
      isEliza: true,
      _events: eventListeners,
      request: (args) => {
        if (!args || typeof args.method !== "string") {
          return Promise.reject(new Error("EIP-1193 request requires {method, params}"));
        }
        return callHost("evm", args.method, args.params);
      },
      enable: function () {
        return this.request({ method: "eth_requestAccounts" });
      },
      send: function (methodOrPayload, paramsOrCallback) {
        // Legacy send shapes — best-effort polyfill.
        if (typeof methodOrPayload === "string") {
          return this.request({ method: methodOrPayload, params: paramsOrCallback });
        }
        if (methodOrPayload && typeof methodOrPayload === "object") {
          return this.request({ method: methodOrPayload.method, params: methodOrPayload.params });
        }
        return Promise.reject(new Error("Unsupported send shape."));
      },
      sendAsync: function (payload, callback) {
        this.request({ method: payload.method, params: payload.params })
          .then((result) => callback(null, { jsonrpc: "2.0", id: payload.id, result: result }))
          .catch((err) => callback(err, null));
      },
      on: (event, listener) => {
        const set = eventListeners[event];
        if (set) set.add(listener);
      },
      removeListener: (event, listener) => {
        const set = eventListeners[event];
        if (set) set.delete(listener);
      },
    };

    window.__elizaWalletEmit = (event, payload) => {
      const set = eventListeners[event];
      if (!set) return;
      for (const listener of Array.from(set)) {
        try { listener(payload); } catch (_e) {}
      }
    };

    try {
      Object.defineProperty(window, "ethereum", {
        value: ethereum,
        writable: true,
        configurable: true,
      });
    } catch (_err) {
      // Some pages freeze window.ethereum after their wallet detected it;
      // fall back to direct assignment when defineProperty is blocked.
      try { window.ethereum = ethereum; } catch (_e) {}
    }

    // ── Solana (Phantom-shaped) ──
    const solanaListeners = { connect: new Set(), disconnect: new Set(), accountChanged: new Set() };
    const makePublicKey = (base58) => {
      if (!base58) return null;
      const obj = {
        toBase58: () => base58,
        toString: () => base58,
        toBytes: () => {
          // Best-effort: many launchpads only need toBase58/toString. If
          // they do call toBytes the result will be wrong, but the lazy
          // approach avoids bundling a base58 decoder into every tab.
          // The host-side signing path receives base58 directly, so
          // round-trip transactions don't depend on this method.
          throw new Error("solana.publicKey.toBytes is not supported by the Eliza tab shim");
        },
        equals: (other) => other && typeof other.toBase58 === "function" && other.toBase58() === base58,
      };
      return obj;
    };
    const solana = {
      isPhantom: true,
      isEliza: true,
      publicKey: null,
      isConnected: false,
      connect: async function (options) {
        const _options = options;
        const result = await callHost("solana", "connect", null);
        if (result && typeof result.publicKey === "string") {
          this.publicKey = makePublicKey(result.publicKey);
          this.isConnected = true;
          for (const listener of Array.from(solanaListeners.connect)) {
            try { listener(this.publicKey); } catch (_e) {}
          }
        }
        return { publicKey: this.publicKey };
      },
      disconnect: async function () {
        this.publicKey = null;
        this.isConnected = false;
        for (const listener of Array.from(solanaListeners.disconnect)) {
          try { listener(); } catch (_e) {}
        }
      },
      signMessage: async function (message, _encoding) {
        const bytes = message instanceof Uint8Array ? message : new TextEncoder().encode(String(message));
        const messageBase64 = btoa(String.fromCharCode.apply(null, Array.from(bytes)));
        const result = await callHost("solana", "signMessage", { messageBase64: messageBase64 });
        if (!result || typeof result.signatureBase64 !== "string") {
          throw new Error("Solana signMessage returned no signature.");
        }
        const sig = atob(result.signatureBase64);
        const arr = new Uint8Array(sig.length);
        for (let i = 0; i < sig.length; i += 1) arr[i] = sig.charCodeAt(i);
        return { signature: arr, publicKey: this.publicKey };
      },
      signTransaction: async function (transaction) {
        const transactionBase64 = await serializeTransactionForHost(transaction);
        const result = await callHost("solana", "signTransaction", { transactionBase64: transactionBase64 });
        if (!result || typeof result.signedTransactionBase64 !== "string") {
          throw new Error("Solana signTransaction returned no signed tx.");
        }
        return deserializeTransactionFromHost(result.signedTransactionBase64, transaction);
      },
      signAndSendTransaction: async function (transaction) {
        const transactionBase64 = await serializeTransactionForHost(transaction);
        const result = await callHost("solana", "signAndSendTransaction", { transactionBase64: transactionBase64 });
        if (!result || typeof result.signature !== "string") {
          throw new Error("Solana signAndSendTransaction returned no signature.");
        }
        return { signature: result.signature };
      },
      signAllTransactions: async function (transactions) {
        const out = [];
        for (const tx of transactions) {
          out.push(await this.signTransaction(tx));
        }
        return out;
      },
      on: (event, listener) => {
        const set = solanaListeners[event];
        if (set) set.add(listener);
      },
      off: (event, listener) => {
        const set = solanaListeners[event];
        if (set) set.delete(listener);
      },
      removeListener: (event, listener) => {
        const set = solanaListeners[event];
        if (set) set.delete(listener);
      },
    };

    // Helper: serialize a Solana Transaction-like object to base64. We
    // accept a few common shapes — the launchpad usually hands us either
    // a VersionedTransaction (has .serialize()) or a legacy Transaction
    // (has .serialize({verifySignatures:false})).
    async function serializeTransactionForHost(transaction) {
      if (!transaction) throw new Error("signTransaction requires a transaction");
      try {
        let bytes;
        if (typeof transaction.serialize === "function") {
          // Legacy Transaction.serialize() throws if signatures aren't
          // present yet; pass {verifySignatures:false}. VersionedTransaction
          // ignores the option so it's safe either way.
          bytes = transaction.serialize({ verifySignatures: false, requireAllSignatures: false });
        } else if (transaction instanceof Uint8Array) {
          bytes = transaction;
        } else {
          throw new Error("Unsupported transaction shape for Eliza wallet bridge");
        }
        let binary = "";
        for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
        return btoa(binary);
      } catch (err) {
        throw err instanceof Error ? err : new Error(String(err));
      }
    }

    // Best-effort: hand the signed bytes back as the same shape the caller
    // gave us. Most callers immediately send the result to a Connection
    // which accepts a serialized buffer — passing a Uint8Array is safe.
    function deserializeTransactionFromHost(base64, _original) {
      const bin = atob(base64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
      return bytes;
    }

    try {
      Object.defineProperty(window, "solana", {
        value: solana,
        writable: true,
        configurable: true,
      });
    } catch (_err) {
      try { window.solana = solana; } catch (_e) {}
    }
    try {
      const phantomNs = window.phantom || {};
      phantomNs.solana = solana;
      window.phantom = phantomNs;
    } catch (_err) {}

    // Announce the provider per EIP-6963 (https://eips.ethereum.org/EIPS/eip-6963).
    // Keys:
    //   uuid — stable per-installation identifier; we use a fixed value
    //     because dApps key wallet selection on it. Changing this would
    //     make every dApp forget the user's previous choice.
    //   rdns — reverse-DNS namespace for the wallet brand.
    //   icon — data URI; the SVG below is a 24x24 monochrome "M" mark in
    //     the brand purple (#6f5cff). Inline so we don't depend on
    //     network availability for wallet-picker rendering.
    const ELIZA_WALLET_ICON =
      "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyNCIgaGVpZ2h0PSIyNCIgdmlld0JveD0iMCAwIDI0IDI0IiBmaWxsPSJub25lIj48cmVjdCB3aWR0aD0iMjQiIGhlaWdodD0iMjQiIHJ4PSI2IiBmaWxsPSIjNmY1Y2ZmIi8+PHRleHQgeD0iNTAlIiB5PSI2OCUiIGZvbnQtZmFtaWx5PSItYXBwbGUtc3lzdGVtLEJsaW5rTWFjU3lzdGVtRm9udCxzYW5zLXNlcmlmIiBmb250LXNpemU9IjE2IiBmb250LXdlaWdodD0iNzAwIiBmaWxsPSIjZmZmIiB0ZXh0LWFuY2hvcj0ibWlkZGxlIj5NPC90ZXh0Pjwvc3ZnPg==";
    const announceEthereum = () => {
      try {
        const detail = Object.freeze({
          info: Object.freeze({
            name: "Eliza",
            uuid: "ai.eliza.wallet:1",
            icon: ELIZA_WALLET_ICON,
            rdns: "ai.eliza.wallet",
          }),
          provider: ethereum,
        });
        window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: detail }));
      } catch (_err) {}
    };
    window.addEventListener("eip6963:requestProvider", announceEthereum);
    setTimeout(announceEthereum, 0);
  }

  // ── Vault autofill shim ─────────────────────────────────────────────
  // Detect login forms on each tab page, ask the host to look up saved
  // credentials for the current domain, and (with user consent) fill the
  // username/password inputs. Mirrors the wallet shim's request/reply
  // pattern: tab→host via __electrobunSendToHost; host→tab via
  // tag.executeJavascript("window.__elizaVaultReply(...)").
  //
  // The host (BrowserWorkspaceView) is responsible for showing a consent
  // prompt before returning credentials. The tab never autofills without
  // a host response carrying explicit field values.
  if (typeof window !== "undefined" && !window.__elizaVaultInstalled) {
    window.__elizaVaultInstalled = true;

    const vaultPending = new Map();
    let nextVaultReq = 1;

    window.__elizaVaultReply = (requestId, payload) => {
      const entry = vaultPending.get(requestId);
      if (!entry) return;
      vaultPending.delete(requestId);
      try {
        if (payload && typeof payload === "object" && payload.error) {
          entry.reject(new Error(String(payload.error)));
          return;
        }
        entry.resolve(payload && typeof payload === "object" ? payload : null);
      } catch (_e) {
        // Listener errors must not bubble up into the tab page.
      }
    };

    function cssSelectorFor(el) {
      if (!el || el.nodeType !== 1) return null;
      if (el.id) {
        // Document.querySelector('#…') only works when the id is a valid
        // selector token. For complex ids fall through to the structural
        // path so we never produce an unparsable selector.
        if (/^[A-Za-z][A-Za-z0-9_-]*$/.test(el.id)) {
          return "#" + el.id;
        }
      }
      const parts = [];
      let node = el;
      let depth = 0;
      while (node && node.nodeType === 1 && depth < 6) {
        let part = node.tagName.toLowerCase();
        const parent = node.parentElement;
        if (parent) {
          const sameTag = Array.from(parent.children).filter(
            (c) => c.tagName === node.tagName,
          );
          if (sameTag.length > 1) {
            const idx = sameTag.indexOf(node) + 1;
            part += ":nth-of-type(" + idx + ")";
          }
        }
        parts.unshift(part);
        if (parent === document.body || !parent) break;
        node = parent;
        depth += 1;
      }
      return parts.join(" > ");
    }

    function findPrecedingTextInput(passwordInput) {
      // Walk previous form-field siblings/ancestors looking for a text
      // or email input that's likely the username.
      const root = passwordInput.form || document.body;
      const candidates = root.querySelectorAll(
        'input[type="text"], input[type="email"], input:not([type])',
      );
      let lastBefore = null;
      for (const el of candidates) {
        if (
          el.compareDocumentPosition(passwordInput) &
          Node.DOCUMENT_POSITION_FOLLOWING
        ) {
          lastBefore = el;
        }
      }
      return lastBefore;
    }

    function setNativeInputValue(input, value) {
      // React (and other VDOM frameworks) overrides the value setter on
      // HTMLInputElement.prototype to track changes. Calling the prototype
      // setter directly bypasses that, then dispatching input + change
      // events re-notifies the framework so controlled inputs see the
      // update.
      const proto = Object.getPrototypeOf(input);
      const desc = Object.getOwnPropertyDescriptor(proto, "value");
      if (desc && typeof desc.set === "function") {
        desc.set.call(input, value);
      } else {
        input.value = value;
      }
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }

    function fillFields(fields) {
      if (!fields || typeof fields !== "object") return;
      for (const selector of Object.keys(fields)) {
        const value = fields[selector];
        if (typeof value !== "string" || value.length === 0) continue;
        let target = null;
        try {
          target = document.querySelector(selector);
        } catch (_e) {
          target = null;
        }
        if (!target) continue;
        setNativeInputValue(target, value);
      }
    }

    const callHost = (domain, url, fieldHints) =>
      new Promise((resolve, reject) => {
        if (typeof window.__electrobunSendToHost !== "function") {
          reject(
            new Error("Vault autofill bridge unavailable: not in an Eliza tab."),
          );
          return;
        }
        const requestId = nextVaultReq++;
        vaultPending.set(requestId, { resolve: resolve, reject: reject });
        window.__electrobunSendToHost({
          type: "__elizaVaultAutofillRequest",
          requestId: requestId,
          domain: domain,
          url: url,
          fieldHints: fieldHints,
        });
      });

    function scanLoginForms() {
      const passwords = document.querySelectorAll(
        'input[type="password"]:not([data-eliza-vault-scanned])',
      );
      for (const pw of passwords) {
        pw.setAttribute("data-eliza-vault-scanned", "1");
        const form = pw.form;
        const userInput =
          (form &&
            form.querySelector(
              'input[type="email"], input[name*="user" i], input[name*="email" i], input[name*="login" i]',
            )) ||
          findPrecedingTextInput(pw);
        const fieldHints = [];
        const pwSelector = cssSelectorFor(pw);
        if (userInput) {
          const userSelector = cssSelectorFor(userInput);
          if (userSelector) {
            fieldHints.push({ kind: "username", selector: userSelector });
          }
        }
        if (pwSelector) {
          fieldHints.push({ kind: "password", selector: pwSelector });
        }
        if (fieldHints.length === 0) continue;
        callHost(location.hostname, location.href, fieldHints)
          .then((payload) => {
            if (payload && payload.fields) fillFields(payload.fields);
          })
          .catch(() => {
            // User denied, no match, or bridge unavailable. Leave fields
            // alone so the user can type credentials manually.
          });
      }
    }

    let scanTimer = null;
    function ensureVaultScan() {
      if (scanTimer) clearTimeout(scanTimer);
      scanTimer = setTimeout(() => {
        scanTimer = null;
        scanLoginForms();
      }, 250);
    }

    if (typeof window !== "undefined") {
      window.addEventListener("pageshow", ensureVaultScan);
    }
    if (typeof MutationObserver === "function" && document.documentElement) {
      const obs = new MutationObserver(ensureVaultScan);
      obs.observe(document.documentElement, {
        childList: true,
        subtree: true,
      });
    }
    if (document && document.readyState !== "loading") {
      ensureVaultScan();
    } else if (typeof document !== "undefined") {
      document.addEventListener("DOMContentLoaded", () => ensureVaultScan(), {
        once: true,
      });
    }
  }
})();
`;
function setBrowserTabsRendererImpl(impl) {
	if (typeof window === "undefined") return;
	if (impl) window[REGISTRY_KEY] = impl;
	else delete window[REGISTRY_KEY];
}

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/components/pages/browser-wallet-consent-format.js
/**
* Wallet consent dialog formatters.
*
* Read-only helpers used by `BrowserWorkspaceView`'s wallet host bridge
* to build the consent modal body. Inputs come straight from the dApp via
* EIP-1193 — these helpers just format for display, never interpret or
* mutate. Pulled out of the React component file so they're unit-testable
* without standing up a renderer.
*/
function formatAddressForDisplay(address) {
	if (!address) return "(unknown)";
	if (address.length <= 12) return address;
	return `${address.slice(0, 6)}…${address.slice(-4)}`;
}
const ONE_ETH_WEI = 1000000000000000000n;
function formatWeiForDisplay(weiDecimalString) {
	if (!weiDecimalString || weiDecimalString === "0") return "0 ETH";
	let wei;
	try {
		wei = BigInt(weiDecimalString);
	} catch {
		return `${weiDecimalString} wei`;
	}
	const whole = wei / ONE_ETH_WEI;
	const remainder = wei % ONE_ETH_WEI;
	if (remainder === 0n) return `${whole.toString()} ETH`;
	const fractionalStr = (remainder * 1000000n / ONE_ETH_WEI).toString().padStart(6, "0").replace(/0+$/, "");
	return `${whole.toString()}.${fractionalStr || "0"} ETH`;
}
/**
* EIP-191 / personal_sign callers pass either a UTF-8 string or a
* 0x-prefixed hex string of the bytes to sign. Show the decoded UTF-8
* when possible so the user sees the actual prompt rather than hex.
*/
function decodeSignableMessage(message) {
	if (!message.startsWith("0x") || message.length < 4) return message;
	const hex = message.slice(2);
	if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) return message;
	const bytes = new Uint8Array(hex.length / 2);
	for (let i = 0; i < bytes.length; i += 1) bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		return message;
	}
}
function decodeBase64ForPreview(base64) {
	try {
		return decodeSignableMessage(`0x${[...atob(base64)].map((c) => c.charCodeAt(0).toString(16).padStart(2, "0")).join("")}`);
	} catch {
		return "(unable to decode message)";
	}
}
function truncateMessageForDisplay(message, max = 240) {
	if (message.length <= max) return message;
	return `${message.slice(0, max)}… (${message.length - max} more chars)`;
}

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/components/pages/browser-workspace-wallet.js
const BROWSER_WALLET_REQUEST_TYPE = "ELIZA_BROWSER_WALLET_REQUEST";
const BROWSER_WALLET_RESPONSE_TYPE = "ELIZA_BROWSER_WALLET_RESPONSE";
const BROWSER_WALLET_READY_TYPE = "ELIZA_BROWSER_WALLET_READY";
const EMPTY_BROWSER_WORKSPACE_WALLET_STATE = {
	address: null,
	connected: false,
	evmAddress: null,
	evmConnected: false,
	mode: "none",
	pendingApprovals: 0,
	reason: null,
	messageSigningAvailable: false,
	transactionSigningAvailable: false,
	chainSwitchingAvailable: false,
	signingAvailable: false,
	solanaAddress: null,
	solanaConnected: false,
	solanaMessageSigningAvailable: false,
	solanaTransactionSigningAvailable: false
};
function getBrowserWorkspaceWalletAddress(walletAddresses, walletConfig, stewardStatus) {
	return stewardStatus?.walletAddresses?.evm ?? stewardStatus?.evmAddress ?? walletAddresses?.evmAddress ?? walletConfig?.evmAddress ?? null;
}
function getBrowserWorkspaceSolanaAddress(walletAddresses, walletConfig, stewardStatus) {
	return stewardStatus?.walletAddresses?.solana ?? walletAddresses?.solanaAddress ?? walletConfig?.solanaAddress ?? null;
}
function resolveBrowserWorkspaceWalletMode(stewardStatus, evmAddress, solanaAddress, walletConfig) {
	if (stewardStatus?.connected) return "steward";
	if (evmAddress && walletConfig?.executionReady || solanaAddress && walletConfig?.solanaSigningAvailable) return "local";
	if (evmAddress || solanaAddress) return "blocked";
	return "none";
}
function buildBrowserWorkspaceWalletState(params) {
	const { pendingApprovals, stewardStatus, walletAddresses, walletConfig } = params;
	const evmAddress = getBrowserWorkspaceWalletAddress(walletAddresses, walletConfig, stewardStatus);
	const solanaAddress = getBrowserWorkspaceSolanaAddress(walletAddresses, walletConfig, stewardStatus);
	const address = evmAddress ?? solanaAddress;
	const mode = resolveBrowserWorkspaceWalletMode(stewardStatus, evmAddress, solanaAddress, walletConfig);
	const evmConnected = Boolean(evmAddress);
	const solanaConnected = Boolean(solanaAddress);
	const solanaMessageSigningAvailable = Boolean(solanaAddress && walletConfig?.solanaSigningAvailable);
	if (mode === "steward") return {
		address,
		connected: evmConnected || solanaConnected,
		evmAddress,
		evmConnected,
		mode,
		pendingApprovals,
		reason: null,
		messageSigningAvailable: false,
		transactionSigningAvailable: true,
		chainSwitchingAvailable: true,
		signingAvailable: true,
		solanaAddress,
		solanaConnected,
		solanaMessageSigningAvailable: false,
		solanaTransactionSigningAvailable: solanaConnected
	};
	if (mode === "local") {
		const solanaTransactionSigningAvailable = Boolean(solanaAddress && walletConfig?.solanaSigningAvailable);
		return {
			address,
			connected: evmConnected || solanaConnected,
			evmAddress,
			evmConnected,
			mode,
			pendingApprovals: 0,
			reason: null,
			messageSigningAvailable: Boolean(evmAddress && walletConfig?.executionReady),
			transactionSigningAvailable: Boolean(evmAddress && walletConfig?.executionReady),
			chainSwitchingAvailable: Boolean(evmAddress && walletConfig?.executionReady),
			signingAvailable: Boolean(evmAddress && walletConfig?.executionReady) || solanaMessageSigningAvailable || solanaTransactionSigningAvailable,
			solanaAddress,
			solanaConnected,
			solanaMessageSigningAvailable,
			solanaTransactionSigningAvailable
		};
	}
	if (mode === "blocked") return {
		address,
		connected: evmConnected || solanaConnected,
		evmAddress,
		evmConnected,
		mode,
		pendingApprovals: 0,
		reason: walletConfig?.executionBlockedReason?.trim() || (solanaConnected && !solanaMessageSigningAvailable ? "Local Solana signing is unavailable." : "Local wallet execution is blocked."),
		messageSigningAvailable: false,
		transactionSigningAvailable: false,
		chainSwitchingAvailable: false,
		signingAvailable: false,
		solanaAddress,
		solanaConnected,
		solanaMessageSigningAvailable: false,
		solanaTransactionSigningAvailable: false
	};
	return {
		...EMPTY_BROWSER_WORKSPACE_WALLET_STATE,
		mode,
		reason: stewardStatus?.configured && !stewardStatus.connected ? stewardStatus.error?.trim() || "Steward is unavailable." : "No wallet configured."
	};
}
function isBrowserWorkspaceWalletRequest(value) {
	if (!value || typeof value !== "object") return false;
	const entry = value;
	return entry.type === BROWSER_WALLET_REQUEST_TYPE && typeof entry.requestId === "string" && typeof entry.method === "string";
}

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/components/pages/useBrowserWorkspaceWalletBridge.js
/**
* Browser workspace wallet bridge — hook + pure helpers.
*
* Iframes embedded by the browser workspace use window.postMessage to ask the
* host for wallet state and to request signing / transactions. This hook owns
* the origin verification, per-tab chain state, request dispatch, and the
* "ready" broadcast when state changes or an iframe loads.
*
* The caller passes in iframe refs, current tabs, and the wallet state it
* maintains; the hook returns a single `postBrowserWalletReady` function used
* for per-iframe onLoad and any other point-in-time broadcasts.
*/
const DEFAULT_CHAIN_ID = 1;
function resolveTargetOrigin(url) {
	try {
		const origin = new URL(url).origin;
		return origin && origin !== "null" ? origin : null;
	} catch {
		return null;
	}
}
/**
* Verify a postMessage origin against the tab's known URL.
*
* With `allow-same-origin` in the iframe sandbox a malicious page could
* present the parent's origin. We mitigate by checking the message origin
* against the URL the user or agent explicitly navigated to; if they don't
* match we refuse to respond.
*/
function resolveBrowserWorkspaceMessageOrigin(origin, tabUrl) {
	if (!origin || origin === "null") return null;
	if (!tabUrl) return origin;
	try {
		const expectedOrigin = new URL(tabUrl).origin;
		if (!expectedOrigin || expectedOrigin === "null") return null;
		return origin === expectedOrigin ? origin : null;
	} catch {
		return null;
	}
}
function formatChainId(chainId) {
	return `0x${chainId.toString(16)}`;
}
function parseChainId(value) {
	if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	if (!trimmed) return null;
	const parsed = trimmed.startsWith("0x") ? Number.parseInt(trimmed.slice(2), 16) : Number(trimmed);
	return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}
function resolveAccounts(state) {
	return state.evmAddress ? [state.evmAddress] : [];
}
function normalizeBrowserWorkspaceTxRequest(params, fallbackChainId) {
	const raw = Array.isArray(params) && params.length > 0 ? params[0] : params;
	if (!raw || typeof raw !== "object") return null;
	const value = raw;
	const chainId = parseChainId(value.chainId) ?? fallbackChainId;
	const to = typeof value.to === "string" ? value.to.trim() : "";
	const amount = typeof value.value === "string" ? value.value.trim() : typeof value.value === "number" ? String(value.value) : "0x0";
	if (!to || !chainId || !Number.isFinite(chainId)) return null;
	return {
		broadcast: value.broadcast !== false,
		chainId,
		data: typeof value.data === "string" ? value.data : void 0,
		description: typeof value.description === "string" ? value.description : void 0,
		to,
		value: amount
	};
}
function resolveMessageToSign(params, address) {
	if (typeof params === "string") return params;
	if (!Array.isArray(params) || params.length === 0) return null;
	const [first, second] = params;
	if (typeof first === "string" && typeof second === "string" && address) {
		if (first.toLowerCase() === address.toLowerCase()) return second;
		if (second.toLowerCase() === address.toLowerCase()) return first;
	}
	return typeof first === "string" ? first : null;
}
async function dispatch(request, ctx) {
	const { walletState } = ctx;
	switch (request.method) {
		case "getState": return {
			ok: true,
			result: walletState
		};
		case "requestAccounts": return {
			ok: true,
			result: { accounts: resolveAccounts(walletState) }
		};
		case "eth_accounts":
		case "eth_requestAccounts": return {
			ok: true,
			result: resolveAccounts(walletState)
		};
		case "eth_chainId": return {
			ok: true,
			result: formatChainId(ctx.tabChainId)
		};
		case "solana_connect":
			if (!walletState.solanaConnected || !walletState.solanaAddress) return {
				ok: false,
				error: "Solana wallet is unavailable."
			};
			return {
				ok: true,
				result: { address: walletState.solanaAddress }
			};
		case "solana_signMessage": return handleSolanaSignMessage(request.params, walletState);
		case "solana_signTransaction": return handleSolanaSendTransaction(request.params, walletState, false);
		case "solana_signAndSendTransaction": return handleSolanaSendTransaction(request.params, walletState, true);
		case "wallet_switchEthereumChain": return handleSwitchChain(request.params, ctx);
		case "personal_sign":
		case "eth_sign": return handleEthSign(request.params, walletState);
		case "sendTransaction":
		case "eth_sendTransaction": return handleSendTransaction(request, ctx);
		default: return {
			ok: false,
			error: "Unsupported browser wallet request."
		};
	}
}
async function handleSolanaSendTransaction(params, walletState, broadcast) {
	if (!walletState.solanaTransactionSigningAvailable) return {
		ok: false,
		error: walletState.reason || "Solana browser wallet transaction signing is unavailable."
	};
	const p = params && typeof params === "object" ? params : null;
	const transactionBase64 = typeof p?.transactionBase64 === "string" ? p.transactionBase64 : null;
	if (!transactionBase64) return {
		ok: false,
		error: "Solana browser wallet transaction signing requires transactionBase64."
	};
	const cluster = p?.cluster === "devnet" || p?.cluster === "testnet" || p?.cluster === "mainnet" ? p.cluster : void 0;
	const description = typeof p?.description === "string" ? p.description : void 0;
	try {
		return {
			ok: true,
			result: await client.sendBrowserSolanaTransaction({
				transactionBase64,
				broadcast,
				...cluster ? { cluster } : {},
				...description ? { description } : {}
			})
		};
	} catch (error) {
		return {
			ok: false,
			error: errorMessage(error)
		};
	}
}
async function handleSolanaSignMessage(params, walletState) {
	if (!walletState.solanaMessageSigningAvailable) return {
		ok: false,
		error: walletState.reason || "Solana browser wallet signing is unavailable."
	};
	const p = params && typeof params === "object" ? params : null;
	const message = typeof p?.message === "string" ? p.message : void 0;
	const messageBase64 = typeof p?.messageBase64 === "string" ? p.messageBase64 : void 0;
	if (!message && !messageBase64) return {
		ok: false,
		error: "Solana browser wallet signing requires message or messageBase64."
	};
	try {
		return {
			ok: true,
			result: await client.signBrowserSolanaMessage({
				...message ? { message } : {},
				...messageBase64 ? { messageBase64 } : {}
			})
		};
	} catch (error) {
		return {
			ok: false,
			error: errorMessage(error)
		};
	}
}
function handleSwitchChain(params, ctx) {
	if (!ctx.walletState.chainSwitchingAvailable) return {
		ok: false,
		error: ctx.walletState.reason || "Browser wallet chain switching is unavailable."
	};
	const nextChainId = parseChainId(Array.isArray(params) ? params[0]?.chainId : params?.chainId);
	if (!nextChainId) return {
		ok: false,
		error: "wallet_switchEthereumChain requires a valid chainId."
	};
	ctx.setTabChainId(nextChainId);
	ctx.postWalletReady(ctx.sourceTab, ctx.walletStateRef.current);
	return {
		ok: true,
		result: null
	};
}
async function handleEthSign(params, walletState) {
	if (!walletState.messageSigningAvailable) return {
		ok: false,
		error: walletState.mode === "steward" ? "Browser message signing requires a local wallet key." : walletState.reason || "Browser wallet message signing is unavailable."
	};
	const message = resolveMessageToSign(params, walletState.address);
	if (!message) return {
		ok: false,
		error: "Browser wallet signing requires a message payload."
	};
	try {
		return {
			ok: true,
			result: (await client.signBrowserWalletMessage(message)).signature
		};
	} catch (error) {
		return {
			ok: false,
			error: errorMessage(error)
		};
	}
}
async function handleSendTransaction(request, ctx) {
	if (!ctx.walletState.transactionSigningAvailable) return {
		ok: false,
		error: ctx.walletState.reason || "Browser wallet transaction signing is unavailable."
	};
	const transaction = normalizeBrowserWorkspaceTxRequest(request.params, ctx.tabChainId);
	if (!transaction) return {
		ok: false,
		error: "Browser wallet sendTransaction requires to, value, and chainId."
	};
	try {
		const result = await client.sendBrowserWalletTransaction(transaction);
		const nextState = await ctx.loadWalletState();
		ctx.postWalletReady(ctx.sourceTab, nextState);
		return {
			ok: true,
			result: request.method === "eth_sendTransaction" ? result.txHash ?? result.txId ?? null : result
		};
	} catch (error) {
		return {
			ok: false,
			error: errorMessage(error)
		};
	}
}
function errorMessage(error) {
	return error instanceof Error ? error.message : String(error);
}
function useBrowserWorkspaceWalletBridge({ iframeRefs, workspaceTabs, walletState, loadWalletState }) {
	const walletStateRef = useRef(walletState);
	const workspaceTabsRef = useRef(workspaceTabs);
	const chainIdByTabRef = useRef(/* @__PURE__ */ new Map());
	walletStateRef.current = walletState;
	workspaceTabsRef.current = workspaceTabs;
	const postBrowserWalletReady = useCallback((tab, state) => {
		const iframeWindow = iframeRefs.current?.get(tab.id)?.contentWindow;
		const targetOrigin = resolveTargetOrigin(tab.url);
		if (!iframeWindow || !targetOrigin) return;
		iframeWindow.postMessage({
			type: BROWSER_WALLET_READY_TYPE,
			state
		}, targetOrigin);
	}, [iframeRefs]);
	useEffect(() => {
		for (const tab of workspaceTabs) postBrowserWalletReady(tab, walletState);
	}, [
		walletState,
		postBrowserWalletReady,
		workspaceTabs
	]);
	useEffect(() => {
		const knownTabIds = new Set(workspaceTabs.map((tab) => tab.id));
		for (const tabId of chainIdByTabRef.current.keys()) if (!knownTabIds.has(tabId)) chainIdByTabRef.current.delete(tabId);
	}, [workspaceTabs]);
	useEffect(() => {
		const onMessage = (event) => {
			if (!isBrowserWorkspaceWalletRequest(event.data)) return;
			const request = event.data;
			const sourceTab = workspaceTabsRef.current.find((tab) => iframeRefs.current?.get(tab.id)?.contentWindow === event.source);
			const sourceWindow = sourceTab ? iframeRefs.current?.get(sourceTab.id)?.contentWindow : null;
			if (!sourceTab || !sourceWindow) return;
			const targetOrigin = resolveBrowserWorkspaceMessageOrigin(event.origin, sourceTab.url);
			if (targetOrigin === null) return;
			const respond = (response) => {
				sourceWindow.postMessage(response, targetOrigin);
			};
			(async () => {
				const result = await dispatch(request, {
					sourceTab,
					walletState: walletStateRef.current,
					tabChainId: chainIdByTabRef.current.get(sourceTab.id) ?? DEFAULT_CHAIN_ID,
					setTabChainId: (chainId) => chainIdByTabRef.current.set(sourceTab.id, chainId),
					loadWalletState,
					postWalletReady: postBrowserWalletReady,
					walletStateRef
				});
				respond({
					type: BROWSER_WALLET_RESPONSE_TYPE,
					requestId: request.requestId,
					...result
				});
			})();
		};
		window.addEventListener("message", onMessage);
		return () => window.removeEventListener("message", onMessage);
	}, [
		iframeRefs,
		loadWalletState,
		postBrowserWalletReady
	]);
	return { postBrowserWalletReady };
}

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/components/pages/BrowserWorkspaceView.js
var BrowserWorkspaceView_exports = /* @__PURE__ */ __exportAll({ BrowserWorkspaceView: () => BrowserWorkspaceView });
const POLL_INTERVAL_MS = 2500;
const BROWSER_BRIDGE_POLL_INTERVAL_MS = 4e3;
const BROWSER_WORKSPACE_AGENT_PARTITION = "persist:eliza-browser-agent";
const BROWSER_WORKSPACE_APP_PARTITION = "persist:eliza-browser-app";
const BROWSER_WORKSPACE_DEFAULT_HOME_URL = "https://docs.elizaos.ai/";
const BROWSER_WORKSPACE_COLLAPSED_SECTIONS_STORAGE_KEY = "eliza:browser-workspace:collapsed-sections";
function readStoredBrowserWorkspaceCollapsedSections() {
	if (typeof window === "undefined") return /* @__PURE__ */ new Set();
	try {
		const raw = window.localStorage.getItem(BROWSER_WORKSPACE_COLLAPSED_SECTIONS_STORAGE_KEY);
		if (!raw) return /* @__PURE__ */ new Set();
		const parsed = JSON.parse(raw);
		if (!Array.isArray(parsed)) return /* @__PURE__ */ new Set();
		return new Set(parsed.filter((value) => value === "agent" || value === "app" || value === "user"));
	} catch {
		return /* @__PURE__ */ new Set();
	}
}
function persistBrowserWorkspaceCollapsedSections(sections) {
	if (typeof window === "undefined") return;
	try {
		window.localStorage.setItem(BROWSER_WORKSPACE_COLLAPSED_SECTIONS_STORAGE_KEY, JSON.stringify([...sections]));
	} catch {}
}
function resolveBrowserWorkspaceTabSectionKey(tab) {
	const partition = tab.partition.trim().toLowerCase();
	if (partition === BROWSER_WORKSPACE_AGENT_PARTITION) return "agent";
	if (partition === BROWSER_WORKSPACE_APP_PARTITION) return "app";
	return "user";
}
function resolveBrowserWorkspaceTabPartition(sectionKey) {
	switch (sectionKey) {
		case "agent": return BROWSER_WORKSPACE_AGENT_PARTITION;
		case "app": return BROWSER_WORKSPACE_APP_PARTITION;
		case "user": return;
	}
}
function isBrowserBridgePlugin(plugin) {
	return [
		plugin.id,
		plugin.name,
		plugin.npmName
	].filter((value) => typeof value === "string").map((value) => value.trim().toLowerCase()).some((value) => value === "browser-bridge" || value === "plugin-browser-bridge" || value === "@elizaos/plugin-browser-bridge");
}
function isBrowserWorkspaceSessionMode(mode) {
	return mode === "cloud";
}
function normalizeBrowserWorkspaceInputUrl(rawUrl, t) {
	const trimmed = rawUrl.trim();
	if (!trimmed) return null;
	if (trimmed === "about:blank") return trimmed;
	const candidate = /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(trimmed) ? trimmed : `https://${trimmed}`;
	let parsed;
	try {
		parsed = new URL(candidate);
	} catch {
		throw new Error(t("browserworkspace.InvalidUrl", { defaultValue: "Enter a valid http or https URL." }));
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error(t("browserworkspace.UnsupportedProtocol", { defaultValue: "Only http and https URLs are supported." }));
	return parsed.toString();
}
function readBrowserWorkspaceQueryParam(name) {
	if (typeof window === "undefined") return null;
	const rawSearch = window.location.search || window.location.hash.split("?")[1] || "";
	const value = new URLSearchParams(rawSearch.startsWith("?") ? rawSearch.slice(1) : rawSearch).get(name)?.trim();
	return value ? value : null;
}
function inferBrowserWorkspaceTitle(url, t) {
	if (url === "about:blank") return t("browserworkspace.NewTab", { defaultValue: "New tab" });
	try {
		return new URL(url).hostname.replace(/^www\./, "") || t("nav.browser", { defaultValue: "Browser" });
	} catch {
		return t("nav.browser", { defaultValue: "Browser" });
	}
}
function getBrowserWorkspaceTabKind(tab) {
	return tab.kind === "internal" ? "internal" : "standard";
}
function isInternalBrowserWorkspaceTab(tab) {
	return getBrowserWorkspaceTabKind(tab) === "internal";
}
function isBrowserWorkspaceFrameBlockedUrl(url) {
	try {
		const parsed = new URL(url);
		return /(^|\.)discord\.com$/i.test(parsed.hostname);
	} catch {
		return false;
	}
}
function getBrowserWorkspaceTabLabel(tab, t) {
	const trimmedTitle = tab.title.trim();
	if (trimmedTitle && trimmedTitle !== "Browser") return trimmedTitle;
	return inferBrowserWorkspaceTitle(tab.url, t);
}
function getBrowserWorkspaceTabMonogram(label) {
	return (label.trim().replace(/[^a-z0-9]/gi, "")[0] ?? "B").toUpperCase();
}
function getBrowserWorkspaceTabDescription(tab, mode) {
	const details = [];
	if (isInternalBrowserWorkspaceTab(tab)) details.push("Internal");
	if (mode !== "web") {
		if (tab.provider?.trim()) details.push(tab.provider.trim());
		if (tab.status?.trim()) details.push(tab.status.trim());
	}
	details.push(tab.url);
	return details.join(" · ");
}
function resolveBrowserWorkspaceSelection(tabs, selectedId) {
	if (selectedId && tabs.some((tab) => tab.id === selectedId)) return selectedId;
	return tabs.find((tab) => tab.visible)?.id ?? tabs[0]?.id ?? null;
}
function BrowserWorkspaceView() {
	const { getStewardPending, getStewardStatus, setActionNotice, t, plugins, uiTheme, walletAddresses, walletConfig } = useApp();
	const [workspace, setWorkspace] = useState({
		mode: "web",
		tabs: []
	});
	const [browserWalletState, setBrowserWalletState] = useState(() => buildBrowserWorkspaceWalletState({
		pendingApprovals: 0,
		stewardStatus: null,
		walletAddresses,
		walletConfig
	}));
	const [selectedTabId, setSelectedTabId] = useState(null);
	const [locationInput, setLocationInput] = useState("");
	const [locationDirty, setLocationDirty] = useState(false);
	const [loading, setLoading] = useState(true);
	const [loadError, setLoadError] = useState(null);
	const [snapshotError, setSnapshotError] = useState(null);
	const [tabSnapshots, setTabSnapshots] = useState({});
	const [busyAction, setBusyAction] = useState(null);
	const [collapsedSections, setCollapsedSections] = useState(() => readStoredBrowserWorkspaceCollapsedSections());
	const [browserBridgeAvailable, setBrowserBridgeAvailable] = useState(false);
	const [browserBridgeLoading, setBrowserBridgeLoading] = useState(true);
	const [browserBridgeCompanions, setBrowserBridgeCompanions] = useState([]);
	const [browserBridgePackageStatus, setBrowserBridgePackageStatus] = useState(null);
	const initialBrowseUrlRef = useRef(void 0);
	const initialBrowseHandledRef = useRef(false);
	const iframeRefs = useRef(/* @__PURE__ */ new Map());
	const electrobunWebviewRefs = useRef(/* @__PURE__ */ new Map());
	const pendingTabExecsRef = useRef(/* @__PURE__ */ new Map());
	const tabExecCounterRef = useRef(0);
	const tabChainIdRef = useRef(/* @__PURE__ */ new Map());
	const browserWalletStateRef = useRef(null);
	const walletConnectAllowedDomainsRef = useRef(/* @__PURE__ */ new Set());
	const selectedTabIdRef = useRef(null);
	const getStewardPendingRef = useRef(getStewardPending);
	const getStewardStatusRef = useRef(getStewardStatus);
	const setActionNoticeRef = useRef(setActionNotice);
	const tRef = useRef(t);
	const walletAddressesRef = useRef(walletAddresses);
	const walletConfigRef = useRef(walletConfig);
	const previousSelectedTabIdRef = useRef(null);
	if (typeof initialBrowseUrlRef.current === "undefined") {
		const browseParam = readBrowserWorkspaceQueryParam("browse");
		try {
			initialBrowseUrlRef.current = browseParam ? normalizeBrowserWorkspaceInputUrl(browseParam, t) : null;
		} catch {
			initialBrowseUrlRef.current = null;
		}
	}
	const selectedTab = useMemo(() => workspace.tabs.find((tab) => tab.id === selectedTabId) ?? null, [selectedTabId, workspace.tabs]);
	const selectedTabSnapshot = selectedTabId ? tabSnapshots[selectedTabId] ?? null : null;
	const selectedTabLiveViewUrl = selectedTab?.interactiveLiveViewUrl ?? selectedTab?.liveViewUrl ?? null;
	const selectedTabIsInternal = selectedTab ? isInternalBrowserWorkspaceTab(selectedTab) : false;
	const newBrowserWorkspaceTabSeedUrl = selectedTabIsInternal ? "about:blank" : locationInput || BROWSER_WORKSPACE_DEFAULT_HOME_URL;
	const groupedTabs = useMemo(() => workspace.tabs.reduce((groups, tab) => {
		groups[resolveBrowserWorkspaceTabSectionKey(tab)].push(tab);
		return groups;
	}, {
		user: [],
		agent: [],
		app: []
	}), [workspace.tabs]);
	const collapsedRailTabs = useMemo(() => [
		...groupedTabs.user,
		...groupedTabs.agent,
		...groupedTabs.app
	], [groupedTabs]);
	const primaryBrowserBridgeCompanion = useMemo(() => browserBridgeCompanions.find((companion) => companion.connectionState === "connected") ?? browserBridgeCompanions[0] ?? null, [browserBridgeCompanions]);
	const browserBridgeConnected = primaryBrowserBridgeCompanion?.connectionState === "connected";
	const toggleSidebarSectionCollapsed = useCallback((key) => {
		setCollapsedSections((current) => {
			if (key !== "agent" && key !== "app" && key !== "user") return current;
			const next = new Set(current);
			if (next.has(key)) next.delete(key);
			else next.add(key);
			return next;
		});
	}, []);
	const browserBridgeSupported = useMemo(() => plugins.some((plugin) => isBrowserBridgePlugin(plugin)), [plugins]);
	useEffect(() => {
		getStewardPendingRef.current = getStewardPending;
		getStewardStatusRef.current = getStewardStatus;
		setActionNoticeRef.current = setActionNotice;
		tRef.current = t;
		walletAddressesRef.current = walletAddresses;
		walletConfigRef.current = walletConfig;
	}, [
		getStewardPending,
		getStewardStatus,
		setActionNotice,
		t,
		walletAddresses,
		walletConfig
	]);
	const loadBrowserWalletState = useCallback(async () => {
		try {
			const stewardStatus = await getStewardStatusRef.current().catch(() => null);
			const resolvedWalletConfig = walletConfigRef.current ?? await client.getWalletConfig().catch(() => null);
			const nextState = buildBrowserWorkspaceWalletState({
				pendingApprovals: stewardStatus?.connected === true ? (await getStewardPendingRef.current().catch(() => [])).length : 0,
				stewardStatus,
				walletAddresses: walletAddressesRef.current,
				walletConfig: resolvedWalletConfig
			});
			setBrowserWalletState(nextState);
			return nextState;
		} catch (error) {
			const nextState = buildBrowserWorkspaceWalletState({
				pendingApprovals: 0,
				stewardStatus: {
					available: false,
					configured: false,
					connected: false,
					error: error instanceof Error ? error.message : String(error)
				},
				walletAddresses: walletAddressesRef.current,
				walletConfig: walletConfigRef.current
			});
			setBrowserWalletState(nextState);
			return nextState;
		}
	}, []);
	const loadBrowserBridgeState = useCallback(async (options) => {
		if (!options?.silent) setBrowserBridgeLoading(true);
		const [companionsResult, packageResult] = await Promise.allSettled([client.fetch("/api/browser-bridge/companions"), client.fetch("/api/browser-bridge/packages")]);
		if (companionsResult.status === "fulfilled") setBrowserBridgeCompanions(companionsResult.value.companions);
		else setBrowserBridgeCompanions([]);
		if (packageResult.status === "fulfilled") setBrowserBridgePackageStatus(packageResult.value.status);
		else setBrowserBridgePackageStatus(null);
		setBrowserBridgeAvailable(companionsResult.status === "fulfilled" || packageResult.status === "fulfilled");
		if (!options?.silent) setBrowserBridgeLoading(false);
	}, []);
	const loadWorkspace = useCallback(async (options) => {
		if (!options?.silent) setLoading(true);
		try {
			const snapshot = await client.getBrowserWorkspace();
			setWorkspace(snapshot);
			setLoadError(null);
			setSelectedTabId((current) => resolveBrowserWorkspaceSelection(snapshot.tabs, options?.preferTabId ?? current));
		} catch (error) {
			setLoadError(error instanceof Error ? error.message : tRef.current("browserworkspace.LoadFailed", { defaultValue: "Failed to load browser workspace." }));
		} finally {
			if (!options?.silent) setLoading(false);
		}
	}, []);
	const runBrowserWorkspaceAction = useCallback(async (actionKey, action, onErrorMessage) => {
		setBusyAction(actionKey);
		try {
			await action();
		} catch (error) {
			const message = error instanceof Error ? error.message : onErrorMessage ?? tRef.current("browserworkspace.ActionFailed", { defaultValue: "Browser action failed." });
			setActionNoticeRef.current(message, "error", 4e3);
		} finally {
			setBusyAction(null);
		}
	}, []);
	const loadSelectedBrowserWorkspaceSnapshot = useCallback(async (tabId, mode) => {
		if (!isBrowserWorkspaceSessionMode(mode)) {
			setSnapshotError(null);
			return;
		}
		try {
			const snapshot = await client.snapshotBrowserWorkspaceTab(tabId);
			setTabSnapshots((current) => {
				if (current[tabId] === snapshot.data) return current;
				return {
					...current,
					[tabId]: snapshot.data
				};
			});
			setSnapshotError(null);
		} catch (error) {
			setSnapshotError(error instanceof Error ? error.message : tRef.current("browserworkspace.SnapshotFailed", { defaultValue: "Failed to load browser session preview." }));
		}
	}, []);
	const openNewBrowserWorkspaceTab = useCallback(async (rawUrl, sectionKey = "user") => {
		const url = normalizeBrowserWorkspaceInputUrl(rawUrl, t);
		if (!url) throw new Error(t("browserworkspace.EnterUrlToOpen", { defaultValue: "Enter a URL to open." }));
		const request = {
			url,
			title: inferBrowserWorkspaceTitle(url, t),
			partition: resolveBrowserWorkspaceTabPartition(sectionKey),
			show: true
		};
		const { tab } = await client.openBrowserWorkspaceTab(request);
		await loadWorkspace({
			preferTabId: tab.id,
			silent: true
		});
		setSelectedTabId(tab.id);
		setLocationInput(tab.url);
		setLocationDirty(false);
	}, [loadWorkspace, t]);
	const activateBrowserWorkspaceTab = useCallback(async (tabId) => {
		setSelectedTabId(tabId);
		const { tab } = await client.showBrowserWorkspaceTab(tabId);
		await loadWorkspace({
			preferTabId: tab.id,
			silent: true
		});
	}, [loadWorkspace]);
	const navigateSelectedBrowserWorkspaceTab = useCallback(async (rawUrl) => {
		if (selectedTab && isInternalBrowserWorkspaceTab(selectedTab)) throw new Error(t("browserworkspace.InternalTabUrlManaged", { defaultValue: "This internal tab manages its own URL." }));
		const url = normalizeBrowserWorkspaceInputUrl(rawUrl, t);
		if (!url) throw new Error(t("browserworkspace.EnterUrlToNavigate", { defaultValue: "Enter a URL to navigate." }));
		if (!selectedTabId) {
			await openNewBrowserWorkspaceTab(url);
			return;
		}
		const { tab } = await client.navigateBrowserWorkspaceTab(selectedTabId, url);
		if (workspace.mode === "web") {
			const iframe = iframeRefs.current.get(selectedTabId);
			if (iframe && iframe.src !== tab.url) iframe.src = tab.url;
		} else if (workspace.mode === "desktop") electrobunWebviewRefs.current.get(selectedTabId)?.loadURL(tab.url);
		await loadWorkspace({
			preferTabId: tab.id,
			silent: true
		});
		setLocationInput(tab.url);
		setLocationDirty(false);
	}, [
		loadWorkspace,
		openNewBrowserWorkspaceTab,
		selectedTab,
		selectedTabId,
		t,
		workspace.mode
	]);
	const registerBrowserWorkspaceIframe = useCallback((tabId, iframe) => {
		if (!iframe) {
			iframeRefs.current.delete(tabId);
			return;
		}
		iframeRefs.current.set(tabId, iframe);
	}, []);
	browserWalletStateRef.current = browserWalletState;
	selectedTabIdRef.current = selectedTabId;
	const { confirm: walletActionConfirm, modalProps: walletActionModalProps } = useConfirm();
	const handleTabWalletRequest = useCallback(async (req) => {
		const tag = electrobunWebviewRefs.current.get(req.tabId);
		const reply = (payload) => {
			if (!tag) return;
			tag.executeJavascript(`window.__elizaWalletReply(${JSON.stringify(req.requestId)}, ${JSON.stringify(payload)})`);
		};
		const walletState = browserWalletStateRef.current;
		if (!walletState) {
			reply({ error: "Wallet state not yet loaded." });
			return;
		}
		const domain = (req.hostname || "this site").trim();
		try {
			const evmAddress = walletState.evmAddress;
			const solanaAddress = walletState.solanaAddress;
			if (req.protocol === "evm") switch (req.method) {
				case "eth_requestAccounts":
					if (!evmAddress) {
						reply({ error: walletState.reason ?? "No EVM wallet connected." });
						return;
					}
					if (!(walletConnectAllowedDomainsRef.current.has(domain) || await walletActionConfirm({
						title: `Connect Eliza wallet to ${domain}`,
						message: `${domain} is requesting your wallet address. Allow it to read ${formatAddressForDisplay(evmAddress)}?`,
						confirmLabel: "Connect",
						cancelLabel: "Reject"
					}))) {
						reply({ error: "User rejected wallet connection." });
						return;
					}
					walletConnectAllowedDomainsRef.current.add(domain);
					reply({ result: [evmAddress] });
					return;
				case "eth_accounts":
					if (!evmAddress) {
						reply({ result: [] });
						return;
					}
					if (!walletConnectAllowedDomainsRef.current.has(domain)) {
						reply({ result: [] });
						return;
					}
					reply({ result: [evmAddress] });
					return;
				case "eth_chainId":
					reply({ result: `0x${(tabChainIdRef.current.get(req.tabId) ?? 1).toString(16)}` });
					return;
				case "wallet_switchEthereumChain": {
					const arr = Array.isArray(req.params) ? req.params : [req.params];
					const next = arr[0] && typeof arr[0] === "object" ? arr[0].chainId : null;
					const chainHex = typeof next === "string" ? next : "";
					const chainId = chainHex.startsWith("0x") ? Number.parseInt(chainHex.slice(2), 16) : Number(chainHex);
					if (!Number.isFinite(chainId) || chainId <= 0) {
						reply({ error: "wallet_switchEthereumChain requires a valid chainId." });
						return;
					}
					tabChainIdRef.current.set(req.tabId, chainId);
					reply({ result: null });
					return;
				}
				case "personal_sign":
				case "eth_sign": {
					if (!walletState.messageSigningAvailable) {
						reply({ error: walletState.mode === "steward" ? "Browser message signing requires a local wallet key." : walletState.reason ?? "Browser wallet message signing is unavailable." });
						return;
					}
					const arr = Array.isArray(req.params) ? req.params : [];
					const message = typeof arr[0] === "string" ? arr[0] : typeof arr[1] === "string" ? arr[1] : null;
					if (!message) {
						reply({ error: "Browser wallet signing requires a message payload." });
						return;
					}
					if (!await walletActionConfirm({
						title: `${domain} wants to sign a message`,
						message: `Message preview:\n\n${truncateMessageForDisplay(decodeSignableMessage(message))}\n\nAllow signing?`,
						confirmLabel: "Sign",
						cancelLabel: "Reject"
					})) {
						reply({ error: "User rejected message signing." });
						return;
					}
					reply({ result: (await client.signBrowserWalletMessage(message)).signature });
					return;
				}
				case "eth_sendTransaction": {
					if (!walletState.transactionSigningAvailable) {
						reply({ error: walletState.reason ?? "Browser wallet transaction signing is unavailable." });
						return;
					}
					const arr = Array.isArray(req.params) ? req.params : [req.params];
					const tx = arr[0] && typeof arr[0] === "object" ? arr[0] : null;
					if (!tx) {
						reply({ error: "eth_sendTransaction requires a transaction object." });
						return;
					}
					const chainId = tabChainIdRef.current.get(req.tabId) ?? 1;
					const value = typeof tx.value === "string" ? tx.value.startsWith("0x") ? BigInt(tx.value).toString() : tx.value : "0";
					const to = typeof tx.to === "string" ? tx.to : "";
					if (!await walletActionConfirm({
						title: `${domain} wants to send a transaction`,
						message: `From: ${formatAddressForDisplay(evmAddress ?? "")}\nTo: ${formatAddressForDisplay(to)}\nValue: ${formatWeiForDisplay(value)}\nChain: ${chainId}\n\nAllow this transaction?`,
						confirmLabel: "Send",
						cancelLabel: "Reject"
					})) {
						reply({ error: "User rejected transaction." });
						return;
					}
					const result = await client.sendBrowserWalletTransaction({
						broadcast: true,
						chainId,
						to,
						value,
						data: typeof tx.data === "string" ? tx.data : void 0,
						description: typeof tx.description === "string" ? tx.description : void 0
					});
					reply({ result: result.txHash ?? result.txId ?? null });
					browserWalletStateRef.current = await loadBrowserWalletState();
					return;
				}
				default:
					reply({ error: `Unsupported EVM method: ${req.method}` });
					return;
			}
			if (req.protocol === "solana") switch (req.method) {
				case "connect":
					if (!solanaAddress) {
						reply({ error: walletState.reason ?? "No Solana wallet connected." });
						return;
					}
					if (!(walletConnectAllowedDomainsRef.current.has(domain) || await walletActionConfirm({
						title: `Connect Eliza Solana wallet to ${domain}`,
						message: `${domain} is requesting your Solana address. Allow it to read ${formatAddressForDisplay(solanaAddress)}?`,
						confirmLabel: "Connect",
						cancelLabel: "Reject"
					}))) {
						reply({ error: "User rejected wallet connection." });
						return;
					}
					walletConnectAllowedDomainsRef.current.add(domain);
					reply({ result: { publicKey: solanaAddress } });
					return;
				case "signMessage": {
					if (!walletState.solanaMessageSigningAvailable) {
						reply({ error: walletState.reason ?? "Solana message signing is unavailable." });
						return;
					}
					const messageBase64 = req.params && typeof req.params === "object" ? req.params.messageBase64 : void 0;
					const message = req.params && typeof req.params === "object" ? req.params.message : void 0;
					const previewSource = message ?? (messageBase64 ? decodeBase64ForPreview(messageBase64) : "(no message preview available)");
					if (!await walletActionConfirm({
						title: `${domain} wants to sign a Solana message`,
						message: `Message preview:\n\n${truncateMessageForDisplay(previewSource)}\n\nAllow signing?`,
						confirmLabel: "Sign",
						cancelLabel: "Reject"
					})) {
						reply({ error: "User rejected message signing." });
						return;
					}
					reply({ result: await client.signBrowserSolanaMessage({
						...messageBase64 ? { messageBase64 } : {},
						...message ? { message } : {}
					}) });
					return;
				}
				case "signTransaction":
				case "signAndSendTransaction": {
					if (!walletState.solanaTransactionSigningAvailable) {
						reply({ error: walletState.reason ?? "Solana transaction signing is unavailable." });
						return;
					}
					const transactionBase64 = req.params && typeof req.params === "object" ? req.params.transactionBase64 : void 0;
					if (!transactionBase64) {
						reply({ error: "Solana transaction signing requires transactionBase64." });
						return;
					}
					const willBroadcast = req.method === "signAndSendTransaction";
					if (!await walletActionConfirm({
						title: `${domain} wants to ${willBroadcast ? "send" : "sign"} a Solana transaction`,
						message: `From: ${formatAddressForDisplay(solanaAddress ?? "")}\n${willBroadcast ? "Will broadcast on submit." : "Returns the signed bytes to the dApp; the dApp may broadcast."}\n\nAllow?`,
						confirmLabel: willBroadcast ? "Send" : "Sign",
						cancelLabel: "Reject"
					})) {
						reply({ error: "User rejected transaction." });
						return;
					}
					reply({ result: await client.sendBrowserSolanaTransaction({
						transactionBase64,
						broadcast: willBroadcast
					}) });
					return;
				}
				default:
					reply({ error: `Unsupported Solana method: ${req.method}` });
					return;
			}
			reply({ error: `Unsupported wallet protocol: ${req.protocol}` });
		} catch (error) {
			reply({ error: error instanceof Error ? error.message : String(error) });
		}
	}, [loadBrowserWalletState, walletActionConfirm]);
	const { confirm: vaultAutofillConfirm, modalProps: vaultAutofillModalProps } = useConfirm();
	const handleTabVaultAutofillRequest = useCallback(async (req) => {
		const tag = electrobunWebviewRefs.current.get(req.tabId);
		const reply = (payload) => {
			if (!tag) return;
			tag.executeJavascript(`window.__elizaVaultReply(${JSON.stringify(req.requestId)}, ${JSON.stringify(payload)})`);
		};
		const userHint = req.fieldHints.find((h) => h.kind === "username");
		const passwordHint = req.fieldHints.find((h) => h.kind === "password");
		if (!passwordHint) {
			reply({ fields: {} });
			return;
		}
		try {
			const { logins } = await client.listSavedLogins(req.domain);
			const requestDomain = req.domain.toLowerCase();
			const candidates = logins.filter((l) => typeof l.domain === "string" && l.domain.toLowerCase() === requestDomain);
			if (candidates.length === 0) {
				reply({ fields: {} });
				return;
			}
			const chosen = [...candidates].sort((a, b) => b.updatedAt - a.updatedAt)[0];
			if (!chosen) {
				reply({ fields: {} });
				return;
			}
			const sourceLabel = chosen.source === "1password" ? "1Password" : chosen.source === "bitwarden" ? "Bitwarden" : "local vault";
			if (!(await client.getAutofillAllowed(req.domain) || await vaultAutofillConfirm({
				title: `Autofill ${req.domain}`,
				message: `Sign in as ${chosen.username || chosen.title} from ${sourceLabel}?\n\nEliza will fill the saved username and password for this site.`,
				confirmLabel: "Allow",
				cancelLabel: "Deny"
			}))) {
				reply({ fields: {} });
				return;
			}
			const reveal = await client.revealSavedLogin(chosen.source, chosen.identifier);
			const fields = {};
			if (userHint) fields[userHint.selector] = reveal.username;
			fields[passwordHint.selector] = reveal.password;
			reply({ fields });
		} catch (error) {
			reply({ error: error instanceof Error ? error.message : String(error) });
		}
	}, [vaultAutofillConfirm]);
	const handleTabHostMessage = useCallback((event) => {
		const detail = event.detail;
		if (!detail || typeof detail.type !== "string") return;
		if (detail.type === "__elizaTabExecResult" && typeof detail.requestId === "number") {
			const pending = pendingTabExecsRef.current.get(detail.requestId);
			if (!pending) return;
			pendingTabExecsRef.current.delete(detail.requestId);
			clearTimeout(pending.timer);
			pending.resolve({
				ok: detail.ok === true,
				result: detail.result,
				error: detail.error
			});
			return;
		}
		if (detail.type === "__elizaWalletRequest" && typeof detail.requestId === "number" && typeof detail.protocol === "string" && typeof detail.method === "string") {
			const tag = event.currentTarget ?? null;
			const tabId = [...electrobunWebviewRefs.current.entries()].find(([, el]) => el === tag)?.[0] ?? null;
			if (!tabId) return;
			handleTabWalletRequest({
				tabId,
				requestId: detail.requestId,
				protocol: detail.protocol,
				method: detail.method,
				params: detail.params,
				hostname: typeof detail.hostname === "string" ? detail.hostname : ""
			});
			return;
		}
		if (detail.type === "__elizaVaultAutofillRequest" && typeof detail.requestId === "number" && typeof detail.domain === "string" && typeof detail.url === "string" && Array.isArray(detail.fieldHints)) {
			const tag = event.currentTarget ?? null;
			const tabId = [...electrobunWebviewRefs.current.entries()].find(([, el]) => el === tag)?.[0] ?? null;
			if (!tabId) return;
			const fieldHints = [];
			for (const hint of detail.fieldHints) if (hint && (hint.kind === "username" || hint.kind === "password") && typeof hint.selector === "string" && hint.selector.length > 0) fieldHints.push({
				kind: hint.kind,
				selector: hint.selector
			});
			handleTabVaultAutofillRequest({
				tabId,
				requestId: detail.requestId,
				domain: detail.domain,
				url: detail.url,
				fieldHints
			});
		}
	}, [handleTabWalletRequest, handleTabVaultAutofillRequest]);
	const registerBrowserWorkspaceElectrobunWebview = useCallback((tabId, element) => {
		const previous = electrobunWebviewRefs.current.get(tabId);
		if (previous && previous !== element) previous.off("host-message", handleTabHostMessage);
		if (!element) {
			electrobunWebviewRefs.current.delete(tabId);
			return;
		}
		if (previous !== element) {
			element.on("host-message", handleTabHostMessage);
			const sync = () => {
				try {
					element.syncDimensions(true);
				} catch {}
			};
			if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => requestAnimationFrame(sync));
			else setTimeout(sync, 0);
			setTimeout(sync, 250);
			setTimeout(sync, 1e3);
			if (selectedTabIdRef.current && selectedTabIdRef.current !== tabId) try {
				element.toggleHidden(true);
			} catch {}
		}
		electrobunWebviewRefs.current.set(tabId, element);
	}, [handleTabHostMessage]);
	const browserSurfaceRef = useRef(null);
	useEffect(() => {
		const surface = browserSurfaceRef.current;
		if (!surface || typeof ResizeObserver === "undefined") return;
		const pokeAll = () => {
			for (const element of electrobunWebviewRefs.current.values()) try {
				element?.syncDimensions(true);
			} catch {}
		};
		const observer = new ResizeObserver(() => pokeAll());
		observer.observe(surface);
		window.addEventListener("resize", pokeAll);
		return () => {
			observer.disconnect();
			window.removeEventListener("resize", pokeAll);
		};
	}, []);
	useEffect(() => {
		if (workspace.mode !== "desktop") return;
		for (const [tabId, element] of electrobunWebviewRefs.current.entries()) {
			if (!element) continue;
			try {
				element.toggleHidden(tabId !== selectedTabId);
				element.syncDimensions(true);
			} catch {}
		}
	}, [selectedTabId, workspace.mode]);
	useEffect(() => {
		const refs = electrobunWebviewRefs;
		return () => {
			for (const element of refs.current.values()) try {
				element?.toggleHidden(true);
			} catch {}
		};
	}, []);
	useEffect(() => {
		const tagsRef = electrobunWebviewRefs;
		const pendingsRef = pendingTabExecsRef;
		const counterRef = tabExecCounterRef;
		setBrowserTabsRendererImpl({
			evaluate: (id, script, timeoutMs) => new Promise((resolve) => {
				const tag = tagsRef.current.get(id);
				if (!tag) {
					resolve({
						ok: false,
						error: `browser workspace tab ${id} is not mounted in the renderer`
					});
					return;
				}
				counterRef.current += 1;
				const requestId = counterRef.current;
				const timer = setTimeout(() => {
					if (pendingsRef.current.delete(requestId)) resolve({
						ok: false,
						error: `browser workspace tab eval timed out after ${timeoutMs}ms`
					});
				}, timeoutMs);
				pendingsRef.current.set(requestId, {
					resolve,
					timer
				});
				tag.executeJavascript(`window.__elizaTabExec(${JSON.stringify(requestId)}, ${JSON.stringify(script)})`);
			}),
			getTabRect: async (id) => {
				const tag = tagsRef.current.get(id);
				if (!tag) return null;
				const rect = tag.getBoundingClientRect();
				if (rect.width <= 0 || rect.height <= 0) return null;
				return {
					x: rect.x,
					y: rect.y,
					width: rect.width,
					height: rect.height
				};
			}
		});
		return () => {
			setBrowserTabsRendererImpl(null);
			for (const pending of pendingsRef.current.values()) {
				clearTimeout(pending.timer);
				pending.resolve({
					ok: false,
					error: "BrowserWorkspaceView unmounted"
				});
			}
			pendingsRef.current.clear();
		};
	}, []);
	const { postBrowserWalletReady } = useBrowserWorkspaceWalletBridge({
		iframeRefs,
		workspaceTabs: workspace.mode === "web" ? workspace.tabs : [],
		walletState: browserWalletState,
		loadWalletState: loadBrowserWalletState
	});
	const closeBrowserWorkspaceTabById = useCallback(async (tabId) => {
		await client.closeBrowserWorkspaceTab(tabId);
		const snapshot = await client.getBrowserWorkspace();
		const nextId = snapshot.tabs.find((tab) => tab.id === selectedTabId)?.id ?? snapshot.tabs[0]?.id ?? null;
		if (nextId && nextId !== selectedTabId) await client.showBrowserWorkspaceTab(nextId);
		await loadWorkspace({
			preferTabId: nextId,
			silent: true
		});
	}, [loadWorkspace, selectedTabId]);
	useEffect(() => {
		loadWorkspace();
	}, [loadWorkspace]);
	useEffect(() => {
		persistBrowserWorkspaceCollapsedSections(collapsedSections);
	}, [collapsedSections]);
	useEffect(() => {
		loadBrowserWalletState();
	}, [loadBrowserWalletState]);
	useEffect(() => {
		if (workspace.mode !== "web" || !browserBridgeSupported) {
			setBrowserBridgeAvailable(false);
			setBrowserBridgeCompanions([]);
			setBrowserBridgePackageStatus(null);
			setBrowserBridgeLoading(false);
			return;
		}
		loadBrowserBridgeState();
	}, [
		browserBridgeSupported,
		loadBrowserBridgeState,
		workspace.mode
	]);
	useIntervalWhenDocumentVisible(() => {
		loadWorkspace({
			preferTabId: selectedTabId,
			silent: true
		});
	}, POLL_INTERVAL_MS);
	useEffect(() => {
		if (!selectedTabId || !isBrowserWorkspaceSessionMode(workspace.mode)) {
			setSnapshotError(null);
			return;
		}
		loadSelectedBrowserWorkspaceSnapshot(selectedTabId, workspace.mode);
	}, [
		loadSelectedBrowserWorkspaceSnapshot,
		selectedTabId,
		workspace.mode
	]);
	useIntervalWhenDocumentVisible(() => {
		if (!selectedTabId || !isBrowserWorkspaceSessionMode(workspace.mode)) return;
		loadSelectedBrowserWorkspaceSnapshot(selectedTabId, workspace.mode);
	}, POLL_INTERVAL_MS, Boolean(selectedTabId) && isBrowserWorkspaceSessionMode(workspace.mode));
	useIntervalWhenDocumentVisible(() => {
		loadBrowserWalletState();
	}, 5e3);
	useIntervalWhenDocumentVisible(() => {
		loadBrowserBridgeState({ silent: true });
	}, BROWSER_BRIDGE_POLL_INTERVAL_MS, workspace.mode === "web" && browserBridgeSupported);
	useEffect(() => {
		const currentSelectedId = selectedTab?.id ?? null;
		if (currentSelectedId !== previousSelectedTabIdRef.current) {
			previousSelectedTabIdRef.current = currentSelectedId;
			setLocationInput(selectedTab?.url ?? "");
			setLocationDirty(false);
			return;
		}
		if (!locationDirty) setLocationInput(selectedTab?.url ?? "");
	}, [
		locationDirty,
		selectedTab?.id,
		selectedTab?.url
	]);
	useEffect(() => {
		if (!initialBrowseUrlRef.current || initialBrowseHandledRef.current || loading) return;
		initialBrowseHandledRef.current = true;
		const existing = workspace.tabs.find((tab) => tab.url === initialBrowseUrlRef.current);
		if (existing) {
			runBrowserWorkspaceAction(`show:${existing.id}`, async () => {
				await activateBrowserWorkspaceTab(existing.id);
			}, t("browserworkspace.OpenInitialBrowseFailed", { defaultValue: "Failed to activate the requested browser tab." }));
			return;
		}
		runBrowserWorkspaceAction("open:initial-browse", async () => {
			await openNewBrowserWorkspaceTab(initialBrowseUrlRef.current ?? "");
		}, t("browserworkspace.OpenInitialBrowseFailed", { defaultValue: "Failed to open the requested browser tab." }));
	}, [
		activateBrowserWorkspaceTab,
		loading,
		openNewBrowserWorkspaceTab,
		runBrowserWorkspaceAction,
		t,
		workspace.tabs
	]);
	const reloadSelectedBrowserWorkspaceTab = useCallback(async () => {
		if (!selectedTab) return;
		if (workspace.mode === "web") {
			const iframe = iframeRefs.current.get(selectedTab.id);
			if (iframe) iframe.src = selectedTab.url;
			return;
		}
		if (workspace.mode === "desktop") {
			electrobunWebviewRefs.current.get(selectedTab.id)?.reload();
			return;
		}
		await client.navigateBrowserWorkspaceTab(selectedTab.id, selectedTab.url);
	}, [selectedTab, workspace.mode]);
	const installBrowserBridgeExtension = useCallback(async () => {
		await runBrowserWorkspaceAction("browser-bridge:install", async () => {
			let nextPackageStatus = browserBridgePackageStatus;
			if (!nextPackageStatus?.chromeBuildPath) {
				const buildResponse = await client.fetch("/api/browser-bridge/packages/chrome/build", { method: "POST" });
				nextPackageStatus = buildResponse.status;
				setBrowserBridgePackageStatus(buildResponse.status);
			}
			const revealResponse = await client.fetch("/api/browser-bridge/packages/open-path", {
				method: "POST",
				body: JSON.stringify({
					target: "chrome_build",
					revealOnly: true
				})
			});
			let openedManager = true;
			try {
				await client.fetch("/api/browser-bridge/packages/chrome/open-manager", { method: "POST" });
			} catch {
				openedManager = false;
			}
			setActionNoticeRef.current(openedManager ? t("browserworkspace.BrowserBridgeChromeReady", {
				defaultValue: "Chrome is ready. Click Load unpacked and choose {{path}}.",
				path: revealResponse.path
			}) : t("browserworkspace.BrowserBridgeFolderReady", {
				defaultValue: "The Agent Browser Bridge folder is ready at {{path}}. Open chrome://extensions, click Load unpacked, and choose that folder.",
				path: revealResponse.path
			}), "success", 6e3);
			await loadBrowserBridgeState({ silent: true });
		}, t("browserworkspace.InstallBrowserBridgeFailed", { defaultValue: "Failed to prepare the Agent Browser Bridge extension." }));
	}, [
		browserBridgePackageStatus,
		loadBrowserBridgeState,
		runBrowserWorkspaceAction,
		t
	]);
	const revealBrowserBridgeFolder = useCallback(async () => {
		await runBrowserWorkspaceAction("browser-bridge:reveal-folder", async () => {
			const response = await client.fetch("/api/browser-bridge/packages/open-path", {
				method: "POST",
				body: JSON.stringify({
					target: "chrome_build",
					revealOnly: true
				})
			});
			setActionNoticeRef.current(t("browserworkspace.BrowserBridgeFolderRevealed", {
				defaultValue: "Revealed the Agent Browser Bridge folder at {{path}}.",
				path: response.path
			}), "success", 4e3);
		}, t("browserworkspace.OpenBrowserBridgeFolderFailed", { defaultValue: "Failed to reveal the Agent Browser Bridge extension folder." }));
	}, [runBrowserWorkspaceAction, t]);
	const openBrowserBridgeChromeExtensions = useCallback(async () => {
		await runBrowserWorkspaceAction("browser-bridge:open-manager", async () => {
			await client.fetch("/api/browser-bridge/packages/chrome/open-manager", { method: "POST" });
			setActionNoticeRef.current(t("browserworkspace.BrowserBridgeOpenedChromeExtensions", { defaultValue: "Opened Chrome extensions. Click Load unpacked and choose the Agent Browser Bridge folder." }), "success", 4e3);
		}, t("browserworkspace.OpenBrowserBridgeManagerFailed", { defaultValue: "Failed to open Chrome extensions." }));
	}, [runBrowserWorkspaceAction, t]);
	const refreshBrowserBridgeConnection = useCallback(async () => {
		await runBrowserWorkspaceAction("browser-bridge:refresh", async () => {
			await loadBrowserBridgeState({ silent: true });
			setActionNoticeRef.current(t("browserworkspace.BrowserBridgeRefreshSuccess", { defaultValue: "Refreshed Agent Browser Bridge connection status." }), "success", 3e3);
		}, t("browserworkspace.RefreshBrowserBridgeFailed", { defaultValue: "Failed to refresh Agent Browser Bridge status." }));
	}, [
		loadBrowserBridgeState,
		runBrowserWorkspaceAction,
		t
	]);
	const browserPageScopeCopy = useMemo(() => getBrowserPageScopeCopy({
		browserBridgeConnected,
		browserBridgeInstallAvailable: browserBridgeSupported,
		browserLabel: primaryBrowserBridgeCompanion?.browser,
		profileLabel: primaryBrowserBridgeCompanion?.profileLabel
	}), [
		browserBridgeConnected,
		browserBridgeSupported,
		primaryBrowserBridgeCompanion?.browser,
		primaryBrowserBridgeCompanion?.profileLabel
	]);
	const browserChatActions = !browserBridgeSupported || browserBridgeConnected ? null : (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [
		(0, import_jsx_runtime.jsx)(Button, {
			size: "sm",
			disabled: busyAction !== null,
			onClick: () => void installBrowserBridgeExtension(),
			children: t("browserworkspace.InstallBrowserBridge", { defaultValue: "Install Agent Browser Bridge" })
		}),
		(0, import_jsx_runtime.jsxs)(Button, {
			variant: "outline",
			size: "sm",
			disabled: busyAction !== null || !browserBridgePackageStatus?.chromeBuildPath,
			onClick: () => void revealBrowserBridgeFolder(),
			children: [(0, import_jsx_runtime.jsx)(FolderOpen, { className: "h-4 w-4" }), t("browserworkspace.OpenBrowserBridgeFolder", { defaultValue: "Open extension folder" })]
		}),
		(0, import_jsx_runtime.jsx)(Button, {
			variant: "outline",
			size: "sm",
			disabled: busyAction !== null,
			onClick: () => void openBrowserBridgeChromeExtensions(),
			children: t("browserworkspace.OpenChromeExtensions", { defaultValue: "Open Chrome extensions" })
		})
	] });
	const browserPageScopedChatPaneProps = useMemo(() => ({
		introOverride: {
			title: browserPageScopeCopy.title,
			body: browserPageScopeCopy.body,
			actions: browserChatActions
		},
		systemAddendumOverride: browserPageScopeCopy.systemAddendum,
		placeholderOverride: browserBridgeConnected ? t("browserworkspace.ChatPlaceholderConnected", { defaultValue: "Message" }) : t("browserworkspace.ChatPlaceholderInstallBridge", { defaultValue: "Message" })
	}), [
		browserBridgeConnected,
		browserChatActions,
		browserPageScopeCopy,
		t
	]);
	const tabsLabel = t("browserworkspace.Tabs", { defaultValue: "Tabs" });
	const userTabsLabel = t("browserworkspace.UserTabs", { defaultValue: "User Tabs" });
	const agentTabsLabel = t("browserworkspace.AgentTabs", { defaultValue: "Agent Tabs" });
	const appTabsLabel = t("browserworkspace.AppTabs", { defaultValue: "App Tabs" });
	const newTabLabel = t("browserworkspace.NewTab", { defaultValue: "New tab" });
	const closeTabLabel = t("browserworkspace.CloseTab", { defaultValue: "Close tab" });
	const goLabel = t("browserworkspace.Go", { defaultValue: "Go" });
	function renderBrowserWorkspaceTabRow(tab) {
		const active = tab.id === selectedTabId;
		const tabHasSessionFocus = workspace.mode === "web" ? tab.visible : active;
		const label = getBrowserWorkspaceTabLabel(tab, t);
		const description = getBrowserWorkspaceTabDescription(tab, workspace.mode);
		const tabIsInternal = isInternalBrowserWorkspaceTab(tab);
		return (0, import_jsx_runtime.jsxs)("div", {
			className: "group relative",
			children: [(0, import_jsx_runtime.jsxs)("button", {
				type: "button",
				role: "tab",
				"aria-selected": active,
				"aria-current": active ? "page" : void 0,
				title: tab.url,
				onClick: () => void runBrowserWorkspaceAction(`show:${tab.id}`, async () => {
					await activateBrowserWorkspaceTab(tab.id);
				}),
				className: `flex w-full min-w-0 items-start gap-1.5 rounded-[var(--radius-sm)] px-1.5 py-1 text-left transition-colors ${tabIsInternal ? "pr-1.5" : "pr-7"} ${active ? "bg-bg-muted/50 text-txt" : "text-txt hover:bg-bg-muted/50"}`,
				children: [(0, import_jsx_runtime.jsx)("span", {
					className: "mt-0.5 inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center text-muted/70",
					children: tabHasSessionFocus ? (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [(0, import_jsx_runtime.jsx)("span", {
						"aria-hidden": true,
						className: "h-2 w-2 rounded-full bg-accent shadow-[0_0_4px_var(--accent)]"
					}), (0, import_jsx_runtime.jsx)("span", {
						className: "sr-only",
						children: t("browserworkspace.AgentActive", { defaultValue: "Agent is on this tab" })
					})] }) : (0, import_jsx_runtime.jsx)("span", {
						className: "text-[10px] font-semibold leading-none",
						children: getBrowserWorkspaceTabMonogram(label)
					})
				}), (0, import_jsx_runtime.jsxs)("span", {
					className: "min-w-0 flex-1",
					children: [(0, import_jsx_runtime.jsx)("span", {
						className: "block truncate text-xs-tight font-medium leading-snug",
						children: label
					}), (0, import_jsx_runtime.jsx)("span", {
						className: "block truncate text-[11px] leading-snug text-muted/65",
						children: description
					})]
				})]
			}), tabIsInternal ? null : (0, import_jsx_runtime.jsx)("button", {
				type: "button",
				"aria-label": `${closeTabLabel} ${label}`,
				title: `${closeTabLabel}: ${label}`,
				className: `absolute right-0 top-1/2 inline-flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded-[var(--radius-sm)] text-muted transition-opacity hover:bg-bg-muted/50 hover:text-danger focus-visible:opacity-100 ${active ? "opacity-100" : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"}`,
				onClick: (event) => {
					event.preventDefault();
					event.stopPropagation();
					runBrowserWorkspaceAction(`close:${tab.id}`, async () => {
						await closeBrowserWorkspaceTabById(tab.id);
					});
				},
				children: (0, import_jsx_runtime.jsx)(X, { className: "h-3 w-3" })
			})]
		}, tab.id);
	}
	const browserTabsSidebar = (0, import_jsx_runtime.jsx)(AppPageSidebar, {
		testId: "browser-workspace-sidebar",
		collapsible: true,
		contentIdentity: "browser-workspace-tabs",
		collapseButtonTestId: "browser-workspace-sidebar-collapse-toggle",
		expandButtonTestId: "browser-workspace-sidebar-expand-toggle",
		collapseButtonAriaLabel: t("browserworkspace.CollapseTabs", { defaultValue: "Collapse browser tabs" }),
		expandButtonAriaLabel: t("browserworkspace.ExpandTabs", { defaultValue: "Expand browser tabs" }),
		mobileTitle: (0, import_jsx_runtime.jsx)(SidebarContent.SectionLabel, { children: tabsLabel }),
		collapsedRailAction: (0, import_jsx_runtime.jsx)(SidebarCollapsedActionButton, {
			"aria-label": newTabLabel,
			onClick: () => void runBrowserWorkspaceAction("open:new", async () => {
				await openNewBrowserWorkspaceTab(newBrowserWorkspaceTabSeedUrl, "user");
			}),
			children: (0, import_jsx_runtime.jsx)(Plus, { className: "h-4 w-4" })
		}),
		collapsedRailItems: collapsedRailTabs.map((tab) => {
			const label = getBrowserWorkspaceTabLabel(tab, t);
			const active = tab.id === selectedTabId;
			const tabHasSessionFocus = workspace.mode === "web" ? tab.visible : active;
			return (0, import_jsx_runtime.jsx)(SidebarContent.RailItem, {
				"aria-label": label,
				title: label,
				active,
				indicatorTone: tabHasSessionFocus ? "accent" : void 0,
				onClick: () => void runBrowserWorkspaceAction(`show:${tab.id}`, async () => {
					await activateBrowserWorkspaceTab(tab.id);
				}),
				children: getBrowserWorkspaceTabMonogram(label)
			}, tab.id);
		}),
		"aria-label": tabsLabel,
		children: (0, import_jsx_runtime.jsx)(SidebarScrollRegion, {
			className: "scrollbar-hide px-1 pb-3 pt-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
			children: (0, import_jsx_runtime.jsx)(SidebarPanel, {
				className: "bg-transparent gap-0 p-0 shadow-none",
				children: (0, import_jsx_runtime.jsxs)("div", {
					className: "space-y-3",
					children: [
						(0, import_jsx_runtime.jsx)(CollapsibleSidebarSection, {
							sectionKey: "user",
							label: userTabsLabel,
							collapsed: collapsedSections.has("user"),
							onToggleCollapsed: toggleSidebarSectionCollapsed,
							onAdd: () => void runBrowserWorkspaceAction("open:new", async () => {
								await openNewBrowserWorkspaceTab(newBrowserWorkspaceTabSeedUrl, "user");
							}),
							addLabel: newTabLabel,
							emptyLabel: t("browserworkspace.NoUserTabs", { defaultValue: "No user tabs yet." }),
							emptyClassName: "pl-3 pr-2 py-1 text-2xs text-muted/70",
							bodyClassName: "space-y-0.5 pl-3",
							hoverActionsOnDesktop: true,
							testIdPrefix: "browser-tab-section",
							children: groupedTabs.user.length > 0 ? (0, import_jsx_runtime.jsx)("div", {
								role: "tablist",
								"aria-label": userTabsLabel,
								className: "space-y-1",
								children: groupedTabs.user.map((tab) => renderBrowserWorkspaceTabRow(tab))
							}) : null
						}),
						(0, import_jsx_runtime.jsx)(CollapsibleSidebarSection, {
							sectionKey: "agent",
							label: agentTabsLabel,
							collapsed: collapsedSections.has("agent"),
							onToggleCollapsed: toggleSidebarSectionCollapsed,
							emptyLabel: t("browserworkspace.NoAgentTabs", { defaultValue: "No agent tabs yet." }),
							emptyClassName: "pl-3 pr-2 py-1 text-2xs text-muted/70",
							bodyClassName: "space-y-0.5 pl-3",
							hoverActionsOnDesktop: true,
							testIdPrefix: "browser-tab-section",
							children: groupedTabs.agent.length > 0 ? (0, import_jsx_runtime.jsx)("div", {
								role: "tablist",
								"aria-label": agentTabsLabel,
								className: "space-y-1",
								children: groupedTabs.agent.map((tab) => renderBrowserWorkspaceTabRow(tab))
							}) : null
						}),
						(0, import_jsx_runtime.jsx)(CollapsibleSidebarSection, {
							sectionKey: "app",
							label: appTabsLabel,
							collapsed: collapsedSections.has("app"),
							onToggleCollapsed: toggleSidebarSectionCollapsed,
							emptyLabel: t("browserworkspace.NoAppTabs", { defaultValue: "No app tabs yet." }),
							emptyClassName: "pl-3 pr-2 py-1 text-2xs text-muted/70",
							bodyClassName: "space-y-0.5 pl-3",
							hoverActionsOnDesktop: true,
							testIdPrefix: "browser-tab-section",
							children: groupedTabs.app.length > 0 ? (0, import_jsx_runtime.jsx)("div", {
								role: "tablist",
								"aria-label": appTabsLabel,
								className: "space-y-1",
								children: groupedTabs.app.map((tab) => renderBrowserWorkspaceTabRow(tab))
							}) : null
						})
					]
				})
			})
		})
	});
	const navNode = (0, import_jsx_runtime.jsxs)("div", {
		className: "flex items-center gap-2 border-b border-border/30 bg-card/20 px-3 py-2",
		children: [
			(0, import_jsx_runtime.jsx)(Button, {
				variant: "ghost",
				size: "icon",
				className: "h-8 w-8",
				"aria-label": t("common.refresh", { defaultValue: "Refresh" }),
				disabled: !selectedTab || busyAction !== null,
				onClick: () => void runBrowserWorkspaceAction("reload:selected", async () => {
					await reloadSelectedBrowserWorkspaceTab();
				}),
				children: (0, import_jsx_runtime.jsx)(RefreshCw, { className: "h-4 w-4" })
			}),
			(0, import_jsx_runtime.jsx)(Input, {
				value: locationInput,
				onChange: (event) => {
					setLocationInput(event.target.value);
					setLocationDirty(true);
				},
				onKeyDown: (event) => {
					if (event.key === "Enter") {
						event.preventDefault();
						runBrowserWorkspaceAction("navigate:enter", async () => {
							await navigateSelectedBrowserWorkspaceTab(locationInput);
						});
					}
				},
				placeholder: t("browserworkspace.AddressPlaceholder", { defaultValue: selectedTabIsInternal ? "Internal tab URL is managed by the app" : "Enter a URL" }),
				"data-testid": "browser-workspace-address-input",
				disabled: busyAction !== null || selectedTabIsInternal,
				className: "h-8 min-w-0 flex-1 rounded-full border-border/40 bg-card/70 px-4 text-sm text-txt"
			}),
			(0, import_jsx_runtime.jsx)(Button, {
				variant: "outline",
				size: "sm",
				className: "h-8 shrink-0 px-3",
				"aria-label": goLabel,
				disabled: busyAction !== null || selectedTabIsInternal || locationInput.trim().length === 0,
				onClick: () => void runBrowserWorkspaceAction("navigate:click", async () => {
					await navigateSelectedBrowserWorkspaceTab(locationInput);
				}),
				children: goLabel
			}),
			(0, import_jsx_runtime.jsx)(Button, {
				variant: "ghost",
				size: "icon",
				className: "h-8 w-8",
				"aria-label": t("browserworkspace.OpenExternal", { defaultValue: "Open external" }),
				disabled: !selectedTab || busyAction !== null,
				onClick: () => void runBrowserWorkspaceAction("open:external", async () => {
					if (!selectedTab) return;
					await openExternalUrl(selectedTab.url);
				}),
				children: (0, import_jsx_runtime.jsx)(ExternalLink, { className: "h-4 w-4" })
			})
		]
	});
	const watchBannerLabel = busyAction ? t("browserworkspace.Working", {
		defaultValue: "Working: {{action}}",
		action: busyAction.replace(/[:\-_]+/g, " ")
	}) : null;
	return (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [
		(0, import_jsx_runtime.jsx)(AppWorkspaceChrome, {
			testId: "browser-workspace-view",
			main: (0, import_jsx_runtime.jsx)(WorkspaceLayout, {
				sidebar: browserTabsSidebar,
				contentHeader: navNode,
				contentHeaderClassName: "mb-0",
				headerPlacement: "inside",
				contentPadding: false,
				contentClassName: "overflow-hidden",
				contentInnerClassName: "min-h-0 overflow-hidden",
				mobileSidebarLabel: tabsLabel,
				mobileSidebarTriggerClassName: "ml-3 mt-3",
				children: (0, import_jsx_runtime.jsxs)("div", {
					ref: browserSurfaceRef,
					className: "relative flex-1 min-h-0 overflow-hidden bg-bg",
					children: [
						watchBannerLabel ? (0, import_jsx_runtime.jsxs)("div", {
							className: "absolute left-3 right-3 top-2 z-20 flex items-center gap-2 rounded-md border border-border/40 bg-card/80 px-3 py-1.5 text-xs text-muted shadow-sm backdrop-blur-sm",
							role: "status",
							"aria-live": "polite",
							"data-testid": "browser-workspace-watch-banner",
							children: [(0, import_jsx_runtime.jsx)("span", {
								"aria-hidden": true,
								className: "inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-accent shadow-[0_0_4px_var(--accent)]"
							}), (0, import_jsx_runtime.jsx)("span", {
								className: "truncate",
								children: watchBannerLabel
							})]
						}) : null,
						loadError ? (0, import_jsx_runtime.jsx)("div", {
							className: "absolute left-1/2 top-6 z-20 -translate-x-1/2 rounded-md border border-danger/50 bg-danger/15 px-3 py-1.5 text-xs text-danger",
							role: "alert",
							children: loadError
						}) : null,
						workspace.tabs.length === 0 ? (0, import_jsx_runtime.jsx)("div", {
							className: "flex h-full items-center justify-center",
							children: (0, import_jsx_runtime.jsxs)("div", {
								className: "flex max-w-sm flex-col items-center gap-3 text-center",
								children: [
									(0, import_jsx_runtime.jsx)("div", {
										className: "text-sm font-semibold text-txt",
										children: loading ? t("browserworkspace.Loading", { defaultValue: "Loading browser workspace" }) : t("browserworkspace.EmptyTitle", { defaultValue: "No browser tabs yet" })
									}),
									(0, import_jsx_runtime.jsx)("div", {
										className: "text-xs leading-5 text-muted",
										children: isBrowserWorkspaceSessionMode(workspace.mode) ? t("browserworkspace.EmptySessionDescription", { defaultValue: "Open a page to start a real browser session. The preview here follows the session instead of embedding the target site directly." }) : t("browserworkspace.EmptyDescription", { defaultValue: "Open a tab and watch the agent drive the page. Wallet and signing route through your local Steward — no extension required." })
									}),
									!loading ? (0, import_jsx_runtime.jsx)(Button, {
										size: "sm",
										className: "mt-1",
										disabled: busyAction !== null,
										onClick: () => void runBrowserWorkspaceAction("open:home", async () => {
											await openNewBrowserWorkspaceTab(BROWSER_WORKSPACE_DEFAULT_HOME_URL, "user");
										}),
										"data-testid": "browser-workspace-open-home",
										children: t("browserworkspace.OpenNewTab", { defaultValue: "Open new tab" })
									}) : null,
									!loading && workspace.mode === "web" && browserBridgeSupported ? (0, import_jsx_runtime.jsxs)("div", {
										className: "mt-3 flex w-full flex-col gap-3 rounded-md border border-border/40 bg-card/35 p-3 text-left",
										children: [(0, import_jsx_runtime.jsxs)("div", {
											className: "flex items-start justify-between gap-3",
											children: [(0, import_jsx_runtime.jsxs)("div", {
												className: "min-w-0",
												children: [
													(0, import_jsx_runtime.jsx)("div", {
														className: "text-xs font-semibold text-txt",
														children: t("browserworkspace.BrowserBridgeTitle", { defaultValue: "Agent Browser Bridge" })
													}),
													(0, import_jsx_runtime.jsx)("div", {
														className: "mt-1 text-xs leading-5 text-muted",
														children: t("browserworkspace.BrowserBridgeDescription", { defaultValue: "The agent can drive your real Chrome tabs with the Agent Browser Bridge extension." })
													}),
													(0, import_jsx_runtime.jsxs)("div", {
														className: "mt-1 truncate text-[11px] text-muted",
														children: [browserBridgeConnected ? t("browserworkspace.BrowserBridgeConnected", { defaultValue: "Connected" }) : browserBridgeAvailable ? t("browserworkspace.BrowserBridgeAvailable", { defaultValue: "Extension available" }) : t("browserworkspace.BrowserBridgeNotConnected", { defaultValue: "Not connected" }), browserBridgePackageStatus?.chromeBuildPath ? ` - ${browserBridgePackageStatus.chromeBuildPath}` : ""]
													})
												]
											}), (0, import_jsx_runtime.jsx)(Button, {
												variant: "ghost",
												size: "icon",
												className: "h-8 w-8 shrink-0",
												"aria-label": t("browserworkspace.RefreshBrowserBridge", { defaultValue: "Refresh Agent Browser Bridge" }),
												disabled: browserBridgeLoading || busyAction !== null,
												onClick: () => void refreshBrowserBridgeConnection(),
												children: (0, import_jsx_runtime.jsx)(RefreshCw, { className: "h-4 w-4" })
											})]
										}), (0, import_jsx_runtime.jsxs)("div", {
											className: "flex flex-wrap gap-2",
											children: [
												(0, import_jsx_runtime.jsx)(Button, {
													size: "sm",
													disabled: busyAction !== null,
													onClick: () => void installBrowserBridgeExtension(),
													children: t("browserworkspace.InstallBrowserBridge", { defaultValue: "Install Agent Browser Bridge" })
												}),
												(0, import_jsx_runtime.jsxs)(Button, {
													variant: "outline",
													size: "sm",
													disabled: busyAction !== null || !browserBridgePackageStatus?.chromeBuildPath,
													onClick: () => void revealBrowserBridgeFolder(),
													children: [(0, import_jsx_runtime.jsx)(FolderOpen, { className: "h-4 w-4" }), t("browserworkspace.OpenBrowserBridgeFolder", { defaultValue: "Open extension folder" })]
												}),
												(0, import_jsx_runtime.jsx)(Button, {
													variant: "outline",
													size: "sm",
													disabled: busyAction !== null,
													onClick: () => void openBrowserBridgeChromeExtensions(),
													children: t("browserworkspace.OpenChromeExtensions", { defaultValue: "Open Chrome extensions" })
												})
											]
										})]
									}) : null
								]
							})
						}) : workspace.mode === "desktop" ? workspace.tabs.map((tab) => {
							const visibilityClass = tab.id === selectedTabId ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0";
							return (0, import_jsx_runtime.jsx)("electrobun-webview", {
								ref: (el) => registerBrowserWorkspaceElectrobunWebview(tab.id, el ?? null),
								src: tab.url,
								partition: tab.partition,
								preload: BROWSER_TAB_PRELOAD_SCRIPT,
								className: `absolute inset-0 ${visibilityClass}`,
								style: { display: "block" }
							}, tab.id);
						}) : workspace.mode === "web" ? workspace.tabs.map((tab) => {
							const active = tab.id === selectedTabId;
							const highlighted = tab.visible;
							const frameBlocked = isBrowserWorkspaceFrameBlockedUrl(tab.url);
							const visibilityClass = active ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0";
							if (frameBlocked) return (0, import_jsx_runtime.jsx)("div", {
								className: `absolute inset-0 flex h-full w-full items-center justify-center bg-bg px-6 text-center transition-opacity ${visibilityClass}`,
								children: (0, import_jsx_runtime.jsxs)("div", {
									className: "flex max-w-md flex-col items-center gap-3",
									children: [
										(0, import_jsx_runtime.jsx)("div", {
											className: "text-sm font-semibold text-txt",
											children: t("browserworkspace.FrameBlockedTitle", { defaultValue: "Open this site outside the iframe" })
										}),
										(0, import_jsx_runtime.jsx)("div", {
											className: "text-xs leading-5 text-muted",
											children: t("browserworkspace.FrameBlockedDescription", { defaultValue: "Discord blocks embedded browser frames. Use Eliza Desktop Browser or a connected browser profile so LifeOps can inspect the page after login." })
										}),
										(0, import_jsx_runtime.jsxs)(Button, {
											type: "button",
											size: "sm",
											variant: "outline",
											disabled: busyAction !== null,
											onClick: () => void runBrowserWorkspaceAction(`open:external:${tab.id}`, async () => {
												await openExternalUrl(tab.url);
											}),
											children: [(0, import_jsx_runtime.jsx)(ExternalLink, { className: "h-4 w-4" }), t("browserworkspace.OpenExternal", { defaultValue: "Open external" })]
										})
									]
								})
							}, tab.id);
							return (0, import_jsx_runtime.jsx)("iframe", {
								ref: (iframe) => registerBrowserWorkspaceIframe(tab.id, iframe),
								title: getBrowserWorkspaceTabLabel(tab, t),
								src: tab.url,
								loading: "eager",
								sandbox: "allow-downloads allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-same-origin allow-scripts",
								allow: "clipboard-read; clipboard-write",
								referrerPolicy: "strict-origin-when-cross-origin",
								className: `absolute inset-0 h-full w-full border-0 bg-bg transition-opacity ${visibilityClass}`,
								style: { colorScheme: uiTheme },
								onLoad: () => highlighted ? postBrowserWalletReady(tab, browserWalletState) : void 0
							}, tab.id);
						}) : (0, import_jsx_runtime.jsxs)("div", {
							className: "flex h-full flex-1 flex-col bg-bg",
							children: [
								(0, import_jsx_runtime.jsxs)("div", {
									className: "flex flex-wrap items-center gap-2 border-b border-border/30 bg-card/20 px-3 py-2 text-xs text-muted",
									children: [
										(0, import_jsx_runtime.jsx)("span", {
											className: "rounded-full border border-border/40 bg-card/60 px-2 py-1 font-medium text-txt",
											children: t("browserworkspace.CloudSession", { defaultValue: "Cloud browser session" })
										}),
										selectedTab?.provider ? (0, import_jsx_runtime.jsxs)("span", { children: [t("common.provider", { defaultValue: "Provider" }), `: ${selectedTab.provider}`] }) : null,
										selectedTab?.status ? (0, import_jsx_runtime.jsxs)("span", { children: [t("common.status", { defaultValue: "Status" }), `: ${selectedTab.status}`] }) : null,
										selectedTabLiveViewUrl ? (0, import_jsx_runtime.jsx)("button", {
											type: "button",
											className: "rounded-md border border-border/40 px-2 py-1 text-txt hover:bg-card/60",
											onClick: () => void runBrowserWorkspaceAction("open:live-session", async () => {
												await openExternalUrl(selectedTabLiveViewUrl);
											}),
											children: t("browserworkspace.OpenLiveSession", { defaultValue: "Open live session" })
										}) : null
									]
								}),
								(0, import_jsx_runtime.jsxs)("div", {
									className: "relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-card/15",
									children: [snapshotError ? (0, import_jsx_runtime.jsx)("div", {
										className: "absolute left-1/2 top-6 z-20 -translate-x-1/2 rounded-md border border-danger/50 bg-danger/15 px-3 py-1.5 text-xs text-danger",
										role: "alert",
										children: snapshotError
									}) : null, selectedTabSnapshot ? (0, import_jsx_runtime.jsx)("img", {
										alt: selectedTab ? getBrowserWorkspaceTabLabel(selectedTab, t) : t("browserworkspace.SessionPreview", { defaultValue: "Browser session preview" }),
										src: `data:image/png;base64,${selectedTabSnapshot}`,
										className: "h-full w-full object-contain"
									}) : (0, import_jsx_runtime.jsxs)("div", {
										className: "flex max-w-sm flex-col items-center gap-2 px-6 text-center",
										children: [(0, import_jsx_runtime.jsx)("div", {
											className: "text-sm font-semibold text-txt",
											children: t("browserworkspace.SessionPreviewPending", { defaultValue: "Waiting for browser session preview" })
										}), (0, import_jsx_runtime.jsx)("div", {
											className: "text-xs text-muted",
											children: t("browserworkspace.SessionPreviewPendingDescription", { defaultValue: "The page is running in a real browser session. A fresh preview will appear here as the session updates." })
										})]
									})]
								}),
								selectedTab ? (0, import_jsx_runtime.jsxs)("div", {
									className: "border-t border-border/30 bg-card/20 px-3 py-2 text-xs text-muted",
									children: [
										(0, import_jsx_runtime.jsx)("div", {
											className: "truncate font-medium text-txt",
											children: getBrowserWorkspaceTabLabel(selectedTab, t)
										}),
										(0, import_jsx_runtime.jsx)("div", {
											className: "truncate",
											children: selectedTab.url
										}),
										(0, import_jsx_runtime.jsx)("div", {
											className: "mt-1",
											children: selectedTabIsInternal ? t("browserworkspace.InternalSessionDescription", { defaultValue: "This is an internal app-managed browser session. Use LifeOps actions to steer it; the URL is locked in the Browser view." }) : t("browserworkspace.RealSessionDescription", { defaultValue: "This is a real browser session, not a raw iframe embed. Use chat or browser actions to navigate and interact with sites like Google and Discord." })
										})
									]
								}) : null
							]
						})
					]
				})
			}),
			chatScope: "page-browser",
			pageScopedChatPaneProps: browserPageScopedChatPaneProps
		}),
		(0, import_jsx_runtime.jsx)(ConfirmDialog, { ...vaultAutofillModalProps }),
		(0, import_jsx_runtime.jsx)(ConfirmDialog, { ...walletActionModalProps })
	] });
}

//#endregion
export { BrowserWorkspaceView_exports as n, CollapsibleSidebarSection as r, BrowserWorkspaceView as t };