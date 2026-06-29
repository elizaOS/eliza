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

// The hosted-web SPA is embedded inside the Discord Activities and Telegram
// Mini App iframes. The global `public/_headers` rule pins every response to
// `X-Frame-Options: SAMEORIGIN` + CSP `frame-ancestors 'self'`, which denies
// all cross-origin framing. The `/embed` surface relaxes ONLY the frame
// embedding policy for the one requesting platform — never a wildcard, never
// both platforms at once — and denies it everywhere else.
export type EmbedPlatform = "telegram" | "discord";

const EMBED_FRAME_ANCESTORS: Record<EmbedPlatform, string> = {
  telegram: "frame-ancestors https://web.telegram.org https://*.telegram.org",
  discord: "frame-ancestors https://discord.com https://*.discord.com",
};

const EMBED_FRAME_ANCESTORS_DENY = "frame-ancestors 'none'";

const isEmbedPlatform = (value: string | null): value is EmbedPlatform =>
  value === "telegram" || value === "discord";

// Maps the requesting platform to its `frame-ancestors` CSP directive. Unknown
// or missing platforms get `'none'` so the embed surface fails closed.
export const embedFrameAncestors = (platform: string | null): string =>
  isEmbedPlatform(platform)
    ? EMBED_FRAME_ANCESTORS[platform]
    : EMBED_FRAME_ANCESTORS_DENY;

const isEmbedPath = (pathname: string): boolean =>
  pathname === "/embed" || pathname.startsWith("/embed/");

export const onRequest = async (
  context: MiddlewareContext,
): Promise<Response> => {
  const url = new URL(context.request.url);

  const shouldProxy = PROXY_PREFIXES.some((prefix) =>
    url.pathname.startsWith(prefix),
  );
  if (shouldProxy) {
    return proxyToApiWorker(context);
  }

  const response = await context.next();

  if (!isEmbedPath(url.pathname)) {
    return response;
  }

  // Serve the same SPA bundle, but override the frame embedding policy so the
  // page renders inside the matched platform's iframe. The conflicting
  // `X-Frame-Options` header (which has no allowlist syntax) is dropped so it
  // cannot veto the CSP `frame-ancestors` directive.
  const headers = new Headers(response.headers);
  headers.set(
    "Content-Security-Policy",
    embedFrameAncestors(url.searchParams.get("platform")),
  );
  headers.delete("X-Frame-Options");

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
};
