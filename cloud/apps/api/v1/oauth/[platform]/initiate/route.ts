/**
 * Generic OAuth Initiate Route
 *
 * POST /api/v1/oauth/:platform/initiate
 *
 * Initiates OAuth flow for any provider that uses the generic OAuth system.
 * Returns an authorization URL for the user to visit.
 */

import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { getIpKey, rateLimit } from "@/lib/middleware/rate-limit-hono-cloudflare";
import type { AppEnv } from "@/types/cloud-worker-env";
import { handleGenericOAuthInitiate } from "../../generic-initiate";

const app = new Hono<AppEnv>();

// 10 requests per minute per IP — prevents state cache flooding attacks.
app.use(
  "*",
  rateLimit({
    windowMs: 60_000,
    maxRequests: 10,
    keyGenerator: (c) => `oauth:generic:initiate:${getIpKey(c)}`,
  }),
);

app.post("/", async (c) => {
  try {
    const platform = c.req.param("platform");
    if (!platform) {
      return c.json({ error: "Missing platform parameter" }, 400);
    }
    return handleGenericOAuthInitiate(c, platform);
  } catch (error) {
    return failureResponse(c, error);
  }
});

export default app;
