/**
 * Same-origin API + WebSocket base repair for the PLAIN-WEB served bundle.
 *
 * Context: when the app is served by the Vite dev server as a plain browser page
 * (NOT the electrobun desktop shell, NOT a Capacitor native webview), the dev
 * `appDevWsBasePlugin` injects `window.__ELIZA_WS_BASE__ = "ws://127.0.0.1:<apiPort>"`
 * into the served HTML (apiPort defaults to 31337, the desktop loopback API).
 *
 * `client-base.ts` `getInjectedWsBase()` reads that global FIRST — before it
 * would otherwise derive the socket host from `window.location`. So even with an
 * empty (same-origin) REST base, the realtime socket dials the dead desktop
 * loopback `ws://127.0.0.1:31337/ws`, which is refused, and live chat never
 * connects.
 *
 * When the page is actually served over http/https from a real remote host that
 * a reverse proxy (nginx) fronts — proxying `/ws` and `/api` to the backend with
 * auth injected — the correct socket target is same-origin
 * `wss://<location.host>/ws` and REST is same-origin `/api`.
 *
 * Two things must be corrected for the plain-web path, both UPSTREAM of the
 * DO-NOT-EDIT client-base.ts:
 *
 *   1. WS base: rewrite the injected desktop-loopback `__ELIZA_WS_BASE__` to
 *      same-origin `wss://<host>` so `getInjectedWsBase()` resolves the correct
 *      socket host.
 *
 *   2. REST base: set `__ELIZA_API_BASE__` to same-origin `https://<host>` so
 *      `this.baseUrl` is NON-EMPTY. This is required because client-base's
 *      `connectWs()` has a guard that BAILS when `baseUrl` is empty AND the page
 *      host has no port and isn't loopback (a Capacitor synthetic-host
 *      protection). A plain remote https host like `sol-overhaul.shad0w.xyz`
 *      (portless, non-loopback) trips that guard, so an empty REST base leaves
 *      the socket un-opened even with a correct WS base. A same-origin absolute
 *      REST base is equivalent to relative `/api` (nginx proxies it with the
 *      injected auth header) and makes the guard pass so the socket opens.
 *
 * Scope: the WS base is set via the `__ELIZA_WS_BASE__` / `__ELIZAOS_WS_BASE__`
 * window globals that client-base's `getInjectedWsBase()` still reads directly.
 * The REST base is set via `setElizaApiBase()` (@elizaos/shared) — the boot
 * config is the single source of truth `getElizaApiBase()` reads (a bespoke
 * `__ELIZA_API_BASE__` window global is NO LONGER read for the REST base), and
 * the setter also mirrors `__ELIZAOS_API_BASE__` for any legacy reader. It
 * deliberately does NOT touch `__ELIZA_APP_API_BASE__` / the branded
 * `__<PREFIX>_API_BASE__` that `getInjectedAppApiBase()` reads for cloud-only
 * branding — so app branding is unaffected.
 *
 * Desktop (electrobun) and native (Capacitor) contexts are left untouched — they
 * legitimately need the injected / native base.
 *
 * This module MUST be imported as the first side-effect in `main.tsx`, before
 * the `client` singleton's `connectWs()` can run.
 */
import { Capacitor } from "@capacitor/core";
import { setElizaApiBase } from "@elizaos/shared";
import { isElectrobunRuntime } from "@elizaos/ui/bridge";

const LOOPBACK_HOSTNAMES = new Set([
  "localhost",
  "127.0.0.1",
  "::1",
  "[::1]",
  "0.0.0.0",
]);

function isLoopbackHostname(hostname: string): boolean {
  return LOOPBACK_HOSTNAMES.has(hostname.toLowerCase());
}

function setInjectedGlobal(key: string, value: string): void {
  try {
    const w = window as unknown as Record<string, unknown>;
    w[key] = value;
  } catch {
    // best-effort — never block boot
  }
}

/**
 * Same-origin realtime socket base for the current page:
 * `wss://<host>` on https, `ws://<host>` on http. client-base appends `/ws`
 * and the clientId/token query itself, so only the origin (protocol + host)
 * needs to be correct here.
 */
function sameOriginWsBase(): string {
  const loc = window.location;
  const proto = loc.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${loc.host}`;
}

/** Same-origin REST API base for the current page: `https://<host>`. */
function sameOriginRestBase(): string {
  const loc = window.location;
  return `${loc.protocol}//${loc.host}`;
}

/**
 * Returns true only for the plain-web served context that should use a
 * same-origin API/socket (not desktop, not native, page on a real http/https
 * non-loopback host).
 */
function isPlainWebSameOriginContext(): boolean {
  if (typeof window === "undefined") return false;
  // Desktop shell needs the injected loopback API base.
  if (isElectrobunRuntime()) return false;
  // Capacitor iOS/Android use their own native/injected bases.
  try {
    if (Capacitor.isNativePlatform()) return false;
  } catch {
    // If Capacitor isn't resolvable treat as web; fall through.
  }
  const loc = window.location;
  if (loc.protocol !== "http:" && loc.protocol !== "https:") return false;
  // Loopback page host = an actual local dev-in-browser session pointed at the
  // real loopback API; leave the injection alone there.
  if (isLoopbackHostname(loc.hostname)) return false;
  return true;
}

function injectedWsBaseIsForeignLoopback(value: unknown): boolean {
  if (typeof value !== "string" || !value.trim()) return false;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "ws:" && parsed.protocol !== "http:") {
      // A wss:/https: injection already implies a real proxied host; don't
      // second-guess it.
      return false;
    }
    // ws:/http: injection is the desktop-loopback default; on a plain-web
    // remote page it is always wrong.
    return true;
  } catch {
    return false;
  }
}

/**
 * Repoint the dev-injected desktop-loopback API + WS bases at the current
 * (reverse-proxied) origin on the plain-web path so REST hits same-origin
 * `/api` and the realtime socket dials `wss://<host>/ws`. No-op on desktop /
 * native / loopback-dev contexts.
 */
export function repairWebSameOriginWsBase(): void {
  if (!isPlainWebSameOriginContext()) return;
  const w = window as unknown as {
    __ELIZA_WS_BASE__?: unknown;
    __ELIZAOS_WS_BASE__?: unknown;
  };
  const anyForeign =
    injectedWsBaseIsForeignLoopback(w.__ELIZA_WS_BASE__) ||
    injectedWsBaseIsForeignLoopback(w.__ELIZAOS_WS_BASE__);
  if (!anyForeign) return;

  // 1) WS base → same-origin wss://<host>.
  const wsTarget = sameOriginWsBase();
  setInjectedGlobal("__ELIZA_WS_BASE__", wsTarget);
  setInjectedGlobal("__ELIZAOS_WS_BASE__", wsTarget);
  try {
    const wRecord = window as unknown as Record<string, unknown>;
    for (const key of Object.keys(wRecord)) {
      if (
        /^__[A-Z0-9]+_WS_BASE__$/.test(key) &&
        injectedWsBaseIsForeignLoopback(wRecord[key])
      ) {
        setInjectedGlobal(key, wsTarget);
      }
    }
  } catch {
    // best-effort
  }

  // 2) REST base → same-origin https://<host>, so the client's baseUrl is
  //    non-empty and connectWs()'s empty-baseUrl guard does not bail. The boot
  //    config is the single source of truth getElizaApiBase() reads, so this
  //    goes through setElizaApiBase() (which sets boot-config AND mirrors the
  //    __ELIZAOS_API_BASE__ global) rather than a raw window global that
  //    getElizaApiBase() no longer reads. This does NOT touch the app-branding
  //    globals (getInjectedAppApiBase()).
  const restTarget = sameOriginRestBase();
  try {
    setElizaApiBase(restTarget);
  } catch {
    // best-effort — never block boot
  }
}

repairWebSameOriginWsBase();
