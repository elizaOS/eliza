/**
 * Pure CORS allowlist helpers shared by the server and focused tests.
 *
 * Kept separate from server.ts so helper-only tests do not need to load the
 * full API runtime dependency graph.
 */

import {
  resolveAllowedOrigins,
  resolveDesktopApiPort,
  resolveUiPort,
} from "@elizaos/shared/runtime-env";
import { readAliasedEnv } from "@elizaos/shared/utils/env";

/**
 * Build the set of localhost ports allowed for CORS.
 * Reads from env vars at call time so tests can override.
 *
 * Ports resolve through the alias-aware readers so a branded deployment's
 * `<PREFIX>_API_PORT` / `<PREFIX>_UI_PORT` / `<PREFIX>_GATEWAY_PORT` /
 * `<PREFIX>_HOME_PORT` are honoured without the `syncBrandEnvToEliza` mirror
 * mutation, with the canonical `ELIZA_*` key still winning when present (#13422).
 */
export function buildCorsAllowedPorts(): Set<string> {
  const ports = new Set([
    String(resolveDesktopApiPort(process.env)),
    String(resolveUiPort(process.env)),
    String(process.env.ELIZA_PORT ?? "2138"),
    String(readAliasedEnv("ELIZA_GATEWAY_PORT") ?? "18789"),
    String(readAliasedEnv("ELIZA_HOME_PORT") ?? "2142"),
  ]);
  // Electrobun renderer static server picks a free port in the 5174–5200
  // range. Allow the full range so cross-origin fetches from WKWebView
  // to the local API succeed.
  for (let p = 5174; p <= 5200; p++) ports.add(String(p));
  return ports;
}

/**
 * Comma-separated explicit origins allowed by the operator (e.g. a
 * remote dashboard host like https://bot.example.com). Localhost gets
 * a built-in pass via {@link isAllowedOrigin}; this is the only
 * way to allow non-loopback hosts.
 */
export function getAllowedRemoteOrigins(): Set<string> {
  // `resolveAllowedOrigins` reads `ELIZA_ALLOWED_ORIGINS` (and the `CORS_ORIGINS`
  // fallback) alias-aware, already split/trimmed/filtered, so a branded
  // `<PREFIX>_ALLOWED_ORIGINS` resolves without the mirror mutation (#13422).
  return new Set(
    resolveAllowedOrigins(process.env).map((origin) => {
      try {
        return originString(new URL(origin));
      } catch {
        return origin;
      }
    }),
  );
}

/** Lazily cached port set — computed once, invalidated on port changes. */
let cachedCorsAllowedPorts: Set<string> | undefined;
let cachedRemoteOrigins: Set<string> | undefined;

export function getCorsAllowedPorts(): Set<string> {
  if (!cachedCorsAllowedPorts) {
    cachedCorsAllowedPorts = buildCorsAllowedPorts();
  }
  return cachedCorsAllowedPorts;
}

export function getCachedRemoteOrigins(): Set<string> {
  if (!cachedRemoteOrigins) {
    cachedRemoteOrigins = getAllowedRemoteOrigins();
  }
  return cachedRemoteOrigins;
}

/** Invalidate the cached CORS port set so it is recomputed on next request. */
export function invalidateCorsAllowedPorts(): void {
  cachedCorsAllowedPorts = undefined;
  cachedRemoteOrigins = undefined;
}

/**
 * Capacitor WebView origins for App Store / Play Store mobile builds.
 *
 * iOS WKWebView serves the bundled UI at `capacitor://localhost`; Android's
 * WebView2 uses `https://localhost` (default `androidScheme: "https"`). These
 * are allowed unconditionally so a self-hosted bot is reachable from the
 * mobile app without each operator manually adding them to
 * `ELIZA_ALLOWED_ORIGINS`. Auth still requires a valid bearer; the origin
 * gate just stops *unrelated* sites from talking to the API.
 */
const CAPACITOR_WEBVIEW_ORIGINS: ReadonlySet<string> = new Set([
  "capacitor://localhost",
  "ionic://localhost",
  "https://localhost",
]);

/**
 * Trusted native app schemes. Browsers cannot host arbitrary web pages at
 * these origins; they are used by packaged/native app shells.
 */
const NATIVE_WEBVIEW_PROTOCOLS: ReadonlySet<string> = new Set([
  "views:",
  "capacitor:",
  "capacitor-electron:",
  "ionic:",
  "app:",
  "tauri:",
  "electrobun:",
]);

/**
 * URL.origin returns the literal string "null" for non-special schemes
 * (capacitor:, ionic:), so we compare protocol+host instead.
 */
function originString(u: URL): string {
  return `${u.protocol}//${u.host}`;
}

function isAllowedNativeWebviewHost(u: URL): boolean {
  const host = u.hostname.toLowerCase();
  return (
    host === "" ||
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "[::1]" ||
    host === "::1"
  );
}

/**
 * Check whether a URL string is an allowed origin for CORS:
 *   - a configured local API port,
 *   - a Capacitor / Ionic WebView origin (mobile app builds),
 *   - or an explicit operator-allowed remote origin.
 */
export function isAllowedOrigin(
  urlStr: string,
  allowedPorts?: Set<string>,
  allowedRemoteOrigins?: Set<string>,
): boolean {
  const ports = allowedPorts ?? getCorsAllowedPorts();
  const remoteOrigins = allowedRemoteOrigins ?? getCachedRemoteOrigins();
  try {
    const u = new URL(urlStr);
    const origin = originString(u);
    if (CAPACITOR_WEBVIEW_ORIGINS.has(origin)) return true;
    if (NATIVE_WEBVIEW_PROTOCOLS.has(u.protocol)) {
      return isAllowedNativeWebviewHost(u);
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    if (remoteOrigins.has(origin)) return true;
    const h = u.hostname.toLowerCase();
    const isLocal =
      h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h === "::1";
    const port = u.port || (u.protocol === "https:" ? "443" : "80");
    return isLocal && ports.has(port);
  } catch {
    // error-policy:J3 unparseable origin rejected (fail-closed)
    return false;
  }
}
