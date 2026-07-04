// Provides cloud utility cors helpers shared by backend services.
import { APP_LOCAL_ORIGIN_RE, APP_SCHEME_ORIGIN_RE, CORS_ALLOW_HEADERS } from "../cors-constants";

const ALLOWED_ORIGINS = [
  process.env.NEXT_PUBLIC_APP_URL,
  "https://eliza.app",
  "https://eliza.ai",
  "https://www.eliza.ai",
  "https://elizacloud.ai",
  "https://www.elizacloud.ai",
  // The Eliza agent app on its own subdomain (Pages project `eliza-app`).
  "https://app.elizacloud.ai",
  "https://app-staging.elizacloud.ai",
  // Exact develop branch alias for staging QA. Do not add a broad *.pages.dev
  // wildcard here; these auth routes can return API keys after login.
  "https://develop.eliza-app.pages.dev",
  "https://eliza.ai",
  "https://www.eliza.ai",
  // Capacitor native shells (iOS WKWebView / Android WebView). The
  // Eliza + Eliza mobile apps load from these custom schemes and
  // call public auth endpoints directly from the WebView.
  "capacitor://localhost",
  "http://localhost",
].filter(Boolean) as string[];

function isAllowedOrigin(origin: string): boolean {
  return (
    ALLOWED_ORIGINS.includes(origin) ||
    APP_LOCAL_ORIGIN_RE.test(origin) ||
    APP_SCHEME_ORIGIN_RE.test(origin)
  );
}

export function getCorsHeaders(origin: string | null): Record<string, string> {
  // Only reflect origin if it's in the allowlist; otherwise use first allowed origin or reject
  // Only set origin header for allowed origins, otherwise omit it entirely
  const allowedOrigin = origin && isAllowedOrigin(origin) ? origin : undefined; // Omit header for non-allowed origins

  const headers: Record<string, string> = {
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": CORS_ALLOW_HEADERS,
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };

  if (allowedOrigin) {
    headers["Access-Control-Allow-Origin"] = allowedOrigin;
    headers["Access-Control-Allow-Credentials"] = "true";
  }

  return headers;
}
