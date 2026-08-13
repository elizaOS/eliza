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
  const target = resolveApiWorkerTarget(context.request.url, context.env);
  const method = context.request.method.toUpperCase();

  const upstreamRequest = new Request(target, {
    method,
    headers: context.request.headers,
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
