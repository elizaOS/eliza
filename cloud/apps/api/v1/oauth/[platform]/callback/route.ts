/**
 * Generic OAuth Callback Route
 *
 * GET /api/v1/oauth/:platform/callback
 *
 * Handles OAuth callback from providers that use the generic OAuth system.
 * Exchanges authorization code for tokens and stores the connection.
 *
 * Security:
 * - Rate limited to prevent brute-force attacks
 * - State parameter provides CSRF protection
 * - Redirect URL whitelist prevents open redirect attacks
 */

import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { getIpKey, rateLimit } from "@/lib/middleware/rate-limit-hono-cloudflare";
import type { AppEnv } from "@/types/cloud-worker-env";
import { handleGenericOAuthCallback } from "../../generic-callback";

const app = new Hono<AppEnv>();

// 10 requests per minute per IP.
app.use(
  "*",
  rateLimit({
    windowMs: 60_000,
    maxRequests: 10,
    keyGenerator: (c) => `oauth:generic:callback:${getIpKey(c)}`,
  }),
);

app.get("/", async (c) => {
  try {
    const platform = c.req.param("platform");
    if (!platform) {
      return c.json({ error: "Missing platform parameter" }, 400);
    }
    return handleGenericOAuthCallback(c.req.raw, {
      params: Promise.resolve({ platform }),
    });
  } catch (error) {
    return failureResponse(c, error);
  }
});

export default app;
