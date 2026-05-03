/**
 * GET /api/stats/account
 * Account statistics: generations (all-time) + API calls (24h).
 */

import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { RateLimitPresets, rateLimit } from "@/lib/middleware/rate-limit-hono-cloudflare";
import { generationsService } from "@/lib/services/generations";
import { usageService } from "@/lib/services/usage";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.use("*", rateLimit(RateLimitPresets.STANDARD));

app.get("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const orgId = user.organization_id;
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const generationStats = await generationsService.getStats(orgId);
    const apiCallStats24h = await usageService.getStatsByOrganization(orgId, twentyFourHoursAgo);

    const imageCount = generationStats.byType.find((t) => t.type === "image")?.count || 0;
    const videoCount = generationStats.byType.find((t) => t.type === "video")?.count || 0;

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
