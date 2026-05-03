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

export type BrowserTabsRendererImpl = {
  evaluate: (
    id: string,
    script: string,
    timeoutMs: number,
  ) => Promise<{ ok: boolean; result?: unknown; error?: string }>;
  getTabRect: (id: string) => Promise<{
    x: number;
    y: number;
    width: number;
    height: number;
  } | null>;
};

const REGISTRY_KEY = "__ELIZA_BROWSER_TABS_REGISTRY__" as const;

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
export const BROWSER_TAB_PRELOAD_SCRIPT = `
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

declare global {
  interface Window {
    [REGISTRY_KEY]?: BrowserTabsRendererImpl;
  }
}

export function setBrowserTabsRendererImpl(
  impl: BrowserTabsRendererImpl | null,
): void {
  if (typeof window === "undefined") return;
  if (impl) {
    window[REGISTRY_KEY] = impl;
  } else {
    delete window[REGISTRY_KEY];
  }
}
