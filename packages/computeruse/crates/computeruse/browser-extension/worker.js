const WS_URL = "ws://127.0.0.1:17373";
let socket = null;
let reconnectTimer = null;

// Simple Set to track what we've attached to
const attachedTabs = new Set();
// Track which tabs have Runtime and Log domains enabled
const enabledTabs = new Set();

// Clear stored tabs on startup since debugger sessions don't persist across restarts
chrome.storage.session.remove("attached").then(() => {
  log("Cleared stale debugger session data on startup");
});

// Logging is disabled by default to reduce console noise. Toggle via Service Worker console.
let debugEnabled = true;
self.enableComputerUseDebug = () => {
  debugEnabled = true;
};
self.disableComputerUseDebug = () => {
  debugEnabled = false;
};
function log(...args) {
  if (!debugEnabled) return;
  console.log("[ComputerUseBridge]", ...args);
}

// === LIFECYCLE & HEARTBEAT LOGGING ===
const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_LOG_ENTRIES = 100;
let lastInstallReason = null;
let lastPreviousVersion = null;

// Log extension lifecycle events to persistent storage
async function logLifecycleEvent(event, details = {}) {
  try {
    const entry = {
      timestamp: new Date().toISOString(),
      event,
      extensionId: chrome.runtime.id,
      version: chrome.runtime.getManifest().version,
      ...details
    };

    // Get existing log
    const data = await chrome.storage.local.get('computeruseLog');
    const logs = data.computeruseLog || [];

    // Add new entry, trim old ones
    logs.push(entry);
    if (logs.length > MAX_LOG_ENTRIES) {
      logs.splice(0, logs.length - MAX_LOG_ENTRIES);
    }

    await chrome.storage.local.set({
      computeruseLog: logs,
      lastHeartbeat: entry.timestamp
    });

    log(`[Lifecycle] ${event}:`, entry);
  } catch (e) {
    console.error('[ComputerUseBridge] Failed to log lifecycle event:', e);
  }
}

// Get extension health info for reporting to Rust backend
async function getExtensionHealth() {
  try {
    const data = await chrome.storage.local.get(['computeruseLog', 'lastHeartbeat']);
    return {
      type: 'extension_health',
      extension_id: chrome.runtime.id,
      version: chrome.runtime.getManifest().version,
      last_heartbeat: data.lastHeartbeat || null,
      recent_logs: (data.computeruseLog || []).slice(-10),
      install_reason: lastInstallReason,
      previous_version: lastPreviousVersion
    };
  } catch (e) {
    console.error('[ComputerUseBridge] Failed to get extension health:', e);
    return {
      type: 'extension_health',
      extension_id: chrome.runtime.id,
      version: chrome.runtime.getManifest().version,
      error: String(e)
    };
  }
}

// Lifecycle event handlers
chrome.runtime.onInstalled.addListener((details) => {
  lastInstallReason = details.reason;
  lastPreviousVersion = details.previousVersion || null;
  logLifecycleEvent('installed', { reason: details.reason, previousVersion: details.previousVersion });
});

chrome.runtime.onStartup.addListener(() => {
  logLifecycleEvent('startup');
});

// Periodic heartbeat
setInterval(() => {
  logLifecycleEvent('heartbeat');
}, HEARTBEAT_INTERVAL_MS);

// Initial heartbeat on service worker load
logLifecycleEvent('service_worker_started');

// Exponential backoff to reduce repeated connection error spam
const BASE_RECONNECT_DELAY_MS = 500; // faster initial retry
const MAX_RECONNECT_DELAY_MS = 3000; // cap retries to 3s to align with host waiting
let currentReconnectDelayMs = BASE_RECONNECT_DELAY_MS;
let connectionAttempts = 0;
const MAX_LOGGED_ATTEMPTS = 3; // Only log first few attempts to reduce noise

function connect() {
  try {
    if (
      socket &&
      (socket.readyState === WebSocket.OPEN ||
        socket.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }
  } catch (_) {}
  try {
    socket = new WebSocket(WS_URL);
  } catch (e) {
    log("WebSocket construct error", e);
    scheduleReconnect();
    return;
  }

  socket.onopen = () => {
    log("Connected to", WS_URL);
    // Reset backoff on successful connection
    currentReconnectDelayMs = BASE_RECONNECT_DELAY_MS;
    connectionAttempts = 0; // Reset connection attempts on successful connection
    socket.send(JSON.stringify({ type: "hello", from: "extension" }));
  };

  socket.onclose = () => {
    // Only log socket closed for first 3 attempts and every 10th
    if (connectionAttempts <= 3 || connectionAttempts % 10 === 0) {
      log(`Socket closed (attempt ${connectionAttempts})`);
    }
    scheduleReconnect();
  };

  socket.onerror = (e) => {
    connectionAttempts++;
    // Only log first 3 attempts and then every 10th attempt to reduce noise
    if (connectionAttempts <= 3 || connectionAttempts % 10 === 0) {
      log(`Socket error (attempt ${connectionAttempts})`, e);
    }
    try {
      socket.close();
    } catch (_) {}
  };

  socket.onmessage = async (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch (e) {
      log("Invalid JSON", event.data);
      return;
    }
    if (!msg || !msg.action) return;

    if (msg.action === "eval") {
      const { id, code, awaitPromise = true } = msg;
      try {
        const tabId = await getActiveTabId();
        const result = await evalInTab(tabId, code, awaitPromise, id);
        safeSend({ id, ok: true, result });
      } catch (err) {
        safeSend({ id, ok: false, error: String(err && (err.message || err)) });
      }
    } else if (msg.action === "ping") {
      safeSend({ type: "pong" });
    } else if (msg.action === "reset") {
      // Force reset all debugger state
      log("Received reset command");
      await forceResetDebuggerState();
      safeSend({ type: "reset_complete", ok: true });
    } else if (msg.action === "get_extension_health") {
      // Return extension health info for logging on Rust side
      log("Received get_extension_health request");
      const health = await getExtensionHealth();
      safeSend(health);
    } else if (msg.action === "capture_element_at_point") {
      // New action for recording DOM elements
      const { id, x, y } = msg;
      try {
        const tabId = await getActiveTabId();
        const result = await captureElementAtPoint(tabId, x, y, id);
        safeSend({ id, ok: true, result });
      } catch (err) {
        safeSend({ id, ok: false, error: String(err && (err.message || err)) });
      }
    } else if (msg.action === "start_recording_session") {
      // Initialize recording mode
      const { id, sessionId } = msg;
      try {
        await startRecordingSession(sessionId);
        safeSend({ id, ok: true, result: { sessionId, status: "recording" } });
      } catch (err) {
        safeSend({ id, ok: false, error: String(err && (err.message || err)) });
      }
    } else if (msg.action === "stop_recording_session") {
      // Stop recording mode
      const { id, sessionId } = msg;
      try {
        await stopRecordingSession(sessionId);
        safeSend({ id, ok: true, result: { sessionId, status: "stopped" } });
      } catch (err) {
        safeSend({ id, ok: false, error: String(err && (err.message || err)) });
      }
    } else if (msg.action === "close_tab") {
      // Close a specific browser tab safely
      const { id, tabId: requestedTabId, url: targetUrl, title: targetTitle } = msg;
      try {
        const result = await closeTab(requestedTabId, targetUrl, targetTitle);
        safeSend({ id, ok: true, result });
      } catch (err) {
        safeSend({ id, ok: false, error: String(err && (err.message || err)) });
      }
    }
  };
}

function ensureConnected() {
  try {
    if (
      !socket ||
      (socket.readyState !== WebSocket.OPEN &&
        socket.readyState !== WebSocket.CONNECTING)
    ) {
      connect();
    }
  } catch (_) {
    connect();
  }
}

// Ensure we have an active WS connection on first message from content script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  try {
    if (!message || message.type !== "computeruse_content_handshake") return;
    log("Received handshake from content script", {
      tab: sender.tab && sender.tab.id,
    });
    // Kick the connector if not already connected; otherwise noop
    ensureConnected();
    sendResponse({ ok: true });
  } catch (e) {
    try {
      sendResponse({ ok: false, error: String(e && (e.message || e)) });
    } catch (_) {}
    // swallow
  }
  // Keep listener alive for async sendResponse
  return true;
});

// Inject a lightweight handshake into the active tab when it changes/updates
async function injectHandshake(tabId) {
  try {
    if (typeof tabId !== "number") return;
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        try {
          chrome.runtime.sendMessage({ type: "computeruse_content_handshake" });
        } catch (_) {}
      },
      world: "ISOLATED",
    });
  } catch (e) {
    // ignore (e.g., not permitted on special pages)
  }
}

async function getActiveTabIdSafe() {
  try {
    const [tab] = await chrome.tabs.query({
      active: true,
      lastFocusedWindow: true,
    });
    return tab && tab.id != null ? tab.id : null;
  } catch (_) {
    return null;
  }
}

// Additional event-based triggers to wake the worker and maintain connection
chrome.runtime.onInstalled.addListener(() => {
  log("onInstalled → ensureConnected");
  ensureConnected();
});
chrome.runtime.onStartup.addListener(() => {
  log("onStartup → ensureConnected");
  ensureConnected();
});
chrome.webNavigation.onCommitted.addListener(() => {
  ensureConnected();
});
chrome.alarms.clear("computeruse_keepalive");
chrome.alarms.create("computeruse_keepalive", { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm && alarm.name === "computeruse_keepalive") {
    ensureConnected();
  }
});
chrome.tabs.onActivated.addListener(async () => {
  ensureConnected();
  const tabId = await getActiveTabIdSafe();
  if (tabId != null) injectHandshake(tabId);
});
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (
    changeInfo &&
    (changeInfo.status === "loading" || changeInfo.status === "complete")
  ) {
    ensureConnected();
    injectHandshake(tabId);
  }
});

// Clean up our tracking when tab closes
chrome.tabs.onRemoved.addListener((tabId) => {
  if (attachedTabs.has(tabId)) {
    attachedTabs.delete(tabId);
    enabledTabs.delete(tabId); // Also clean enabled domains state
    chrome.storage.session.set({ attached: [...attachedTabs] });
    log(`Tab ${tabId} closed, removed from attached tabs and enabled domains`);
  }
});

// Clean up when debugger is manually detached (user clicked Cancel)
chrome.debugger.onDetach.addListener((source, reason) => {
  const tabId = source.tabId;
  if (attachedTabs.has(tabId)) {
    attachedTabs.delete(tabId);
    enabledTabs.delete(tabId); // Also clean enabled domains state
    chrome.storage.session.set({ attached: [...attachedTabs] });
    log(`Debugger detached from tab ${tabId}, reason: ${reason}`);
  }
});

function scheduleReconnect() {
  if (reconnectTimer) return;

  const delay = currentReconnectDelayMs;
  currentReconnectDelayMs = Math.min(
    currentReconnectDelayMs * 2,
    MAX_RECONNECT_DELAY_MS,
  );
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    // Only log reconnection for first 3 attempts and then every 10th
    if (connectionAttempts <= 3 || connectionAttempts % 10 === 0) {
      log(
        `Reconnecting... (attempt ${connectionAttempts + 1}, delay=${delay}ms)`,
      );
    }
    connect();
  }, delay);
}

async function forceResetDebuggerState() {
  log("Force resetting all debugger state...");

  // Store the previous size for logging
  const previousSize = attachedTabs.size;

  // 1. FIRST: Detach from all tabs (must happen before clearing state)
  let detachedCount = 0;
  try {
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      if (tab.id != null) {
        try {
          await debuggerDetach(tab.id);
          detachedCount++;
        } catch (e) {
          // Ignore - tab might not be attached or might be special page
        }
      }
    }
  } catch (e) {
    log("Error during tab cleanup (continuing anyway):", e.message || e);
  }

  // 2. THEN: Clear in-memory state (after detachment completes)
  attachedTabs.clear();
  enabledTabs.clear();

  // 3. Clear session storage
  await chrome.storage.session.remove("attached");

  log(
    `Reset complete: cleared ${previousSize} tracked tabs, detached from ${detachedCount} tabs`,
  );
  log("Debugger state reset complete");
}

function safeSend(obj) {
  try {
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(obj));
    }
  } catch (e) {
    log("Failed to send", e);
  }
}

async function getActiveTabId() {
  const [tab] = await chrome.tabs.query({
    active: true,
    lastFocusedWindow: true,
  });
  if (!tab || tab.id == null) throw new Error("No active tab");
  return tab.id;
}

function formatRemoteObject(obj) {
  try {
    if (obj === null || obj === undefined) return null;
    if (Object.prototype.hasOwnProperty.call(obj, "value")) return obj.value;
    if (obj.description !== undefined) return obj.description;
    return obj.type || null;
  } catch (_) {
    return null;
  }
}

// Helper function to detect if code has top-level return statements
function hasTopLevelReturn(code) {
  // Quick check if 'return' keyword exists at all
  if (!code.includes("return")) {
    return false;
  }

  // Simple heuristic: if code starts with return or has return after newline/semicolon
  // but NOT inside a function body
  // This is a simplified check that covers most common cases

  // First, check for some patterns that definitely DON'T need wrapping
  // 1. Already wrapped in IIFE
  if (/^\s*\(\s*function\s*\(/.test(code) || /^\s*\(\s*\(\s*\)/.test(code)) {
    return false;
  }

  // 2. Is just an expression (no statements)
  if (!code.includes(";") && !code.includes("\n") && !code.includes("return")) {
    return false;
  }

  // Remove strings and comments for cleaner analysis
  let cleanCode = code
    // Remove single-line comments
    .replace(/\/\/.*$/gm, "")
    // Remove multi-line comments
    .replace(/\/\*[\s\S]*?\*\//g, "")
    // Remove strings (simplified - doesn't handle escaped quotes)
    .replace(/"[^"]*"/g, '""')
    .replace(/'[^']*'/g, "''")
    .replace(/`[^`]*`/g, "``");

  // Look for return statements that are likely at the top level
  // Common patterns:
  // 1. return at start of code (with optional whitespace)
  // 2. return after a semicolon or closing brace
  // 3. return on a new line
  const returnPatterns = [
    /^\s*return\s+/, // starts with return
    /;\s*return\s+/, // return after semicolon
    /}\s*return\s+/, // return after closing brace (like after if block)
    /\n\s*return\s+/, // return on new line
  ];

  // Check if any of these patterns exist
  const hasReturn = returnPatterns.some((pattern) => pattern.test(cleanCode));

  if (!hasReturn) {
    return false;
  }

  // Additional check: if it looks like it's inside a function, don't wrap
  // Look for function keyword before the return
  const beforeReturn = cleanCode.substring(0, cleanCode.indexOf("return"));

  // Count unmatched opening braces before return
  const openBraces = (beforeReturn.match(/{/g) || []).length;
  const closeBraces = (beforeReturn.match(/}/g) || []).length;

  // If we have unclosed braces and a function declaration, the return is likely inside it
  if (openBraces > closeBraces && /function\s*\(|=>\s*{/.test(beforeReturn)) {
    return false;
  }

  // Likely has top-level return
  return true;
}

// Helper function to detect async IIFE pattern
function isAsyncIIFE(code) {
  // Extract the last statement from the code (after any var declarations)
  const trimmed = code.trim();

  // Find the last complete statement by looking for the last IIFE pattern
  // This handles cases where env vars are injected before the IIFE
  const asyncIIFEPatterns = [
    /\(\s*async\s+function\s*\([^)]*\)\s*{[\s\S]*?}\s*\)\s*\(\s*\)\s*;?\s*$/,
    /\(\s*async\s*\([^)]*\)\s*=>\s*{[\s\S]*?}\s*\)\s*\(\s*\)\s*;?\s*$/,
    /\(\s*async\s+function\s+\w+\s*\([^)]*\)\s*{[\s\S]*?}\s*\)\s*\(\s*\)\s*;?\s*$/,
  ];

  return asyncIIFEPatterns.some((pattern) => pattern.test(trimmed));
}

// Helper function to detect regular (non-async) IIFE pattern
function isRegularIIFE(code) {
  // Extract the last statement from the code (after any var declarations)
  const trimmed = code.trim();

  // Find the last complete statement by looking for the last IIFE pattern
  // This handles cases where env vars are injected before the IIFE
  const iifePatterns = [
    /\(\s*function\s*\([^)]*\)\s*{[\s\S]*?}\s*\)\s*\(\s*\)\s*;?\s*$/,
    /\(\s*function\s+\w+\s*\([^)]*\)\s*{[\s\S]*?}\s*\)\s*\(\s*\)\s*;?\s*$/,
    /\(\s*\([^)]*\)\s*=>\s*{[\s\S]*?}\s*\)\s*\(\s*\)\s*;?\s*$/,
  ];

  return iifePatterns.some((pattern) => pattern.test(trimmed));
}

// Helper function to wrap code in IIFE if it has top-level returns
function wrapCodeIfNeeded(code) {
  // Check if it's an async IIFE - if so, return as-is since it's already wrapped
  if (isAsyncIIFE(code)) {
    log(
      "Detected async IIFE pattern, using as-is (will set awaitPromise=true)",
    );
    return code;
  }

  // Check if it's a regular IIFE - if so, return as-is since it's already wrapped
  if (isRegularIIFE(code)) {
    log("Detected regular IIFE pattern, using as-is");
    return code;
  }

  if (hasTopLevelReturn(code)) {
    log("Detected top-level return statement, wrapping in IIFE");
    return `(function() {\n${code}\n})()`;
  }

  // For code without top-level returns, wrap in eval to capture last expression
  // This creates a clean scope while still returning the last expression
  log("Wrapping in eval to capture last expression and create clean scope");
  return `(function() { return eval(${JSON.stringify(code)}); })()`;
}

async function evalInTab(tabId, code, awaitPromise, evalId) {
  /*
    * executes only for iframes by bypassing the CORS issue
    * so this implementatiton is something
    * first we'll get every single frames from the tab
    * then parse an special const name `IFRAMESELCTOR` from raw js code to
      get the selector of iframe from main document
    * after that we'll get the `frameId` of the iframe to execute
      raw js code inside the iframe's document to avoid CORS issue
    * rewrite the raw js code so it removes the unneccesary `IFRAMESELCTOR` from eval code
    * run user code safely by creating a Function rather than eval (still executes arbitrary code)
  */
  if (code.includes("IFRAMESELCTOR")) {
    const frames = await chrome.webNavigation.getAllFrames({ tabId });
    log("Frames seen by extension:", frames);

    const regex =
      /const\s+IFRAMESELCTOR\s*=\s*['"`]?\s*(querySelector|getElementById)\s*\(\s*(['"`])(.*?)\2\s*\)\s*;?\s*['"`]?/s;
    const match = code.match(regex);
    const iframeInfo = {
      method: match[1],
      selector: match[3],
    };
    if (!match) {
      throw new Error(`No selector named 'IFRAMESELCTOR' have been defined please define
       this variable to execute code inside in iframe's document context`);
    }

    if (iframeInfo) {
      const iframeSelector = iframeInfo.selector;
      if (iframeSelector) {
        log(
          `Executing in given iframe of selector: ${iframeSelector}, selector type: ${iframeInfo.method}`,
        );
        if (!attachedTabs.has(tabId)) {
          await debuggerAttach(tabId);
          attachedTabs.add(tabId);
          await chrome.storage.session.set({ attached: [...attachedTabs] });
          log(`Debugger attached to tab '${tabId}' for iframe evaluation`);
        }

        let frameId;
        try {
          await sendCommand(tabId, "Page.enable", {});
          await sendCommand(tabId, "DOM.enable", {});
          const { root } = await sendCommand(tabId, "DOM.getDocument", {
            depth: -1,
          });
          const { nodeId } = await sendCommand(tabId, "DOM.querySelector", {
            nodeId: root.nodeId,
            selector: iframeSelector,
          });

          if (!nodeId) {
            throw new Error(
              `Iframe with selector "${iframeSelector}" not found.`,
            );
          }
          const { node } = await sendCommand(tabId, "DOM.describeNode", {
            nodeId,
          });
          if (!node) {
            throw new Error(
              `Could not retrieve node info for the specified iframe, selector ${iframeInfo.selector}`,
            );
          }

          /* now here we've to get the actual correct `frameId` from by matching
             the `src` attributes of iframe to the all the existing iframe on that opened tab
          */
          const iframeSrc =
            node.attributes?.[node.attributes.indexOf("src") + 1];
          log("iframeSrc", iframeSrc);
          const match = frames.find((f) => {
            try {
              const u1 = new URL(f.url);
              const u2 = new URL(iframeSrc);
              const host1 = u1.hostname.replace(/^www\./, "").toLowerCase();
              const host2 = u2.hostname.replace(/^www\./, "").toLowerCase();
              if (host1 !== host2) return false;
              const p1 = u1.pathname.split("/").filter(Boolean);
              const p2 = u2.pathname.split("/").filter(Boolean);
              for (let i = 0; i < Math.min(3, p1.length, p2.length); i++) {
                if (p1[i] !== p2[i]) return false;
              }
              return true;
            } catch {
              return false;
            }
          });
          frameId = match.frameId;
          log(`matched frameId: ${match.frameId}`);
        } catch (err) {
          log("Error finding frame:", err);
          try {
            await debuggerDetach(tabId);
          } catch (_) {}
          attachedTabs.delete(tabId);
          throw err;
        }

        const lines = code
          .split("\n")
          .filter((line) => !line.includes("IFRAMESELCTOR"));
        const rewritten = lines.join("\n");
        log(`Rewritten code for iframe: ${rewritten}`);

        /* execute the rewritten code inside the found frame */
        try {
          const results = await chrome.scripting.executeScript({
            target: { tabId: tabId, frameIds: [frameId] },
            world: "MAIN",
            func: (userScript, shouldAwait) => {
              return (async () => {
                const fn = new Function(userScript);
                const result = fn();
                if (shouldAwait && result instanceof Promise) {
                  return await result;
                }
                return result;
              })();
            },
            args: [rewritten, !!awaitPromise],
          });

          if (!results || results.length === 0) {
            throw new Error("Script execution in frame produced no result.");
          }
          return results[0].result;
        } catch (err) {
          log(`Error executing script in frame ${frameId}:`, err);
          throw err;
        }
      }
    }
  }

  const perfStart = performance.now();
  const timings = {};

  // Auto-detect async IIFEs and set awaitPromise accordingly
  const originalCode = code;
  if (isAsyncIIFE(originalCode)) {
    log("Detected async IIFE, forcing awaitPromise=true");
    awaitPromise = true;
  }

  // Auto-detect and wrap code with top-level returns
  code = wrapCodeIfNeeded(code);

  // Only attach if we haven't before
  if (!attachedTabs.has(tabId)) {
    const attachStart = performance.now();
    try {
      await debuggerAttach(tabId);
      attachedTabs.add(tabId);
      // Persist (fire and forget)
      chrome.storage.session.set({ attached: [...attachedTabs] });
      timings.attach = performance.now() - attachStart;
      log(`Debugger attached to tab ${tabId} (${timings.attach.toFixed(1)}ms)`);
    } catch (e) {
      // If already attached by another concurrent operation, treat as attached
      if (e.message && e.message.includes("already attached")) {
        log(
          `Tab ${tabId} already attached by another operation, treating as success`,
        );
        attachedTabs.add(tabId);
        chrome.storage.session.set({ attached: [...attachedTabs] });
        timings.attach = performance.now() - attachStart;
      } else {
        // If we can't attach, we can't continue - throw the error
        log(`Could not attach to tab ${tabId}:`, e.message);
        throw new Error(`Failed to attach debugger: ${e.message}`);
      }
    }
  } else {
    // Verify the debugger is actually still attached by checking Chrome's debugger API
    // We need to check if the debugger is attached BEFORE trying any commands
    try {
      // First, check if debugger is still attached using Chrome's getTargets API
      // If this fails, we know the debugger is detached
      const targets = await new Promise((resolve, reject) => {
        chrome.debugger.getTargets((targets) => {
          if (chrome.runtime.lastError) {
            reject(chrome.runtime.lastError);
          } else {
            resolve(targets);
          }
        });
      });

      const isAttached = targets.some(
        (target) => target.tabId === tabId && target.attached,
      );

      if (!isAttached) {
        // Debugger was detached (e.g., by navigation or user canceling)
        log(
          `Debugger was detached from tab ${tabId} (detected via getTargets), reattaching...`,
        );
        attachedTabs.delete(tabId);
        enabledTabs.delete(tabId);

        const attachStart = performance.now();
        try {
          await debuggerAttach(tabId);
          attachedTabs.add(tabId);
          chrome.storage.session.set({ attached: [...attachedTabs] });
          timings.attach = performance.now() - attachStart;
          log(
            `Debugger reattached to tab ${tabId} (${timings.attach.toFixed(1)}ms)`,
          );
        } catch (attachError) {
          // If already attached by another concurrent operation, treat as attached
          if (
            attachError.message &&
            attachError.message.includes("already attached")
          ) {
            log(
              `Tab ${tabId} already attached by another operation, treating as success`,
            );
            attachedTabs.add(tabId);
            chrome.storage.session.set({ attached: [...attachedTabs] });
            timings.attach = performance.now() - attachStart;
          } else {
            log(`Failed to reattach to tab ${tabId}:`, attachError.message);
            throw new Error(
              `Failed to reattach debugger: ${attachError.message}`,
            );
          }
        }
      } else {
        // Debugger is still attached, verify with a simple command
        try {
          await sendCommand(tabId, "Runtime.evaluate", {
            expression: "1",
            returnByValue: true,
          });
          log(`Reusing existing debugger for tab ${tabId}`);
          timings.attach = 0;
        } catch (cmdError) {
          // Command failed even though debugger appeared attached
          // This can happen if domains need to be re-enabled
          log(
            `Command failed for tab ${tabId}, may need domain re-enable: ${cmdError.message}`,
          );
          // Mark domains as needing re-enable (handled in next section)
          enabledTabs.delete(tabId);
          timings.attach = 0;
        }
      }
    } catch (e) {
      // getTargets failed, fall back to trying a command
      log(
        `getTargets check failed for tab ${tabId}, trying command: ${e.message}`,
      );
      try {
        await sendCommand(tabId, "Runtime.evaluate", {
          expression: "1",
          returnByValue: true,
        });
        log(`Reusing existing debugger for tab ${tabId} (fallback path)`);
        timings.attach = 0;
      } catch (cmdError) {
        // Debugger was likely detached, need to reattach
        log(`Debugger was detached from tab ${tabId}, reattaching...`);
        attachedTabs.delete(tabId);
        enabledTabs.delete(tabId);

        const attachStart = performance.now();
        try {
          await debuggerAttach(tabId);
          attachedTabs.add(tabId);
          chrome.storage.session.set({ attached: [...attachedTabs] });
          timings.attach = performance.now() - attachStart;
          log(
            `Debugger reattached to tab ${tabId} (${timings.attach.toFixed(1)}ms)`,
          );
        } catch (attachError) {
          // If already attached by another concurrent operation, treat as attached
          if (
            attachError.message &&
            attachError.message.includes("already attached")
          ) {
            log(
              `Tab ${tabId} already attached by another operation, treating as success`,
            );
            attachedTabs.add(tabId);
            chrome.storage.session.set({ attached: [...attachedTabs] });
            timings.attach = performance.now() - attachStart;
          } else {
            log(`Failed to reattach to tab ${tabId}:`, attachError.message);
            throw new Error(
              `Failed to reattach debugger: ${attachError.message}`,
            );
          }
        }
      }
    }
  }

  let onEvent = null;
  try {
    // Only enable domains if not already enabled
    if (!enabledTabs.has(tabId)) {
      const enableStart = performance.now();
      try {
        const runtimeStart = performance.now();
        await sendCommand(tabId, "Runtime.enable", {});
        timings.runtimeEnable = performance.now() - runtimeStart;

        const logStart = performance.now();
        await sendCommand(tabId, "Log.enable", {});
        timings.logEnable = performance.now() - logStart;

        enabledTabs.add(tabId);
        timings.totalEnable = performance.now() - enableStart;
        log(
          `Domains enabled for tab ${tabId} - Runtime: ${timings.runtimeEnable.toFixed(1)}ms, Log: ${timings.logEnable.toFixed(1)}ms, Total: ${timings.totalEnable.toFixed(1)}ms`,
        );
      } catch (e) {
        const errorMsg = e.message || String(e);
        // Check if error is due to debugger being detached
        if (errorMsg.includes("Debugger is not attached")) {
          log(
            `Debugger was detached from tab ${tabId} during domain enable, reattaching...`,
          );
          // Clear state and reattach
          attachedTabs.delete(tabId);
          enabledTabs.delete(tabId);

          try {
            // Reattach the debugger
            await debuggerAttach(tabId);
            attachedTabs.add(tabId);
            chrome.storage.session.set({ attached: [...attachedTabs] });
            log(`Successfully reattached debugger to tab ${tabId}`);

            // Now try to enable domains again
            const runtimeStart = performance.now();
            await sendCommand(tabId, "Runtime.enable", {});
            timings.runtimeEnable = performance.now() - runtimeStart;

            const logStart = performance.now();
            await sendCommand(tabId, "Log.enable", {});
            timings.logEnable = performance.now() - logStart;

            enabledTabs.add(tabId);
            timings.totalEnable = performance.now() - enableStart;
            log(
              `Domains enabled after reattach for tab ${tabId} - Runtime: ${timings.runtimeEnable.toFixed(1)}ms, Log: ${timings.logEnable.toFixed(1)}ms, Total: ${timings.totalEnable.toFixed(1)}ms`,
            );
          } catch (reattachError) {
            log(
              `Failed to reattach and enable domains for tab ${tabId}:`,
              reattachError.message,
            );
            // Clean up state
            attachedTabs.delete(tabId);
            enabledTabs.delete(tabId);
            try {
              await debuggerDetach(tabId);
            } catch (_) {}
            throw new Error(
              `Failed to reattach debugger and enable domains: ${reattachError.message}`,
            );
          }
        } else {
          // Different error, not related to detachment
          log(`Could not enable domains for tab ${tabId}:`, e.message);
          // Clear the tab from tracking since it's in a bad state
          attachedTabs.delete(tabId);
          enabledTabs.delete(tabId);
          // Try to detach and clean up
          try {
            await debuggerDetach(tabId);
          } catch (_) {}
          // Throw the error to trigger retry logic at the higher level
          throw new Error(`Failed to enable debugger domains: ${e.message}`);
        }
      }
    } else {
      // Verify domains are actually still enabled by testing a simple command
      try {
        // Quick test to verify Runtime domain is still active
        await sendCommand(tabId, "Runtime.evaluate", {
          expression: "1",
          returnByValue: true,
        });
        log(`Reusing enabled domains for tab ${tabId}`);
        timings.runtimeEnable = 0;
        timings.logEnable = 0;
        timings.totalEnable = 0;
      } catch (e) {
        // Domains were disabled (debugger detached), need to re-enable
        log(`Domains were disabled for tab ${tabId}, re-enabling...`);
        enabledTabs.delete(tabId);

        const enableStart = performance.now();
        try {
          const runtimeStart = performance.now();
          await sendCommand(tabId, "Runtime.enable", {});
          timings.runtimeEnable = performance.now() - runtimeStart;

          const logStart = performance.now();
          await sendCommand(tabId, "Log.enable", {});
          timings.logEnable = performance.now() - logStart;

          enabledTabs.add(tabId);
          timings.totalEnable = performance.now() - enableStart;
          log(
            `Domains re-enabled for tab ${tabId} - Runtime: ${timings.runtimeEnable.toFixed(1)}ms, Log: ${timings.logEnable.toFixed(1)}ms, Total: ${timings.totalEnable.toFixed(1)}ms`,
          );
        } catch (enableError) {
          // Check if error is due to debugger being detached
          const errorMsg = enableError.message || String(enableError);
          if (errorMsg.includes("Debugger is not attached")) {
            log(
              `Debugger was detached from tab ${tabId}, need to reattach before enabling domains`,
            );
            // Clear state and reattach
            attachedTabs.delete(tabId);
            enabledTabs.delete(tabId);

            try {
              // Reattach the debugger
              await debuggerAttach(tabId);
              attachedTabs.add(tabId);
              chrome.storage.session.set({ attached: [...attachedTabs] });
              log(`Successfully reattached debugger to tab ${tabId}`);

              // Now try to enable domains again
              const runtimeStart = performance.now();
              await sendCommand(tabId, "Runtime.enable", {});
              timings.runtimeEnable = performance.now() - runtimeStart;

              const logStart = performance.now();
              await sendCommand(tabId, "Log.enable", {});
              timings.logEnable = performance.now() - logStart;

              enabledTabs.add(tabId);
              timings.totalEnable = performance.now() - enableStart;
              log(
                `Domains enabled after reattach for tab ${tabId} - Runtime: ${timings.runtimeEnable.toFixed(1)}ms, Log: ${timings.logEnable.toFixed(1)}ms, Total: ${timings.totalEnable.toFixed(1)}ms`,
              );
            } catch (reattachError) {
              log(
                `Failed to reattach and enable domains for tab ${tabId}:`,
                reattachError.message,
              );
              // Clean up state
              attachedTabs.delete(tabId);
              enabledTabs.delete(tabId);
              try {
                await debuggerDetach(tabId);
              } catch (_) {}
              throw new Error(
                `Failed to reattach debugger and enable domains: ${reattachError.message}`,
              );
            }
          } else {
            // Different error, not related to detachment
            log(
              `Could not re-enable domains for tab ${tabId}:`,
              enableError.message,
            );
            // Clear the tab from tracking since it's in a bad state
            attachedTabs.delete(tabId);
            enabledTabs.delete(tabId);
            // Try to detach and clean up
            try {
              await debuggerDetach(tabId);
            } catch (_) {}
            // Throw the error to trigger retry logic at the higher level
            throw new Error(
              `Failed to re-enable debugger domains: ${enableError.message}`,
            );
          }
        }
      }
    }

    // Listen for console/log/exception events for this tab while the eval runs
    onEvent = (source, method, params) => {
      try {
        if (!source || source.tabId !== tabId) return;
        if (method === "Runtime.consoleAPICalled") {
          const level = params.type || "log";
          const args = (params.args || []).map((a) => formatRemoteObject(a));
          const stackTrace = params.stackTrace || null;
          safeSend({
            type: "console_event",
            id: evalId,
            level,
            args,
            stackTrace,
            ts: params.timestamp || Date.now(),
          });
        } else if (method === "Runtime.exceptionThrown") {
          safeSend({
            type: "exception_event",
            id: evalId,
            details: params.exceptionDetails || params || null,
          });
        } else if (method === "Log.entryAdded") {
          safeSend({
            type: "log_event",
            id: evalId,
            entry: params.entry || params || null,
          });
        }
      } catch (e) {
        // swallow
      }
    };
    chrome.debugger.onEvent.addListener(onEvent);

    const evalStart = performance.now();
    let evalResult;
    let retryWithWrapper = false;

    try {
      evalResult = await sendCommand(tabId, "Runtime.evaluate", {
        expression: code,
        awaitPromise: !!awaitPromise,
        returnByValue: true,
        userGesture: true,
      });
    } catch (error) {
      // If sendCommand itself fails (not script error), re-throw
      throw error;
    }

    let { result, exceptionDetails } = evalResult;
    timings.evaluate = performance.now() - evalStart;

    // Check if we got "Illegal return statement" error and haven't wrapped yet
    if (
      exceptionDetails &&
      code !== originalCode && // Already wrapped, don't retry
      (exceptionDetails.text?.includes("Illegal return statement") ||
        exceptionDetails.exception?.description?.includes(
          "Illegal return statement",
        ))
    ) {
      // This shouldn't happen since we already wrapped, but log it
      log("Still got 'Illegal return statement' after wrapping, not retrying");
    } else if (
      exceptionDetails &&
      code === originalCode && // Not wrapped yet
      (exceptionDetails.text?.includes("Illegal return statement") ||
        exceptionDetails.exception?.description?.includes(
          "Illegal return statement",
        ))
    ) {
      // Our detection missed it, retry with wrapper
      log("Got 'Illegal return statement' error, retrying with IIFE wrapper");
      retryWithWrapper = true;
    }

    // Retry with wrapper if needed
    if (retryWithWrapper) {
      const wrappedCode = `(function() {\n${originalCode}\n})()`;
      const retryStart = performance.now();

      evalResult = await sendCommand(tabId, "Runtime.evaluate", {
        expression: wrappedCode,
        awaitPromise: !!awaitPromise,
        returnByValue: true,
        userGesture: true,
      });

      ({ result, exceptionDetails } = evalResult);
      timings.evaluateRetry = performance.now() - retryStart;
      timings.evaluate += timings.evaluateRetry;
      log(`Retry with wrapper took ${timings.evaluateRetry.toFixed(1)}ms`);
    }

    if (exceptionDetails) {
      // Build rich error details for MCP side
      const details = {
        text: exceptionDetails.text,
        url: exceptionDetails.url,
        lineNumber: exceptionDetails.lineNumber,
        columnNumber: exceptionDetails.columnNumber,
        exception:
          (exceptionDetails.exception &&
            (exceptionDetails.exception.description ||
              exceptionDetails.exception.value)) ||
          null,
        stackTrace:
          (exceptionDetails.stackTrace &&
            Array.isArray(exceptionDetails.stackTrace.callFrames) &&
            exceptionDetails.stackTrace.callFrames.map((cf) => ({
              functionName: cf.functionName,
              url: cf.url,
              lineNumber: cf.lineNumber,
              columnNumber: cf.columnNumber,
            }))) ||
          null,
      };
      // Emit console error for visibility in extension worker logs
      console.error("[ComputerUseBridge] Eval exception:", details);
      // Throw a JSON-encoded error so the bridge returns full context
      throw new Error(
        JSON.stringify({
          code: "EVAL_ERROR",
          message: details.text || "Evaluation error",
          details,
        }),
      );
    }

    // Log timing summary
    timings.total = performance.now() - perfStart;
    log(
      `[TIMING] Total: ${timings.total.toFixed(1)}ms | Attach: ${timings.attach.toFixed(1)}ms | Enable: ${timings.totalEnable.toFixed(1)}ms | Eval: ${timings.evaluate.toFixed(1)}ms`,
    );

    // Return JSON-serializable value
    // Check if result is null or undefined - these should be treated as errors
    const resultValue = result?.value;
    if (resultValue === null || resultValue === undefined) {
      // Throw an error to trigger workflow fallback_id behavior
      throw new Error(
        JSON.stringify({
          code: "NULL_RESULT",
          message: "JavaScript execution returned null or undefined",
          details: {
            text: "Script returned null/undefined value",
            resultType: resultValue === null ? "null" : "undefined",
          },
        }),
      );
    }
    return resultValue;
  } finally {
    try {
      // Best-effort: remove onEvent listener
      if (
        onEvent &&
        chrome &&
        chrome.debugger &&
        chrome.debugger.onEvent &&
        chrome.debugger.onEvent.removeListener
      ) {
        chrome.debugger.onEvent.removeListener(onEvent);
      }
      // DON'T DISABLE DOMAINS - Keep them enabled for reuse
      // Removed: await sendCommand(tabId, "Log.disable", {});
      // Removed: await sendCommand(tabId, "Runtime.disable", {});
    } catch (_) {}
    // DON'T DETACH - Keep debugger attached for reuse
    // This was: await debuggerDetach(tabId);
  }
}

function debuggerAttach(tabId) {
  return new Promise((resolve, reject) => {
    chrome.debugger.attach({ tabId }, "1.3", (err) => {
      if (chrome.runtime.lastError) return reject(chrome.runtime.lastError);
      resolve();
    });
  });
}

function debuggerDetach(tabId) {
  return new Promise((resolve) => {
    chrome.debugger.detach({ tabId }, () => resolve());
  });
}

function sendCommand(tabId, method, params) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params, (result) => {
      const err = chrome.runtime.lastError;
      if (err) return reject(err);
      resolve(result || {});
    });
  });
}

// Recording session management
let recordingSessionId = null;

async function startRecordingSession(sessionId) {
  recordingSessionId = sessionId;
  log(`Started recording session: ${sessionId}`);
  // Could inject content scripts here if needed
  return { sessionId, status: "recording" };
}

async function stopRecordingSession(sessionId) {
  if (recordingSessionId === sessionId) {
    recordingSessionId = null;
    log(`Stopped recording session: ${sessionId}`);
  }
  return { sessionId, status: "stopped" };
}

// DOM element capture for recording
async function captureElementAtPoint(tabId, x, y, captureId) {
  const code = `(function() {
    const x = ${x};
    const y = ${y};

    // Get element at coordinates
    const element = document.elementFromPoint(x, y);
    if (!element) {
      return { error: 'No element at coordinates', x: x, y: y };
    }

    // Generate selector candidates
    function generateSelectors(el) {
      const selectors = [];

      // 1. ID selector (highest priority)
      if (el.id) {
        selectors.push({
          selector: '#' + CSS.escape(el.id),
          selector_type: 'Id',
          specificity: 100,
          requires_jquery: false
        });
      }

      // 2. Data attributes
      const dataAttrs = Array.from(el.attributes)
        .filter(attr => attr.name.startsWith('data-'))
        .map(attr => ({
          selector: '[' + attr.name + '="' + CSS.escape(attr.value) + '"]',
          selector_type: 'DataAttribute',
          specificity: 90,
          requires_jquery: false
        }));
      selectors.push(...dataAttrs);

      // 3. Aria label
      if (el.getAttribute('aria-label')) {
        selectors.push({
          selector: '[aria-label="' + CSS.escape(el.getAttribute('aria-label')) + '"]',
          selector_type: 'AriaLabel',
          specificity: 85,
          requires_jquery: false
        });
      }

      // 4. Class combinations
      if (el.className && typeof el.className === 'string') {
        const classes = el.className.split(' ').filter(c => c);
        if (classes.length > 0) {
          selectors.push({
            selector: '.' + classes.map(c => CSS.escape(c)).join('.'),
            selector_type: 'Class',
            specificity: 70,
            requires_jquery: false
          });
        }
      }

      // 5. Text content for buttons/links
      if (['button', 'a'].includes(el.tagName.toLowerCase())) {
        const text = el.textContent.trim();
        if (text && text.length < 50) {
          selectors.push({
            selector: el.tagName.toLowerCase() + ':contains("' + text + '")',
            selector_type: 'Text',
            specificity: 60,
            requires_jquery: true
          });
        }
      }

      // 6. Generate XPath
      function getXPath(element) {
        if (element.id) {
          return '//*[@id="' + element.id + '"]';
        }

        const parts = [];
        while (element && element.nodeType === Node.ELEMENT_NODE) {
          let index = 1;
          let sibling = element.previousElementSibling;
          while (sibling) {
            if (sibling.tagName === element.tagName) index++;
            sibling = sibling.previousElementSibling;
          }
          const tagName = element.tagName.toLowerCase();
          const part = tagName + '[' + index + ']';
          parts.unshift(part);
          element = element.parentElement;
        }
        return '/' + parts.join('/');
      }

      selectors.push({
        selector: getXPath(el),
        selector_type: 'XPath',
        specificity: 40,
        requires_jquery: false
      });

      // 7. CSS path (most specific, least maintainable)
      function getCSSPath(el) {
        const path = [];
        while (el && el.nodeType === Node.ELEMENT_NODE) {
          let selector = el.tagName.toLowerCase();
          if (el.id) {
            selector = '#' + CSS.escape(el.id);
            path.unshift(selector);
            break;
          } else if (el.className && typeof el.className === 'string') {
            const classes = el.className.split(' ').filter(c => c);
            if (classes.length > 0) {
              selector += '.' + classes.map(c => CSS.escape(c)).join('.');
            }
          }
          path.unshift(selector);
          el = el.parentElement;
        }
        return path.join(' > ');
      }

      selectors.push({
        selector: getCSSPath(el),
        selector_type: 'CssPath',
        specificity: 30,
        requires_jquery: false
      });

      return selectors;
    }

    // Capture element information
    const rect = element.getBoundingClientRect();
    const computedStyle = window.getComputedStyle(element);

    // Get all attributes as a map
    const attributes = {};
    for (const attr of element.attributes) {
      attributes[attr.name] = attr.value;
    }

    // Get class names as array
    const classNames = element.className
      ? (typeof element.className === 'string'
          ? element.className.split(' ').filter(c => c)
          : [])
      : [];

    return {
      tag_name: element.tagName.toLowerCase(),
      id: element.id || null,
      class_names: classNames,
      attributes: attributes,
      css_selector: getCSSPath(element),
      xpath: getXPath(element),
      inner_text: element.innerText ? element.innerText.substring(0, 100) : null,
      input_value: element.value || null,
      bounding_rect: {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        top: rect.top,
        left: rect.left
      },
      is_visible: computedStyle.display !== 'none' &&
                 computedStyle.visibility !== 'hidden' &&
                 computedStyle.opacity !== '0',
      is_interactive: !element.disabled &&
                     computedStyle.pointerEvents !== 'none',
      computed_role: element.getAttribute('role') || null,
      aria_label: element.getAttribute('aria-label') || null,
      placeholder: element.placeholder || null,
      selector_candidates: generateSelectors(element),
      page_context: {
        url: window.location.href,
        title: document.title,
        domain: window.location.hostname
      },
      capture_id: '${captureId}'
    };
  })()`;

  try {
    const result = await evalInTab(tabId, code, false, captureId);
    log(`Captured DOM element at (${x}, ${y}):`, result);
    return result;
  } catch (err) {
    log(`Failed to capture DOM element at (${x}, ${y}):`, err);
    throw err;
  }
}

// Close a browser tab safely with multiple identification options
async function closeTab(requestedTabId, targetUrl, targetTitle) {
  log(`closeTab called: tabId=${requestedTabId}, url=${targetUrl}, title=${targetTitle}`);

  let tabToClose = null;

  // 1. Try to find tab by ID first
  if (requestedTabId != null && typeof requestedTabId === "number") {
    try {
      tabToClose = await chrome.tabs.get(requestedTabId);
      log(`Found tab by ID: ${tabToClose.id}`);
    } catch (e) {
      log(`Tab ID ${requestedTabId} not found: ${e.message}`);
    }
  }

  // 2. Try to find tab by URL
  if (!tabToClose && targetUrl) {
    const tabs = await chrome.tabs.query({});
    tabToClose = tabs.find(t => t.url === targetUrl || t.url?.includes(targetUrl));
    if (tabToClose) log(`Found tab by URL: id=${tabToClose.id}`);
  }

  // 3. Try to find tab by title
  if (!tabToClose && targetTitle) {
    const tabs = await chrome.tabs.query({});
    tabToClose = tabs.find(t => t.title?.toLowerCase().includes(targetTitle.toLowerCase()));
    if (tabToClose) log(`Found tab by title: id=${tabToClose.id}`);
  }

  // 4. Fall back to active tab
  if (!tabToClose) {
    const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (activeTab) {
      tabToClose = activeTab;
      log(`Using active tab: id=${tabToClose.id}`);
    }
  }

  if (!tabToClose) throw new Error("No tab found to close");

  // Safety: don't close extension pages
  if (tabToClose.url?.startsWith("chrome://") ||
      tabToClose.url?.startsWith("chrome-extension://") ||
      tabToClose.url?.startsWith("edge://") ||
      tabToClose.url?.startsWith("about:")) {
    throw new Error(`Cannot close protected page: ${tabToClose.url}`);
  }

  // Clean up debugger state
  if (attachedTabs.has(tabToClose.id)) {
    try { await debuggerDetach(tabToClose.id); } catch (e) {}
    attachedTabs.delete(tabToClose.id);
    enabledTabs.delete(tabToClose.id);
  }

  const closedTabInfo = {
    id: tabToClose.id,
    url: tabToClose.url,
    title: tabToClose.title,
    windowId: tabToClose.windowId,
  };

  await chrome.tabs.remove(tabToClose.id);
  log(`Closed tab: id=${closedTabInfo.id}, url=${closedTabInfo.url}`);

  return { closed: true, tab: closedTabInfo };
}

connect();