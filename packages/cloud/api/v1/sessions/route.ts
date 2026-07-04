/**
 * Account session listing contract for the account-security console.
 *
 * Steward owns browser-session material today, and the Cloud Worker does not
 * yet have a revocable session inventory. Returning an explicit unavailable
 * state keeps the UI honest without making a missing route look like a healthy
 * empty session list.
 */

import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import {
  RateLimitPresets,
  rateLimit,
} from "@/lib/middleware/rate-limit-hono-cloudflare";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.use("*", rateLimit(RateLimitPresets.STANDARD));

app.get("/", async (c) => {
  try {
    await requireUserOrApiKeyWithOrg(c);

    return c.json({
      available: false,
      reason: "session_inventory_unavailable",
      sessions: [],
    });
  } catch (error) {
    return failureResponse(c, error);
  }
});

export default app;
