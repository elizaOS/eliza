// Cloudflare Pages Function - proxies same-origin /steward/* to the API
// Worker, where the embedded Steward Hono app is mounted.

const DEFAULT_UPSTREAM = "https://api.elizacloud.ai";
const PREVIEW_UPSTREAM = "https://api-staging.elizacloud.ai";

interface Env {
  API_UPSTREAM?: string;
}

interface Context {
  request: Request;
  env: Env;
}

export const onRequest = async (context: Context): Promise<Response> => {
  const incoming = new URL(context.request.url);
  const fallbackUpstream = incoming.hostname.endsWith(".pages.dev")
    ? PREVIEW_UPSTREAM
    : DEFAULT_UPSTREAM;
  const upstream = (context.env.API_UPSTREAM ?? fallbackUpstream).replace(/\/+$/, "");
  const target = `${upstream}${incoming.pathname}${incoming.search}`;

  return fetch(new Request(target, context.request));
};
