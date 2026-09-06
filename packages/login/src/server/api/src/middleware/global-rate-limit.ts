/**
 * global-rate-limit.ts — global Redis-backed sliding-window rate limiter for
 * the Cloudflare Workers entry (SEC-068).
 *
 * The Bun entry enforces a global in-memory IP limiter pre-dispatch
 * (`index.ts` runtimeGate). On Workers there is no shared per-isolate state,
 * so only route-specific limiters (auth, vault, proxy) applied and every
 * other endpoint was unthrottled. app.ts mounts this middleware across all
 * routes when it detects the Workers runtime; it reuses the auth surface's
 * shared limiter so subject derivation (trusted client IP, coarse per-host
 * fallback), the bounded Redis-outage valve, and the production fail-closed
 * posture stay identical across entries.
 */

import type { Context, Next } from "hono";
import { checkAuthRateLimit } from "../routes/auth";
import {
  RATE_LIMIT_MAX_REQUESTS,
  RATE_LIMIT_WINDOW_MS,
} from "../services/context";

export async function workersGlobalRateLimit(
  c: Context,
  next: Next,
): Promise<Response | undefined> {
  // Liveness probes must stay cheap and must not consume a client's budget.
  if (c.req.path === "/health") {
    await next();
    return undefined;
  }
  const verdict = await checkAuthRateLimit(
    c,
    "global",
    RATE_LIMIT_WINDOW_MS,
    RATE_LIMIT_MAX_REQUESTS,
  );
  if (!verdict.allowed) {
    return c.json(
      { ok: false, error: "Rate limit exceeded" },
      429,
      verdict.retryAfterSecs
        ? { "Retry-After": String(verdict.retryAfterSecs) }
        : undefined,
    );
  }
  await next();
  return undefined;
}
