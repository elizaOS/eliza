/**
 * GET /api/v1/credits/balance — credit balance for the user's org.
 * Query: fresh=true bypasses cached session and fetches from DB.
 *
 * CORS is handled globally (wildcard origin, no credentials).
 */

import { Hono } from "hono";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { RateLimitPresets, rateLimit } from "@/lib/middleware/rate-limit-hono-cloudflare";
import { getCreditBalanceResponse } from "@/lib/services/credit-balance-response";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.use("*", rateLimit(RateLimitPresets.STANDARD));

app.get("/", async (c) => {
  const user = await requireUserOrApiKeyWithOrg(c);
  const body = await getCreditBalanceResponse(user.organization_id);

  c.header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
  c.header("Pragma", "no-cache");
  c.header("Expires", "0");
  return c.json(body);
});

export default app;
