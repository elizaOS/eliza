/**
 * api-base-owner — single source of truth for the renderer's API base URL.
 *
 * The renderer ("the WebView") needs a stable answer to "what loopback
 * port is the agent API listening on?". Five sites used to push this
 * answer independently:
 *   1. HTML inject before any renderer JS runs (static-server path)
 *   2. RPC push from `handleHomeWindowAgentReady`
 *   3. RPC push from a runtime-mode change handler
 *   4. RPC push from desktop-session priming
 *   5. RPC push from the menu-action runtime restart handler
 *
 * Each site decided independently when to push and what value to push.
 * The five copies were the disease behind the port-shift renderer
 * disconnect MASTER.md §0 documents; until *one* module owns the value
 * the renderer is reading, every new push site is a fresh chance to ship
 * the wrong port.
 *
 * This module owns:
 *   - the *current* API base + token (module singleton)
 *   - the HTML inject snippet for the static server
 *   - the per-window push (delegates to the existing
 *     `pushApiBaseToRenderer` RPC plumbing in `../api-base.ts`)
 *
 * Callers say `setCurrent(base, token)` to update, then either inject
 * via `injectIntoHtml(html)` (production static server) or push via
 * `pushToWindow(win)` (any time after a window mounts). The HTML inject
 * AND the RPC push read the same singleton, so the renderer can never
 * see two sources of truth.
 */

import {
  normalizeApiBase,
  pushApiBaseToRenderer,
  resolveDesktopRuntimeMode,
  resolveDesktopRuntimeModeSignal,
} from "../api-base";
import { getStartupTraceConfig } from "../startup-trace";

interface ApiBaseSnapshot {
  base: string | null;
  token: string;
}

let current: ApiBaseSnapshot = { base: null, token: "" };

function safeJsonForHtml(value: unknown): string {
  return JSON.stringify(value).replace(/<\//g, "<\\/");
}

function resolveStartupTraceId(): string | null {
  return getStartupTraceConfig().sessionId;
}

function resolveCurrentExternalApiBase(): string | null {
  const runtime = resolveDesktopRuntimeMode(process.env);
  if (runtime.mode === "external" && runtime.externalApi.base) {
    return runtime.externalApi.base;
  }
  const currentBase = normalizeApiBase(current.base ?? undefined);
  if (!currentBase) return null;
  try {
    const parsed = new URL(currentBase);
    const hostname = parsed.hostname.toLowerCase();
    if (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      hostname !== "localhost" &&
      hostname !== "127.0.0.1" &&
      hostname !== "::1" &&
      hostname !== "[::1]"
    ) {
      return parsed.origin;
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Update the singleton with the latest known API base + token. Subsequent
 * `injectIntoHtml(...)` and `pushToWindow(...)` calls read this state.
 *
 * Call this at every point where the desktop main process learns the
 * API has bound a port — after `resolveInitialApiBase`, after the
 * agent supervisor confirms ready, after a runtime-mode change, etc.
 */
export function setCurrent(base: string | null, token: string = ""): void {
  current = { base, token };
}

/** Read the current snapshot — for tests + diagnostic logging. */
export function getCurrent(): Readonly<ApiBaseSnapshot> {
  return current;
}

/**
 * Inject the current API base + token into HTML before the first
 * renderer JS runs. Returns the HTML unchanged if no base is set yet.
 *
 * Sets the API base legacy key plus the typed boot config:
 *   - `window.__ELIZA_API_BASE__` (legacy global the appClient reads)
 *   - `window.__ELIZAOS_APP_BOOT_CONFIG__` / `__ELIZA_APP_BOOT_CONFIG__`
 *     plus the `Symbol.for("elizaos.app.boot-config")` slot (typed
 *     boot config that SettingsView reads)
 *
 * Without the boot-config keys, the same renderer loaded via a regular
 * browser at the static-server's origin falls back to `pageOrigin` for
 * apiBase and every `/api/*` call returns SPA HTML.
 */
export function injectIntoHtml(html: string): string {
  const startupTraceId = resolveStartupTraceId();
  const startupTraceInject = startupTraceId
    ? `window.__ELIZA_STARTUP_TRACE_ID__=${safeJsonForHtml(startupTraceId)};`
    : "";
  if (!current.base && !startupTraceInject) return html;

  let apiBaseInject = "";
  if (current.base) {
    const baseLiteral = safeJsonForHtml(current.base);
    const tokenLiteral = current.token ? safeJsonForHtml(current.token) : "";
    const bootConfigInject = `(function(){var k=Symbol.for("elizaos.app.boot-config"),w=window,prev=w.__ELIZAOS_APP_BOOT_CONFIG__||w.__ELIZA_APP_BOOT_CONFIG__||(w[k]&&w[k].current)||{},next=Object.assign({},prev,{apiBase:${baseLiteral}${tokenLiteral ? `,apiToken:${tokenLiteral}` : ""}});w.__ELIZAOS_APP_BOOT_CONFIG__=next;w.__ELIZA_APP_BOOT_CONFIG__=next;w[k]={current:next};})();`;
    // Desktop cloud-only opt-in: expose the runtime-mode signal as a window global
    // before any renderer JS runs, so the renderer's cloud-only branding
    // (shouldUseCloudOnlyBranding) resolves correctly at module-eval time. Only
    // injected when explicitly cloud, so the default desktop/web behavior is
    // unchanged.
    const runtimeModeSignal = resolveDesktopRuntimeModeSignal(process.env);
    const runtimeModeInject = runtimeModeSignal
      ? `window.__ELIZA_DESKTOP_RUNTIME_MODE__=${safeJsonForHtml(runtimeModeSignal)};`
      : "";
    const externalApiBase = resolveCurrentExternalApiBase();
    const externalApiBaseInject = externalApiBase
      ? `window.__ELIZA_DESKTOP_EXTERNAL_API_BASE__=${safeJsonForHtml(externalApiBase)};`
      : "";
    apiBaseInject = `window.__ELIZA_API_BASE__=${baseLiteral};${runtimeModeInject}${externalApiBaseInject}${bootConfigInject}`;
  }

  const script = `<script>${startupTraceInject}${apiBaseInject}</script>`;
  if (html.includes("</head>")) {
    return html.replace("</head>", `${script}</head>`);
  }
  if (html.includes("<body")) {
    return html.replace("<body", `${script}<body`);
  }
  return script + html;
}

/**
 * Push the current snapshot to one window via the RPC bridge. No-op if
 * no base has been set yet (the receiving renderer would not know what
 * to do with `null`). For broadcasting to multiple windows, callers
 * should iterate their window registry and call this per window.
 */
export function pushToWindow(win: { webview: { rpc?: unknown } }): void {
  if (!current.base) return;
  pushApiBaseToRenderer(
    win,
    current.base,
    current.token || undefined,
    resolveCurrentExternalApiBase(),
  );
}

/**
 * Convenience: setCurrent + pushToWindow in one call. Use at the four
 * RPC push sites in `../index.ts` that previously called
 * `pushApiBaseToRenderer(win, base, token)` directly.
 */
export function notifyChange(
  win: { webview: { rpc?: unknown } },
  base: string | null,
  token: string = "",
): void {
  setCurrent(base, token);
  pushToWindow(win);
}
