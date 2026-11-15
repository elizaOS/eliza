// Provides cloud utility cors helpers shared by backend services.
import {
  APP_SCHEME_ORIGIN_RE,
  CAPACITOR_WEBVIEW_ORIGIN,
  CORS_ALLOW_HEADERS,
  isLocalDevLoopbackOrigin,
} from "../cors-constants";
import { getCloudDeployment } from "../deployment/cloud-deployment";
import { getCloudAwareEnv } from "../runtime/cloud-bindings";

function isAllowedOrigin(origin: string): boolean {
  // Deployment web origins plus the Capacitor native shells (iOS WKWebView /
  // Android WebView), which call public auth endpoints from the WebView.
  if (getCloudDeployment().authCorsOrigins.has(origin) || APP_SCHEME_ORIGIN_RE.test(origin)) {
    return true;
  }
  // Portless https://localhost is the Capacitor WebView origin — first-party
  // in every environment (a browser page cannot mint it).
  if (origin === CAPACITOR_WEBVIEW_ORIGIN) {
    return true;
  }
  // Any-port loopback origins (incl. portless http://localhost) are a
  // local-dev convenience: credentialed reflection stays non-production only,
  // matching isFirstPartyOrigin in lib/cors/cloud-api-hono-cors.ts.
  if (isLocalDevLoopbackOrigin(origin)) {
    return getCloudAwareEnv().ENVIRONMENT !== "production";
  }
  return false;
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
