/**
 * Legacy `?provider=…` wrapper for the generic OAuth initiate flow.
 *
 * GET / POST /api/v1/oauth/initiate?provider=<platform>
 *
 * Same logic as POST /api/v1/oauth/:platform/initiate, but reads the platform
 * from the `provider` query parameter for clients that pre-date the dynamic
 * route shape.
 */

import type { Context } from "hono";
import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { getIpKey, rateLimit } from "@/lib/middleware/rate-limit-hono-cloudflare";
import type { AppEnv } from "@/types/cloud-worker-env";
import { handleGenericOAuthInitiate } from "../generic-initiate";

const app = new Hono<AppEnv>();

app.use(
  "*",
  rateLimit({
    windowMs: 60_000,
    maxRequests: 10,
    keyGenerator: (c) => `oauth:generic:initiate:${getIpKey(c)}`,
  }),
);

async function handle(c: Context<AppEnv>): Promise<Response> {
  try {
    const provider = c.req.query("provider")?.toLowerCase();
    if (!provider) {
      return c.json({ error: "provider query parameter is required" }, 400);
    }
    return handleGenericOAuthInitiate(c, provider);
  } catch (error) {
    return failureResponse(c, error);
  }
}

app.get("/", handle);
app.post("/", handle);

export default app;
