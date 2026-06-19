// Same-origin reverse proxy for the hosted-web Eliza app (Topology A).
//
// When `packages/app` is deployed to Cloudflare Pages at the `elizacloud.ai`
// apex (the cutover that replaces the `cloud-frontend` deploy), the browser
// talks to the Cloud API over same-origin `/api/*` and `/steward/*` paths.
// This module forwards those paths to the Workers API so the Steward
// cookie/JWT stays first-party and no CORS preflight is needed.
//
// It mirrors `packages/cloud-frontend/functions/_proxy.ts` 1:1 so the apex
// behaviour is identical before and after cutover. Do NOT diverge the upstream
// selection logic — the existing CORS/redirect/cookie allowlists on the backend
// assume the same apex origin and same `api.elizacloud.ai` upstream.

const DEFAULT_UPSTREAM = "https://api.elizacloud.ai";
const PREVIEW_UPSTREAM = "https://api-staging.elizacloud.ai";

export interface PagesProxyEnv {
  API_UPSTREAM?: string;
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
  const fallbackUpstream = incoming.hostname.endsWith(".pages.dev")
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

  return fetch(
    new Request(target, {
      method,
      headers: context.request.headers,
      body:
        method === "GET" || method === "HEAD"
          ? undefined
          : context.request.body,
      redirect: "manual",
    }),
  );
}
