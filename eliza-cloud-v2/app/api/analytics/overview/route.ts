import { type NextRequest, NextResponse } from "next/server";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import { analyticsService } from "@/lib/services/analytics";
import { logger } from "@/lib/utils/logger";
import { withRateLimit, RateLimitPresets } from "@/lib/middleware/rate-limit";

export const maxDuration = 60;

/**
 * GET /api/analytics/overview
 * Gets analytics overview for the authenticated user's organization.
 *
 * @param req - Request with optional timeRange query parameter (daily, weekly, monthly).
 * @returns Analytics summary including requests, costs, tokens, and success rates.
 */
async function handleGET(req: NextRequest) {
  try {
    const { user } = await requireAuthOrApiKeyWithOrg(req);
    const searchParams = req.nextUrl.searchParams;

    const timeRange =
      (searchParams.get("timeRange") as "daily" | "weekly" | "monthly") ||
      "daily";

    const overview = await analyticsService.getOverview(
      user.organization_id!,
      timeRange,
    );

    const now = new Date();
    let startDate: Date;

    switch (timeRange) {
      case "daily":
        startDate = new Date(now.getTime() - 24 * 60 * 60 * 1000);
        break;
      case "weekly":
        startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        break;
      case "monthly":
        startDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
        break;
      default:
        startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    }

    const data = {
      totalRequests: overview.summary.totalRequests,
      successfulRequests: Math.round(
        overview.summary.totalRequests * overview.summary.successRate,
      ),
      failedRequests:
        overview.summary.totalRequests -
        Math.round(
          overview.summary.totalRequests * overview.summary.successRate,
        ),
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
    };

    return NextResponse.json({
      success: true,
      data,
    });
  } catch (error) {
    logger.error("[Analytics Overview] Error:", error);
    return NextResponse.json(
      {
        success: false,
        error:
          error instanceof Error ? error.message : "Failed to fetch analytics",
      },
      { status: 500 },
    );
  }
}

export const GET = withRateLimit(handleGET, RateLimitPresets.STANDARD);
