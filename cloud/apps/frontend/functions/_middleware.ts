// Cloudflare Pages middleware that proxies same-origin /api/* and /steward/*
// to the Workers API. This is a single global middleware rather than two
// separate [[path]].ts catch-all functions because Cloudflare's bundler
// translates [[path]] -> /:path*, which path-to-regexp v8 (now used by the
// Pages runtime) rejects with `Missing parameter name at index 15`. A single
// _middleware.ts has no per-route path pattern at all, so the parser is
// never invoked.
//
// Behaviour matches the previous functions/api/[[path]].ts and
// functions/steward/[[path]].ts:
//   - Pass-through method, headers, body via re-using the original Request.
//   - Hop-by-hop headers stripped by the runtime.
//   - Set-Cookie on the response propagates back unchanged.
//   - Non-/api and non-/steward requests fall through to the SPA via next().
//
// Upstream selection per Pages environment via API_UPSTREAM (configured in
// the Pages project settings):
//   production branch (main) => API_UPSTREAM=https://api.elizacloud.ai
//   staging branch           => API_UPSTREAM=https://api-staging.elizacloud.ai
// The fallback keeps custom production domains on production and sends
// Pages previews to staging so preview deploys do not mutate production
// state.

import { type PagesProxyEnv, proxyToApiWorker } from "./_proxy";

interface MiddlewareContext {
  request: Request;
  env: PagesProxyEnv;
  next: () => Promise<Response>;
}

const PROXY_PREFIXES = ["/api/", "/steward/"];

export const onRequest = async (context: MiddlewareContext): Promise<Response> => {
  const url = new URL(context.request.url);
  const shouldProxy = PROXY_PREFIXES.some((prefix) => url.pathname.startsWith(prefix));
  if (!shouldProxy) {
    return context.next();
  }
  return proxyToApiWorker(context);
};
