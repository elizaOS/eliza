// Cloudflare Pages middleware for the hosted-web Eliza app (Topology A).
//
// Proxies same-origin `/api/*` and `/steward/*` to the Workers API and lets
// every other path fall through to the SPA (`index.html` via the `_redirects`
// catch-all). This is a single global `_middleware.ts` rather than two
// `[[path]].ts` catch-all functions because Cloudflare's bundler translates
// `[[path]]` -> `/:path*`, which path-to-regexp v8 (now used by the Pages
// runtime) rejects with `Missing parameter name at index 15`. A single
// `_middleware.ts` has no per-route path pattern at all, so the parser is
// never invoked.
//
// Mirrors `packages/cloud-frontend/functions/_middleware.ts` so apex behaviour
// is identical before and after the cutover. Upstream selection per Pages
// environment via `API_UPSTREAM` (set in the Pages project / `wrangler.toml`):
//   production branch (main) => API_UPSTREAM=https://api.elizacloud.ai
//   preview/staging branch   => API_UPSTREAM=https://api-staging.elizacloud.ai
// The fallback in `_proxy.ts` keeps custom production domains on production and
// sends `*.pages.dev` previews to staging so preview deploys never mutate
// production state.

import { type PagesProxyEnv, proxyToApiWorker } from "./_proxy";

interface MiddlewareContext {
  request: Request;
  env: PagesProxyEnv;
  next: () => Promise<Response>;
}

const PROXY_PREFIXES = ["/api/", "/steward/"];

// ── Embedded-app launch surface (#9947) ──────────────────────────────────────
//
// The dashboard is reused verbatim (single `build:web` bundle) inside a
// 3rd-party iframe for Telegram Mini Apps and Discord Activities. Those pages
// live under `/embed`, are served by the SPA catch-all, and authenticate with a
// token-based embed session (minted by `embed-auth` after the platform launch
// handshake) — NOT the first-party Steward cookie, which cannot cross into a
// 3rd-party frame. The only middleware concern is the framing policy: emit a
// `frame-ancestors` CSP scoped to `/embed` so the platform clients can embed
// the view, and drop any global anti-framing header for that path only. Every
// other path keeps its existing behaviour untouched.

const EMBED_PATH_PREFIX = "/embed";

/** Client origins permitted to iframe the embed surface. */
const EMBED_FRAME_ANCESTORS = [
  "'self'",
  "https://telegram.org",
  "https://*.telegram.org",
  "https://web.telegram.org",
  "https://discord.com",
  "https://*.discord.com",
  "https://*.discordsays.com",
] as const;

export function isEmbedPath(pathname: string): boolean {
  return (
    pathname === EMBED_PATH_PREFIX ||
    pathname.startsWith(`${EMBED_PATH_PREFIX}/`)
  );
}

/** CSP (+ companion) headers that make the embed surface framable. */
export function buildEmbedSecurityHeaders(): Record<string, string> {
  return {
    "Content-Security-Policy": `frame-ancestors ${EMBED_FRAME_ANCESTORS.join(" ")}`,
  };
}

/** Return a copy of `response` with the embed framing policy applied. */
export function applyEmbedSecurityHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(buildEmbedSecurityHeaders())) {
    headers.set(name, value);
  }
  headers.delete("X-Frame-Options");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export const onRequest = async (
  context: MiddlewareContext,
): Promise<Response> => {
  const url = new URL(context.request.url);

  if (isEmbedPath(url.pathname)) {
    const response = await context.next();
    return applyEmbedSecurityHeaders(response);
  }

  const shouldProxy = PROXY_PREFIXES.some((prefix) =>
    url.pathname.startsWith(prefix),
  );
  if (!shouldProxy) {
    return context.next();
  }
  return proxyToApiWorker(context);
};
