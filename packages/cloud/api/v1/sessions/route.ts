/**
 * Account session listing contract for the account-security console.
 *
 * Steward owns browser-session material today, and the Cloud Worker does not
 * yet have a revocable session inventory. Returning an explicit unavailable
 * state keeps the UI honest without making a missing route look like a healthy
 * empty session list.
 */

import { requireUserOrApiKeyWithOrg } from "@elizaos/cloud-shared/auth";
import { failureResponse } from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import {
  RateLimitPresets,
  rateLimit,
} from "@elizaos/cloud-shared/lib/middleware/rate-limit-hono-cloudflare";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";

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
