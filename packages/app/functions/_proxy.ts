/**
 * Same-origin reverse proxy for the unified Eliza web artifact.
 *
 * The same Pages deployment serves eliza.app and cloud.eliza.app. Browser
 * requests stay same-origin while this function forwards protocol paths to
 * the canonical API Worker, preserving host-only Steward cookies.
 */
import {
  ELIZA_DOMAIN_CONTRACTS,
  elizaCloudEnvironmentForHostname,
} from "@elizaos/shared/elizacloud/domain-contract";

// On every frontend host, the
// browser talks to the Cloud API over same-origin `/api/*` and `/steward/*`
// paths. This module forwards those paths to the Workers API so the Steward
// cookie/JWT stays first-party and no CORS preflight is needed.

const DEFAULT_UPSTREAM = ELIZA_DOMAIN_CONTRACTS.production.cloudApiOrigin;
const PREVIEW_UPSTREAM = ELIZA_DOMAIN_CONTRACTS.staging.cloudApiOrigin;

export interface PagesProxyEnv {
  API_UPSTREAM?: string;
  API_WORKER?: {
    fetch(request: Request): Promise<Response>;
  };
}

export interface PagesProxyContext {
  request: Request;
  env: PagesProxyEnv;
}

export function resolveApiWorkerTarget(
  requestUrl: string,
  env: PagesProxyEnv,
): string {
  const incoming = new URL(requestUrl);
  const environment = elizaCloudEnvironmentForHostname(incoming.hostname);
  const fallbackUpstream =
    incoming.hostname.endsWith(".pages.dev") || environment === "staging"
      ? PREVIEW_UPSTREAM
      : DEFAULT_UPSTREAM;
  const upstream = (env.API_UPSTREAM ?? fallbackUpstream).replace(/\/+$/, "");

  return `${upstream}${incoming.pathname}${incoming.search}`;
}

export function proxyToApiWorker(
  context: PagesProxyContext,
): Promise<Response> {
  const incoming = new URL(context.request.url);
  const target = resolveApiWorkerTarget(context.request.url, context.env);
  const method = context.request.method.toUpperCase();
  const headers = new Headers(context.request.headers);

  // Browsers omit Origin on same-origin GETs, including Steward's wallet nonce
  // request. The service binding changes the request URL to api.eliza.app, so
  // the API Worker cannot recover the browser host after this boundary. Stamp
  // the trusted Pages origin before forwarding. Preserve an explicit Origin:
  // browsers send it on cross-origin and mutating requests, where replacing it
  // would defeat Steward's origin and CSRF checks.
  if (
    !headers.has("origin") &&
    (incoming.pathname === "/steward" ||
      incoming.pathname.startsWith("/steward/"))
  ) {
    headers.set("origin", incoming.origin);
  }

  const upstreamRequest = new Request(target, {
    method,
    headers,
    body:
      method === "GET" || method === "HEAD" ? undefined : context.request.body,
    redirect: "manual",
  });

  // A Pages Function and an API Worker on routes in the same Cloudflare zone
  // cannot call each other through global fetch: the route is bypassed and
  // Cloudflare attempts to resolve an origin, producing 1016. The service
  // binding is therefore a required production invariant, not an optimization.
  if (!context.env.API_WORKER) {
    return Promise.resolve(
      new Response("Cloud API binding unavailable", {
        status: 503,
        headers: {
          "Cache-Control": "no-store",
          "Content-Type": "text/plain; charset=utf-8",
        },
      }),
    );
  }
  return context.env.API_WORKER.fetch(upstreamRequest);
}
