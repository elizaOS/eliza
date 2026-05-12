const DEFAULT_UPSTREAM = "https://api.elizacloud.ai";
const PREVIEW_UPSTREAM = "https://api-staging.elizacloud.ai";

export interface PagesProxyEnv {
  API_UPSTREAM?: string;
}

export interface PagesProxyContext {
  request: Request;
  env: PagesProxyEnv;
}

export function resolveApiWorkerTarget(requestUrl: string, env: PagesProxyEnv): string {
  const incoming = new URL(requestUrl);
  const fallbackUpstream = incoming.hostname.endsWith(".pages.dev")
    ? PREVIEW_UPSTREAM
    : DEFAULT_UPSTREAM;
  const upstream = (env.API_UPSTREAM ?? fallbackUpstream).replace(/\/+$/, "");

  return `${upstream}${incoming.pathname}${incoming.search}`;
}

export function proxyToApiWorker(context: PagesProxyContext): Promise<Response> {
  const target = resolveApiWorkerTarget(context.request.url, context.env);
  const method = context.request.method.toUpperCase();

  return fetch(
    new Request(target, {
      method,
      headers: context.request.headers,
      body: method === "GET" || method === "HEAD" ? undefined : context.request.body,
      redirect: "manual",
    }),
  );
}
