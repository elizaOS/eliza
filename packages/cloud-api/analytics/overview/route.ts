/**
 * GET /api/analytics/overview
 * Analytics overview for the authenticated user's organization.
 */

import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { RateLimitPresets, rateLimit } from "@/lib/middleware/rate-limit-hono-cloudflare";
import { analyticsService } from "@/lib/services/analytics";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.use("*", rateLimit(RateLimitPresets.STANDARD));

app.get("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const timeRange =
      (c.req.query("timeRange") as "daily" | "weekly" | "monthly" | undefined) || "daily";

    const overview = await analyticsService.getOverview(user.organization_id, timeRange);

    const now = new Date();
    const startDate = (() => {
      switch (timeRange) {
        case "daily":
          return new Date(now.getTime() - 24 * 60 * 60 * 1000);
        case "weekly":
          return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        case "monthly":
          return new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
        default:
          return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      }
    })();

    return c.json({
      success: true,
      data: {
        totalRequests: overview.summary.totalRequests,
        successfulRequests: Math.round(
          overview.summary.totalRequests * overview.summary.successRate,
        ),
        failedRequests:
          overview.summary.totalRequests -
          Math.round(overview.summary.totalRequests * overview.summary.successRate),
        successRate: overview.summary.successRate,
        totalCost: overview.summary.totalCost,
        avgCostPerRequest: overview.summary.avgCostPerRequest,
        avgTokensPerRequest:
          overview.summary.totalRequests > 0
            ? overview.summary.totalTokens / overview.summary.totalRequests
            : 0,
        totalTokens: overview.summary.totalTokens,
        dailyBurn: overview.summary.totalCost,
        timeRange,
        periodStart: startDate.toISOString(),
        periodEnd: now.toISOString(),
      },
    });
  } catch (error) {
    logger.error("[Analytics Overview] Error:", error);
    return failureResponse(c, error);
  }
});

export default app;
