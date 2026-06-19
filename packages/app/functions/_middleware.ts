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

export const onRequest = async (
  context: MiddlewareContext,
): Promise<Response> => {
  const url = new URL(context.request.url);
  const shouldProxy = PROXY_PREFIXES.some((prefix) =>
    url.pathname.startsWith(prefix),
  );
  if (!shouldProxy) {
    return context.next();
  }
  return proxyToApiWorker(context);
};
