// Same-origin reverse proxy for the hosted-web Eliza app.
//
// `packages/app` is deployed to BOTH Cloudflare Pages projects: the
// `elizacloud.ai` apex (`eliza-cloud`, the cloud console origin) and the
// `app.elizacloud.ai` subdomain (`eliza-app`, the agent app). On both, the
// browser talks to the Cloud API over same-origin `/api/*` and `/steward/*`
// paths. This module forwards those paths to the Workers API so the Steward
// cookie/JWT stays first-party and no CORS preflight is needed.
//
// packages/cloud-frontend (which previously served the apex) has been deleted;
// the apex now serves this same proxy (see DECISIONS.md D6). Do NOT diverge the
// upstream selection logic — the CORS/redirect/cookie allowlists on the backend
// assume this apex origin and the `api.elizacloud.ai` upstream.

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
