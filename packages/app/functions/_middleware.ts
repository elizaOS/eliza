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
import {
  classifyElizaHostname,
  ELIZA_DOMAIN_CONTRACTS,
  LANDING_AB_HOSTNAMES,
} from "@elizaos/plugin-elizacloud/cloud-config/domain-contract";
import { type PagesProxyEnv, proxyToApiWorker } from "./_proxy";

interface MiddlewareContext {
  request: Request;
  env: PagesProxyEnv;
  next: (input?: Request) => Promise<Response>;
}
const OIDC_PROTOCOL_PATHS = new Set([
  "/.well-known/openid-configuration",
  "/.well-known/oidc/jwks.json",
  // Android App Link verification fetches this from the link host itself and
  // does not follow redirects, so it must be proxied here (never the SPA's
  // index.html, which would fail verification with a 200 text/html body).
  "/.well-known/assetlinks.json",
]);
function isProtocolPath(pathname: string): boolean {
  return (
    pathname === "/api" ||
    pathname.startsWith("/api/") ||
    pathname === "/steward" ||
    pathname.startsWith("/steward/") ||
    OIDC_PROTOCOL_PATHS.has(pathname)
  );
}
/** Resolve browser-facing legacy aliases to their canonical host. */
export function resolveCanonicalPageRedirect(
  requestUrl: string,
): string | null {
  const url = new URL(requestUrl);
  // A/B landing hosts serve the variant in place; redirecting them to the
  // canonical marketing origin would send every visitor to the control.
  if (LANDING_AB_HOSTNAMES.includes(url.hostname.toLowerCase())) return null;
  const classified = classifyElizaHostname(url.hostname);
  if (!classified.environment) return null;
  const contract = ELIZA_DOMAIN_CONTRACTS[classified.environment];
  let origin: string | null = null;
  if (classified.role === "legacy-marketing" && isProtocolPath(url.pathname)) {
    origin = contract.cloudApiOrigin;
  } else if (
    classified.role === "legacy-marketing" ||
    (classified.role === "marketing" &&
      url.hostname !== new URL(contract.marketingOrigin).hostname)
  ) {
    origin = contract.marketingOrigin;
  } else if (classified.role === "legacy-cloud-app") {
    origin = isProtocolPath(url.pathname)
      ? contract.cloudApiOrigin
      : contract.cloudAppOrigin;
  } else if (classified.role === "legacy-cloud-api") {
    origin = contract.cloudApiOrigin;
  }
  return origin ? `${origin}${url.pathname}${url.search}` : null;
}
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
// robots.txt and sitemap.xml ship as ordinary files in `public/`, so the Pages
// static layer already serves their bytes through next(). The middleware only
// has to keep them out of the fail-closed .txt/.xml 404 below and pin the
// content type, because a crawler that receives the SPA's text/html for
// robots.txt treats the whole site as uncrawlable. Reading the file off disk
// here is not an option: Pages Functions run in workerd with no filesystem and
// no nodejs_compat flag on this project, so a `node:fs` import fails to
// resolve at deploy time.
const CRAWL_ASSET_CONTENT_TYPES = new Map([
  ["/robots.txt", "text/plain; charset=utf-8"],
  ["/sitemap.xml", "application/xml; charset=utf-8"],
]);
const serveCrawlAsset = async (
  context: MiddlewareContext,
  contentType: string,
): Promise<Response> => {
  const response = await context.next();
  // A static miss falls through to index.html. Serving that as robots.txt
  // would advertise an HTML document as the crawl policy, so it fails closed
  // and is loud enough to notice in Cloudflare's status metrics.
  if (isSpaFallback(response) || !response.ok) {
    return new Response("Not Found", {
      status: 404,
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "text/plain; charset=utf-8",
        "X-Content-Type-Options": "nosniff",
      },
    });
  }
  const headers = new Headers(response.headers);
  headers.set("Content-Type", contentType);
  headers.set("Cache-Control", "no-cache");
  headers.set("X-Content-Type-Options", "nosniff");
  return new Response(response.body, { status: response.status, headers });
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
/**
 * Replace only the `frame-ancestors` directive inside an existing CSP string,
 * preserving every other directive. The `/embed` route must relax framing
 * without dropping the rest of the edge policy (the pinned
 * `connect-src`/`frame-src`/`img-src` allowlists from `public/_headers`) —
 * and appending a second CSP header would not work either, because multiple
 * policies intersect (`'self' ∩ <platform>` denies all framing).
 */
export const swapCspFrameAncestors = (
  csp: string,
  frameAncestorsDirective: string,
): string => {
  const directives = csp
    .split(";")
    .map((directive) => directive.trim())
    .filter((directive) => directive.length > 0);
  const index = directives.findIndex(
    (directive) =>
      directive.split(/\s+/, 1)[0]?.toLowerCase() === "frame-ancestors",
  );
  if (index >= 0) {
    directives[index] = frameAncestorsDirective;
  } else {
    directives.push(frameAncestorsDirective);
  }
  return directives.join("; ");
};
// ── Native sign-in callback fallback ─────────────────────────────────────────
//
// Alpha Phone's in-app sign-in returns from Google through the verified App
// Link `https://<host>/alphaphone/auth/callback`. Android hands that URL to the
// app before any page loads. This page renders only when the link was NOT
// intercepted (verification pending or failed, "open supported links" turned
// off, a redirect without a user gesture, or the app is not installed).
//
// It never forwards a sign-in code. An `intent://` hand-off is matched on
// package name only, not on the signing certificate, so a sideloaded app that
// reuses the package name could start its own authorize with its own PKCE
// verifier and receive the victim's code from this page. PKCE does not help
// when the attacker started the flow. Success returns therefore rely solely on
// the verified App Link.
//
// The page's only control brings the app forward. Rendered by the server it
// carries no parameters. One hash-pinned inline script then (a) points it at
// `?error=app_link_unverified&state=<state>` when the fragment or query holds
// a state of the contract's shape, so the app can match its pending attempt
// and say the App Link was not verified, and (b) removes the fragment (where
// Steward puts the code) and the query from session history. A state alone
// cannot redeem anything. The page renders no SPA, calls no API and sets no
// cookie. The shape is pinned by the shared contract fixture
// test/fixtures/alphaphone-native-signin-callback.contract.json, which Alpha
// Phone runs too.
export const NATIVE_SIGN_IN_CALLBACK_PATH = "/alphaphone/auth/callback";
export const NATIVE_SIGN_IN_PACKAGE = "ai.elizaresearch.alphaphone";
export const NATIVE_CALLBACK_SCRUB_SCRIPT =
  '(function(){var R=/^[A-Za-z0-9_-]{43}$/,s=null;function f(t){t.split("&").forEach(function(p){var i=p.indexOf("=");if(s===null&&i>0&&p.slice(0,i)==="state"&&R.test(p.slice(i+1)))s=p.slice(i+1)})}f(location.hash.slice(1));f(location.search.slice(1));var a=document.getElementById("open");if(a&&s)a.href="intent://"+location.host+"/alphaphone/auth/callback?error=app_link_unverified&state="+s+"#Intent;scheme=https;package=ai.elizaresearch.alphaphone;end";if(location.hash||location.search)history.replaceState(null,"",location.pathname)})();';
// sha256 of NATIVE_CALLBACK_SCRUB_SCRIPT; the test recomputes it.
const NATIVE_CALLBACK_SCRIPT_HASH =
  "sha256-Sl3P1xhyAntQj4SGXYMv7AXc7nf52KPt+v434UWVIrw=";
const NATIVE_CALLBACK_CSP = `default-src 'none'; script-src '${NATIVE_CALLBACK_SCRIPT_HASH}'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;

const escapeHtml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

/**
 * Build the server-rendered `intent://` URL that brings the app forward. It
 * never carries a query: no `code`, `state` or `error` from the callback URL
 * is forwarded, whatever shape the request has. (The server cannot see the
 * fragment; the pinned page script may add only `error=app_link_unverified`
 * and a well-formed `state`, never a code.)
 */
export function buildNativeSignInIntentUrl(url: URL): string {
  return `intent://${url.host}${NATIVE_SIGN_IN_CALLBACK_PATH}#Intent;scheme=https;package=${NATIVE_SIGN_IN_PACKAGE};end`;
}

export function nativeSignInCallbackFallback(url: URL): Response {
  const href = escapeHtml(buildNativeSignInIntentUrl(url));
  const body = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="referrer" content="no-referrer">
<title>Return to Alpha Phone</title>
<style>
:root { color-scheme: light dark; font-family: system-ui, sans-serif; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px; box-sizing: border-box; }
main { max-width: 420px; text-align: center; line-height: 1.5; }
a { display: inline-block; margin-top: 16px; padding: 14px 22px; border-radius: 10px; background: #111; color: #fff; font-weight: 600; text-decoration: none; }
@media (prefers-color-scheme: dark) { a { background: #f4f4f4; color: #111; } }
</style>
</head>
<body>
<main>
<h1>Sign-in did not finish</h1>
<p>Alpha Phone did not open automatically, so this sign-in was not completed. Return to Alpha Phone and start sign-in again.</p>
<p>If this keeps happening, open Android Settings, then Apps, Alpha Phone, Open by default, and allow it to open its supported links.</p>
<a id="open" href="${href}">Return to Alpha Phone</a>
<script>${NATIVE_CALLBACK_SCRUB_SCRIPT}</script>
</main>
</body>
</html>`;
  return new Response(body, {
    status: 200,
    headers: {
      "Cache-Control": "no-store",
      "Content-Security-Policy": NATIVE_CALLBACK_CSP,
      "Content-Type": "text/html; charset=utf-8",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
}

const isEmbedPath = (pathname: string): boolean =>
  pathname === "/embed" || pathname.startsWith("/embed/");
export const onRequest = async (
  context: MiddlewareContext,
): Promise<Response> => {
  const url = new URL(context.request.url);
  const canonicalRedirect = resolveCanonicalPageRedirect(url.href);
  if (canonicalRedirect) {
    return Response.redirect(canonicalRedirect, 308);
  }
  if (isProtocolPath(url.pathname)) {
    return proxyToApiWorker(context);
  }
  if (url.pathname.startsWith(ASSETS_PREFIX)) {
    return serveAsset(context);
  }
  if (url.pathname === NATIVE_SIGN_IN_CALLBACK_PATH) {
    return nativeSignInCallbackFallback(url);
  }
  // A single lookup decides both that this is a crawl asset and what type it
  // must be served as, so the two can never drift apart.
  const crawlAssetContentType = CRAWL_ASSET_CONTENT_TYPES.get(url.pathname);
  if (crawlAssetContentType !== undefined) {
    return serveCrawlAsset(context, crawlAssetContentType);
  }
  if (
    !isProtocolPath(url.pathname) &&
    !url.pathname.startsWith(ASSETS_PREFIX) &&
    (url.pathname.endsWith(".xml") || url.pathname.endsWith(".txt"))
  ) {
    return new Response("Not Found", {
      status: 404,
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "text/plain; charset=utf-8",
        "X-Content-Type-Options": "nosniff",
      },
    });
  }
  const response = await context.next();
  if (url.pathname === SERVICE_WORKER_PATH) {
    return withCacheControl(response, SERVICE_WORKER_CACHE_CONTROL);
  }
  if (!isEmbedPath(url.pathname)) {
    return response;
  }
  // Serve the same SPA bundle, but override the frame embedding policy so the
  // page renders inside the matched platform's iframe. Only the
  // `frame-ancestors` value inside the inherited `_headers` CSP is swapped —
  // the rest of the edge policy (connect-src/frame-src/img-src allowlists)
  // must survive on a surface designed to run inside third-party iframes. The
  // conflicting `X-Frame-Options` header (which has no allowlist syntax) is
  // dropped so it cannot veto the CSP `frame-ancestors` directive.
  const headers = new Headers(response.headers);
  const frameAncestors = embedFrameAncestors(url.searchParams.get("platform"));
  const inheritedCsp = headers.get("Content-Security-Policy");
  headers.set(
    "Content-Security-Policy",
    inheritedCsp
      ? swapCspFrameAncestors(inheritedCsp, frameAncestors)
      : frameAncestors,
  );
  headers.delete("X-Frame-Options");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
};
