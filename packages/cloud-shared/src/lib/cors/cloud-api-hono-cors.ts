/**
 * CORS middleware for the Cloud API on Cloudflare Workers.
 *
 * Two origin classes, two policies:
 *
 * 1. First-party origins (the SPA on `elizacloud.ai` etc. talking to the Worker
 *    on `api.elizacloud.ai`) authenticate with cookies (`steward-token`, …).
 *    Cookies only flow cross-origin when CORS reflects the specific origin AND
 *    sets `Access-Control-Allow-Credentials: true`. These origins are
 *    allow-listed and get the credentialed policy.
 *
 * 2. Every other browser origin — third-party apps registered on Eliza Cloud
 *    (e.g. `supakan.nubs.site`, `*.apps.elizacloud.ai`) calling explicit
 *    public, token-authed API paths (`/api/v1/chat/completions`,
 *    `/api/v1/app-credits/*`, `/api/v1/models`, …). These callers
 *    authenticate with a `Bearer eliza_*` key, never cookies, so CORS is open
 *    (`Access-Control-Allow-Origin: *`) WITHOUT credentials on those paths.
 *    This matches the documented model in `lib/middleware/cors-apps.ts`
 *    ("CORS open for the API; security is enforced by auth tokens, not
 *    origin"). We intentionally do not apply wildcard CORS to every route:
 *    user-controlled same-site subdomains can still send parent-domain cookies,
 *    so cookie/session-capable routes must stay first-party-only.
 *
 * Non-browser callers (servers, SDKs) don't enforce CORS and are unaffected.
 */

import type { MiddlewareHandler } from "hono";
import { cors } from "hono/cors";

import { CORS_ALLOW_HEADER_NAMES, CORS_ALLOW_METHOD_NAMES } from "../cors-constants";

const STATIC_ALLOWED_ORIGINS = new Set<string>([
  "https://elizacloud.ai",
  "https://www.elizacloud.ai",
  "https://staging.elizacloud.ai",
  "https://dev.elizacloud.ai",
  "https://elizaos.ai",
  "https://www.elizaos.ai",
  "https://os.elizacloud.ai",
  "https://eliza.ai",
  "https://www.eliza.ai",
]);
const PAGES_PREVIEW_SUFFIX = ".eliza-cloud-enq.pages.dev";
const PUBLIC_TOKEN_API_PATH_PREFIXES = [
  "/api/v1/app-credits/",
  "/api/v1/voice/",
  "/api/v1/models/",
];
const PUBLIC_TOKEN_API_PATHS = new Set<string>([
  "/api/v1/app-credits",
  "/api/v1/chat",
  "/api/v1/chat/completions",
  "/api/v1/embeddings",
  "/api/v1/generate-image",
  "/api/v1/generate-video",
  "/api/v1/models",
  "/api/v1/responses",
  "/api/v1/voice",
  "/api/v1/voice-models",
  "/api/v1/voice-models/catalog",
]);

/**
 * First-party origins that may use cookie/session credentials. These get
 * `Access-Control-Allow-Credentials: true` with the origin reflected.
 */
export function isFirstPartyOrigin(origin: string): boolean {
  if (STATIC_ALLOWED_ORIGINS.has(origin)) return true;
  if (origin.startsWith("http://localhost:") || origin.startsWith("http://127.0.0.1:")) {
    return true;
  }
  try {
    const host = new URL(origin).hostname;
    return host.endsWith(PAGES_PREVIEW_SUFFIX) || host === PAGES_PREVIEW_SUFFIX.slice(1);
  } catch {
    return false;
  }
}

export function isPublicTokenApiPath(pathname: string): boolean {
  return (
    PUBLIC_TOKEN_API_PATHS.has(pathname) ||
    PUBLIC_TOKEN_API_PATH_PREFIXES.some((prefix) => pathname.startsWith(prefix))
  );
}

// First-party: reflect the specific origin + allow credentials (cookie auth).
const firstPartyCors = cors({
  origin: (origin) => (origin && isFirstPartyOrigin(origin) ? origin : null),
  credentials: true,
  allowMethods: [...CORS_ALLOW_METHOD_NAMES],
  allowHeaders: [...CORS_ALLOW_HEADER_NAMES],
  maxAge: 86400,
});

// Public token-authed API: allow any browser origin WITHOUT credentials so
// registered third-party apps can call the API from the browser. Auth is the
// Bearer token, never a cookie, so a wildcard is safe and matches the documented
// model in `lib/middleware/cors-apps.ts`.
//
// `origin: "*"` (not a reflecting function) is deliberate: it makes the
// middleware set `Access-Control-Allow-Origin` on EVERY request — including
// requests with no `Origin` header — before `next()`. That preserves the
// invariant `secureHeaders` (registered right after CORS in `bootstrap-app.ts`)
// relies on: CORS must touch `c.res` so Hono re-wraps handler responses with a
// fresh mutable `Headers`. A reflecting function writes nothing on a no-Origin
// request, leaving raw `Response.json(...)` passthrough responses frozen, so the
// downstream `secureHeaders` write throws `Can't modify immutable headers`.
const publicCors = cors({
  origin: "*",
  credentials: false,
  allowMethods: [...CORS_ALLOW_METHOD_NAMES],
  allowHeaders: [...CORS_ALLOW_HEADER_NAMES],
  maxAge: 86400,
});

export const corsMiddleware: MiddlewareHandler = (c, next) => {
  const origin = c.req.header("origin");
  if (origin && isFirstPartyOrigin(origin)) {
    return firstPartyCors(c, next);
  }
  if (!origin || isPublicTokenApiPath(new URL(c.req.url).pathname)) {
    return publicCors(c, next);
  }
  return firstPartyCors(c, next);
};
