// Coordinates cloud service cors behavior behind route handlers.
import {
  APP_LOCAL_ORIGIN_RE,
  APP_SCHEME_ORIGIN_RE,
  CORS_ALLOW_HEADERS,
  CORS_MAX_AGE,
} from "../../cors-constants";

/**
 * Shared CORS utilities for proxy services
 *
 * Security Rationale:
 * These endpoints are public APIs consumed by browser-based dApps.
 * CORS is unrestricted by design because:
 * 1. Authentication is handled via API keys (X-API-Key header)
 * 2. Rate limiting is per API key
 * 3. Billing is per organization
 *
 * The API key requirement provides the actual access control,
 * not CORS restrictions.
 *
 * App-origin (Capacitor WebView) exception:
 * The Eliza mobile app runs in a Capacitor WebView whose document origin is
 * `https://localhost` (androidScheme/iosScheme = "https") or `capacitor://localhost`
 * (iOS default). When that WebView reads an SSE chat stream cross-origin via the
 * native browser fetch (CapacitorWebFetch — required because CapacitorHttp buffers
 * and collapses token streaming), the browser enforces CORS. A wildcard
 * `Access-Control-Allow-Origin: *` is REJECTED for credentialed requests, and the
 * app always sends `X-ElizaOS-Client-Id` (+ `X-ElizaOS-UI-Language`), which must be
 * named in `Access-Control-Allow-Headers` or the preflight fails. So for the known
 * app origins we reflect the specific origin + allow credentials (mirroring the
 * dedicated-agent subdomain CORS in
 * `packages/agent/src/api/server-helpers-auth.ts`). Every other origin keeps the
 * `*` wildcard (no credentials) — API-key auth is the access control there.
 */

/**
 * Capacitor WebView document origins for the Eliza app:
 *  - `https://localhost` — android/iosScheme = "https" (see packages/app/capacitor.config.ts)
 *  - `capacitor://localhost` / `capacitor-electron://localhost` — Capacitor defaults
 *  - `http://localhost[:port]` / `http://127.0.0.1[:port]` — local web dev/preview
 *  - `https://localhost[:port]` / `https://127.0.0.1[:port]` — https local dev
 * Mirrors the dedicated-agent LOCAL_ORIGIN_RE + APP_ORIGIN_RE allow-list.
 * Regexes live in cors-constants.ts (single source of truth).
 */

/**
 * An origin that authenticates with credentials (cookies/native fetch) from the
 * Eliza app/local-dev WebView. These get the origin reflected + credentials, since
 * `*` is invalid for a credentialed cross-origin read (e.g. an SSE chat stream).
 */
export function isAppOrigin(origin: string): boolean {
  return APP_LOCAL_ORIGIN_RE.test(origin) || APP_SCHEME_ORIGIN_RE.test(origin);
}

export function getCorsHeaders(methods?: string, origin?: string | null): Record<string, string> {
  // Reflect a known app/local origin (+ credentials) so a credentialed
  // cross-origin read (SSE chat stream) is allowed; `*` is rejected for those.
  if (origin && isAppOrigin(origin)) {
    return {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": methods || "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": CORS_ALLOW_HEADERS,
      "Access-Control-Allow-Credentials": "true",
      "Access-Control-Max-Age": CORS_MAX_AGE,
      // Reflecting the origin makes the response vary by Origin; declare it so a
      // shared cache never serves one origin's ACAO to another.
      Vary: "Origin",
    };
  }
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": methods || "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": CORS_ALLOW_HEADERS,
    "Access-Control-Max-Age": CORS_MAX_AGE,
  };
}

export function handleCorsOptions(methods: string, origin?: string | null): Response {
  return new Response(null, {
    status: 204,
    headers: getCorsHeaders(methods, origin),
  });
}

export function applyCorsHeaders(
  response: Response,
  methods?: string,
  origin?: string | null,
): Response {
  const headers = new Headers(response.headers);

  for (const [key, value] of Object.entries(getCorsHeaders(methods, origin))) {
    headers.set(key, value);
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
