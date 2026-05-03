// Cloudflare Pages Function - proxies /api/* to the Workers API.
//
// Why this exists: Pages's `_redirects` 200-rewrite to an external origin
// does NOT actually proxy on the free tier (requests fall through to the
// SPA fallback). A Pages Function gives true same-origin behaviour for
// the browser, so /api/* hits this Function which forwards to the API
// Worker server-side. No CORS preflight, no API URL baked into the bundle.
//
// The catch-all [[path]].ts file matches every request under /api/.
// Cloudflare auto-discovers anything under functions/ at deploy time.
//
// Upstream is selected per Pages environment via the API_UPSTREAM env var
// configured in the Pages project settings:
//   production branch (main) => API_UPSTREAM=https://api.elizacloud.ai
//   staging branch           => API_UPSTREAM=https://api-staging.elizacloud.ai
// The fallback keeps custom production domains on production and sends Pages
// previews to staging so preview deploys do not mutate production state.

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

  // Pass-through: method, headers, body all preserved by re-using the
  // original Request as the init for the new one. Hop-by-hop headers
  // are stripped by the runtime; cookies (Set-Cookie) on the response
  // propagate back to the browser unchanged.
  return fetch(new Request(target, context.request));
};
