/**
 * GET /api/stats/account
 * Account statistics: generations (all-time) + API calls (24h).
 */

import { requireUserOrApiKeyWithOrg } from "@elizaos/cloud-shared/auth";
import { failureResponse } from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import {
  RateLimitPresets,
  rateLimit,
} from "@elizaos/cloud-shared/lib/middleware/rate-limit-hono-cloudflare";
import { generationsService } from "@elizaos/cloud-shared/lib/services/generations";
import { usageService } from "@elizaos/cloud-shared/lib/services/usage";
import { logger } from "@elizaos/cloud-shared/lib/utils/logger";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";

const app = new Hono<AppEnv>();

app.use("*", rateLimit(RateLimitPresets.STANDARD));

app.get("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const orgId = user.organization_id;
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const generationStats = await generationsService.getStats(orgId);
    const apiCallStats24h = await usageService.getStatsByOrganization(
      orgId,
      twentyFourHoursAgo,
    );

    const imageCount =
      generationStats.byType.find((t) => t.type === "image")?.count || 0;
    const videoCount =
      generationStats.byType.find((t) => t.type === "video")?.count || 0;

    return c.json({
      success: true,
      data: {
        totalGenerations: generationStats.totalGenerations,
        totalGenerationsBreakdown: { images: imageCount, videos: videoCount },
        apiCalls24h: apiCallStats24h.totalRequests,
        apiCalls24hSuccessful: Math.round(
          apiCallStats24h.totalRequests * apiCallStats24h.successRate,
        ),
        imageGenerationsAllTime: imageCount,
        videoRendersAllTime: videoCount,
      },
    });
  } catch (error) {
    logger.error("Error fetching account stats:", error);
    return failureResponse(c, error);
  }
});

export default app;
