/** Repair desktop loopback injection on remotely served web pages before client bootstrap.
 * Native shells retain their injected endpoint; explicit remote endpoints stay authoritative.
 */
import { Capacitor } from "@capacitor/core";
import { setElizaApiBase } from "@elizaos/core/utils/eliza-globals";
import { isElectrobunRuntime } from "@elizaos/ui/bridge";

declare global {
  interface Window {
    __ELIZA_WS_BASE__?: unknown;
    __ELIZAOS_WS_BASE__?: unknown;
    [key: `__${string}_WS_BASE__`]: unknown;
  }
}
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
function setInjectedGlobal(key: `__${string}_WS_BASE__`, value: string): void {
  window[key] = value;
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
  if (Capacitor.isNativePlatform()) return false;
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
    return isLoopbackHostname(parsed.hostname);
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
  const anyForeign = injectedWsBaseIsForeignLoopback(
    window.__ELIZA_WS_BASE__ || window.__ELIZAOS_WS_BASE__,
  );
  if (!anyForeign) return;
  // 1) WS base → same-origin wss://<host>.
  const wsTarget = sameOriginWsBase();
  setInjectedGlobal("__ELIZA_WS_BASE__", wsTarget);
  setInjectedGlobal("__ELIZAOS_WS_BASE__", wsTarget);
  for (const key of Object.keys(window)) {
    if (
      /^__[A-Z0-9]+_WS_BASE__$/.test(key) &&
      injectedWsBaseIsForeignLoopback(window[key as `__${string}_WS_BASE__`])
    ) {
      setInjectedGlobal(key as `__${string}_WS_BASE__`, wsTarget);
    }
  }
  // 2) REST base → same-origin https://<host>, so the client's baseUrl is
  //    non-empty and connectWs()'s empty-baseUrl guard does not bail. The boot
  //    config is the single source of truth getElizaApiBase() reads, so this
  //    goes through setElizaApiBase() (which sets boot-config AND mirrors the
  //    __ELIZAOS_API_BASE__ global) rather than a raw window global that
  //    getElizaApiBase() no longer reads. This does NOT touch the app-branding
  //    globals (getInjectedAppApiBase()).
  const restTarget = sameOriginRestBase();
  setElizaApiBase(restTarget);
}
repairWebSameOriginWsBase();
