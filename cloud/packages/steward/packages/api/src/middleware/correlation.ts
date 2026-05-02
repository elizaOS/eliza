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

export const correlationId = createMiddleware(async (c, next) => {
  // Accept client-provided request ID or generate a new one
  const requestId = c.req.header("X-Request-Id") || crypto.randomUUID();

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
export function getRequestId(c: { get: (key: "requestId") => string | undefined }): string {
  return c.get("requestId") || "unknown";
}
