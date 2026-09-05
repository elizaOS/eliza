/**
 * Request correlation ID middleware.
 *
 * Generates a unique UUID for each request and:
 * - Sets it on the request context for downstream use
 * - Returns it in the X-Request-Id response header
 *
 * Usage in route handlers:
 *   const requestId = c.get("requestId");
 *   console.log(`[${requestId}] Processing request...`);
 */

import { createMiddleware } from "hono/factory";

declare module "hono" {
  interface ContextVariableMap {
    requestId: string;
  }
}

// A client-supplied X-Request-Id is reflected into the response header and into
// log lines / error bodies keyed by it. To prevent log injection / log forging
// (attacker-chosen text — including CR/LF or control chars — landing in logs)
// and unbounded-length values, we accept the client value ONLY if it matches a
// conservative allowlist: URL/UUID-safe chars, 1–128 long. Anything else is
// discarded and a fresh UUID is generated instead.
const REQUEST_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

function sanitizeRequestId(value: string | undefined): string {
  if (value && REQUEST_ID_RE.test(value)) return value;
  return crypto.randomUUID();
}

export const correlationId = createMiddleware(async (c, next) => {
  // Accept a VALID client-provided request ID or generate a new one. Never
  // reflect an unvalidated client value into the response header or logs.
  const requestId = sanitizeRequestId(c.req.header("X-Request-Id"));

  // Set on context for downstream handlers
  c.set("requestId", requestId);

  // Set response header
  c.header("X-Request-Id", requestId);

  await next();
});

/**
 * Helper to get the current request ID from context.
 * Returns "unknown" if not in a request context.
 */
export function getRequestId(c: {
  get: (key: "requestId") => string | undefined;
}): string {
  return c.get("requestId") || "unknown";
}
