import { CORS_ALLOW_HEADERS } from "@/lib/cors-constants";

const ALLOWED_ORIGINS = [
  process.env.NEXT_PUBLIC_APP_URL,
  "https://eliza.app",
  "https://eliza.ai",
  "https://www.eliza.ai",
  "https://elizacloud.ai",
  "https://www.elizacloud.ai",
  "https://eliza.ai",
  "https://www.eliza.ai",
  // Capacitor native shells (iOS WKWebView / Android WebView). The
  // Eliza + Eliza mobile apps load from these custom schemes and
  // call public auth endpoints directly from the WebView.
  "capacitor://localhost",
  "http://localhost",
].filter(Boolean) as string[];

export function getCorsHeaders(origin: string | null): Record<string, string> {
  // Only reflect origin if it's in the allowlist; otherwise use first allowed origin or reject
  // Only set origin header for allowed origins, otherwise omit it entirely
  const allowedOrigin = origin && ALLOWED_ORIGINS.includes(origin) ? origin : undefined; // Omit header for non-allowed origins

  const headers: Record<string, string> = {
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": CORS_ALLOW_HEADERS,
    "Access-Control-Max-Age": "86400",
  };

  if (allowedOrigin) {
    headers["Access-Control-Allow-Origin"] = allowedOrigin;
    headers["Access-Control-Allow-Credentials"] = "true";
  }

  return headers;
}
