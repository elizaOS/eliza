/**
 * Security response headers — SOC2 CC6.7 (data in transit).
 *
 * Applies HSTS, a deny-by-default CSP, MIME-sniff lock, framing denial,
 * referrer policy, and a restrictive Permissions-Policy. HSTS is skipped for localhost/127.0.0.1
 * hosts and can be disabled globally via STEWARD_HSTS_DISABLED=true for
 * private dev deploys without HTTPS.
 */

import type { MiddlewareHandler } from "hono";

const STATIC_HEADERS: Record<string, string> = {
  "Content-Security-Policy": [
    "default-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "object-src 'none'",
  ].join("; "),
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "geolocation=(), microphone=(), camera=()",
};

const HSTS_VALUE = "max-age=63072000; includeSubDomains; preload";

export function isHstsEnabled(): boolean {
  return process.env.STEWARD_HSTS_DISABLED !== "true";
}

function hostFromRequest(req: Request): string {
  const host = req.headers.get("host") || "";
  return host.split(":")[0]?.toLowerCase() || "";
}

export const securityHeaders: MiddlewareHandler = async (c, next) => {
  await next();
  for (const [k, v] of Object.entries(STATIC_HEADERS)) c.header(k, v);

  if (!isHstsEnabled()) return;
  const host = hostFromRequest(c.req.raw);
  if (host === "localhost" || host === "127.0.0.1" || host === "::1") return;
  c.header("Strict-Transport-Security", HSTS_VALUE);
};
