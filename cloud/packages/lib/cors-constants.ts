/**
 * Single source of truth for CORS headers on API responses and preflight.
 *
 * Wildcard origin (`*`) is used for most `/api/*` routes — access control is via
 * API keys, sessions, and other auth headers (not browser origin).
 *
 * For first-party flows that need cookies cross-origin, use
 * `getCorsHeaders` in `packages/lib/utils/cors.ts` (origin allowlist +
 * `Access-Control-Allow-Credentials: true`).
 */

/** Same header names as legacy comma-joined `CORS_ALLOW_HEADERS` — use for Hono `cors({ allowHeaders })`. */
export const CORS_ALLOW_HEADER_NAMES = [
  "Content-Type",
  "Authorization",
  "X-API-Key",
  "X-App-Id",
  "X-Request-ID",
  // Note: Cookie is ineffective with wildcard origin but listed for non-wildcard CORS flows
  "Cookie",
  "X-Miniapp-Token",
  "X-Anonymous-Session",
  "X-Gateway-Secret",
  "X-Wallet-Address",
  "X-Timestamp",
  "X-Wallet-Signature",
  "X-Service-Key",
  "Cache-Control",
  "X-Agent-Client-Id",
  "X-PAYMENT",
  "X-PAYMENT-RESPONSE",
  "X-PAYMENT-STATUS",
] as const;

export const CORS_ALLOW_HEADERS = CORS_ALLOW_HEADER_NAMES.join(", ");

export const CORS_ALLOW_METHOD_NAMES = [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
] as const;

export const CORS_ALLOW_METHODS = CORS_ALLOW_METHOD_NAMES.join(", ");

export const CORS_MAX_AGE = "86400";
