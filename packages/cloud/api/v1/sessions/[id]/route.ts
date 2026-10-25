/**
 * Session revocation contract for account-security clients.
 *
 * The list endpoint currently advertises session inventory as unavailable, so
 * the console will not call this route. Keeping the method mounted prevents a
 * future stale client from seeing a route miss and gives callers the real
 * product state: revocation depends on the session inventory backend shipping.
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
