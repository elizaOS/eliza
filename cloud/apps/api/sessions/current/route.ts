/**
 * GET /api/sessions/current
 * Statistics for the current user session: credits, requests, tokens.
 */

import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { RateLimitPresets, rateLimit } from "@/lib/middleware/rate-limit-hono-cloudflare";
import { userSessionsService } from "@/lib/services/user-sessions";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.use("*", rateLimit(RateLimitPresets.STANDARD));

app.get("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const stats = await userSessionsService.getCurrentSessionStats(user.id);
    return c.json({
      success: true,
      data: stats
        ? {
            credits_used: stats.credits_used,
            requests_made: stats.requests_made,
            tokens_consumed: stats.tokens_consumed,
          }
        : { credits_used: 0, requests_made: 0, tokens_consumed: 0 },
    });
  } catch (error) {
    logger.error("Error fetching current session stats:", error);
    return failureResponse(c, error);
  }
});

export default app;
