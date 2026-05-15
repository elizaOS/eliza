/**
 * GET /api/analytics/breakdown
 * Full analytics breakdown for the authenticated user's organization.
 * Mirrors the legacy `getEnhancedAnalyticsData` shape consumed by
 * `AnalyticsPageClient`.
 */

import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { RateLimitPresets, rateLimit } from "@/lib/middleware/rate-limit-hono-cloudflare";
import { analyticsService } from "@/lib/services/analytics";
import { organizationsService } from "@/lib/services/organizations";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.use("*", rateLimit(RateLimitPresets.STANDARD));

type TimeRange = "daily" | "weekly" | "monthly";

function isTimeRange(value: string | undefined): value is TimeRange {
  return value === "daily" || value === "weekly" || value === "monthly";
}

function resolveDateRange(timeRange: TimeRange): {
  startDate: Date;
  endDate: Date;
  granularity: "hour" | "day" | "week" | "month";
  previousStartDate: Date;
  previousEndDate: Date;
} {
  const now = new Date();
  let startDate: Date;
  let granularity: "hour" | "day" | "week" | "month";

  switch (timeRange) {
    case "daily":
      startDate = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      granularity = "hour";
      break;
    case "weekly":
      startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      granularity = "day";
      break;
    case "monthly":
      startDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      granularity = "day";
      break;
  }

  const periodLength = now.getTime() - startDate.getTime();
  const previousEndDate = startDate;
  const previousStartDate = new Date(startDate.getTime() - periodLength);

  return {
    startDate,
    endDate: now,
    granularity,
    previousStartDate,
    previousEndDate,
  };
}

app.get("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const rawTimeRange = c.req.query("timeRange");
    const timeRange: TimeRange = isTimeRange(rawTimeRange) ? rawTimeRange : "weekly";

    const { startDate, endDate, granularity, previousStartDate, previousEndDate } =
      resolveDateRange(timeRange);

    const [
      overallStats,
      timeSeriesData,
      costTrending,
      providerBreakdown,
      modelBreakdown,
      trends,
      organization,
    ] = await Promise.all([
      analyticsService.getUsageStats(user.organization_id, { startDate, endDate }),
      analyticsService.getUsageTimeSeries(user.organization_id, {
        startDate,
        endDate,
        granularity,
      }),
      analyticsService.getCostTrending(user.organization_id),
      analyticsService.getProviderBreakdown(user.organization_id, { startDate, endDate }),
      analyticsService.getModelBreakdown(user.organization_id, {
        startDate,
        endDate,
        limit: 20,
      }),
      analyticsService.getTrendData(
        user.organization_id,
        { startDate, endDate },
        { startDate: previousStartDate, endDate: previousEndDate },
      ),
      organizationsService.getById(user.organization_id),
    ]);

    if (!organization) {
      throw new Error(`Organization ${user.organization_id} not found`);
    }

    return c.json({
      success: true,
      data: {
        filters: {
          startDate: startDate.toISOString(),
          endDate: endDate.toISOString(),
          granularity,
          timeRange,
        },
        overallStats,
        timeSeriesData: timeSeriesData.map((point) => ({
          timestamp: point.timestamp.toISOString(),
          totalRequests: point.totalRequests,
          totalCost: point.totalCost,
          inputTokens: point.inputTokens,
          outputTokens: point.outputTokens,
          successRate: point.successRate,
        })),
        costTrending,
        providerBreakdown,
        modelBreakdown,
        trends,
        organization: {
          creditBalance: organization.credit_balance,
        },
      },
    });
  } catch (error) {
    logger.error("[Analytics Breakdown] Error:", error);
    return failureResponse(c, error);
  }
});

export default app;
