/**
 * Legacy `?provider=…` wrapper for the generic OAuth callback flow.
 *
 * GET /api/v1/oauth/callback?provider=<platform>
 *
 * Same logic as GET /api/v1/oauth/:platform/callback, but reads the platform
 * from the `provider` query parameter for clients that pre-date the dynamic
 * route shape.
 */

import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { getIpKey, rateLimit } from "@/lib/middleware/rate-limit-hono-cloudflare";
import type { AppEnv } from "@/types/cloud-worker-env";
import { handleGenericOAuthCallback } from "../generic-callback";

const app = new Hono<AppEnv>();

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
    const provider = c.req.query("provider")?.toLowerCase();
    if (!provider) {
      return c.json({ error: "provider query parameter is required" }, 400);
    }
    return handleGenericOAuthCallback(c.req.raw, {
      params: Promise.resolve({ platform: provider }),
    });
  } catch (error) {
    return failureResponse(c, error);
  }
});

export default app;
