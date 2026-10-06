/**
 * GET /api/sessions/current
 * Statistics for the current user session: credits, requests, tokens.
 */

import { requireUserOrApiKeyWithOrg } from "@elizaos/cloud-shared/auth";
import { failureResponse } from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import {
  RateLimitPresets,
  rateLimit,
} from "@elizaos/cloud-shared/lib/middleware/rate-limit-hono-cloudflare";
import { userSessionsService } from "@elizaos/cloud-shared/lib/services/user-sessions";
import { logger } from "@elizaos/cloud-shared/lib/utils/logger";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";

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
