// Cloudflare Pages middleware for the hosted-web Eliza app (Topology A).
//
// Proxies same-origin `/api/*` and `/steward/*` to the Workers API and lets
// every other path fall through to the SPA (`index.html` via the `_redirects`
// catch-all). This is a single global `_middleware.ts` rather than two
// `[[path]].ts` catch-all functions because Cloudflare's bundler translates
// `[[path]]` -> `/:path*`, which path-to-regexp v8 (now used by the Pages
// runtime) rejects with `Missing parameter name at index 15`. Upstream
// selection per Pages environment via `API_UPSTREAM` (see `_proxy.ts`).
//
// This middleware also owns the cache-discipline behaviors that the Pages
// config files cannot express (#15182 residue):
//
// - `/assets/*` misses return a real 404, never the SPA fallback. Cloudflare
//   Pages `_redirects` supports only 200 rewrites and 3xx redirects — a
//   `/assets/* /index.html 404` line is silently ignored — so without this
//   branch a stale tab requesting a rotated chunk hash receives index.html
//   with the long-lived asset Cache-Control and caches garbage AS the chunk
//   (white screen + cache poisoning). Conditional validators are stripped
//   before the asset lookup because the fallback shares index.html's ETag: an
//   already-poisoned browser would otherwise revalidate its cached index.html
//   copy into a 304 and keep the poison forever.
//
// - Cache-Control on `/assets/*` hits and `/sw.js` is set here, not in
//   `public/_headers`, because multiple matching `_headers` rules aggregate
//   into one comma-joined value instead of overriding — the `/*` no-cache rule
//   would join the asset immutable rule as "no-cache, public, max-age=...,
//   immutable", which browsers resolve as revalidate-always. The service
//   worker gets `no-store` (not `no-cache`) so the zone edge never caches it:
//   an edge-cached .js response has its browser TTL rewritten to the zone
//   default (max-age=14400), which would delay SW update propagation by hours.

import { type PagesProxyEnv, proxyToApiWorker } from "./_proxy";

interface MiddlewareContext {
  request: Request;
  env: PagesProxyEnv;
  next: (input?: Request) => Promise<Response>;
}

const PROXY_PREFIXES = ["/api/", "/steward/"];

const ASSETS_PREFIX = "/assets/";
const SERVICE_WORKER_PATH = "/sw.js";

// Vite content-hashes every file it emits under /assets/, so a hit is
// immutable by construction; a byte change always produces a new filename.
const ASSET_CACHE_CONTROL = "public, max-age=31536000, immutable";
const SERVICE_WORKER_CACHE_CONTROL = "no-store";

const withCacheControl = (response: Response, value: string): Response => {
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", value);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
};

// The SPA fallback is the only text/html producer under /assets/ — the Vite
// asset dir contains js/css/fonts/wasm/images only — so an html content type
// is the definitive miss signal.
const isSpaFallback = (response: Response): boolean =>
  (response.headers.get("Content-Type") ?? "")
    .toLowerCase()
    .includes("text/html");

const serveAsset = async (context: MiddlewareContext): Promise<Response> => {
  const headers = new Headers(context.request.headers);
  headers.delete("If-None-Match");
  headers.delete("If-Modified-Since");
  const response = await context.next(
    new Request(context.request, { headers }),
  );

  if (isSpaFallback(response)) {
    // Constructed responses bypass `public/_headers`, so the safety headers
    // are set explicitly. no-store keeps the 404 out of every cache layer so
    // recovery is immediate once a deploy restores (or a reload re-resolves)
    // the chunk graph.
    return new Response("Not Found", {
      status: 404,
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "text/plain; charset=utf-8",
        "X-Content-Type-Options": "nosniff",
      },
    });
  }

  return response.ok
    ? withCacheControl(response, ASSET_CACHE_CONTROL)
    : response;
};

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

  if (url.pathname.startsWith(ASSETS_PREFIX)) {
    return serveAsset(context);
  }

  const response = await context.next();

  if (url.pathname === SERVICE_WORKER_PATH) {
    return withCacheControl(response, SERVICE_WORKER_CACHE_CONTROL);
  }

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
