/**
 * Session revocation contract for account-security clients.
 *
 * The list endpoint currently advertises session inventory as unavailable, so
 * the console will not call this route. Keeping the method mounted prevents a
 * future stale client from seeing a route miss and gives callers the real
 * product state: revocation depends on the session inventory backend shipping.
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

app.delete("/", async (c) => {
  try {
    await requireUserOrApiKeyWithOrg(c);

    return c.json(
      {
        success: false,
        code: "session_revocation_unavailable",
        error: "Session revocation is not available on this server",
      },
      501,
    );
  } catch (error) {
    return failureResponse(c, error);
  }
});

export default app;
