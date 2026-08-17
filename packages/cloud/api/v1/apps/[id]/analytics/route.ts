/** Handles app analytics summaries with shared date-range validation. */
import { Hono } from "hono";

import { parseDateRangeParams } from "@/lib/api/date-range-params";
import { isAppKeyOutOfScope } from "@/lib/auth/app-key-scope";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { appsService } from "@/lib/services/apps";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

/**
 * GET /api/v1/apps/[id]/analytics
 * Gets analytics data for a specific app.
 * Supports different time periods (hourly, daily, monthly) and custom date ranges.
 * Requires ownership verification.
 */
const app = new Hono<AppEnv>();

app.get("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const id = c.req.param("id");
    if (!id) return c.json({ success: false, error: "Missing app id" }, 400);
    const { searchParams } = new URL(c.req.url);

    // App-analytics grain identity, not leftover tax on analytics
    // projections periods, analytics requests view, or admin metrics
    // timeRange. The prior `as "hourly" | "daily" | "monthly"` cast
    // plus date_trunc fallback mapped MONTHLY / HOURLY / week onto
    // daily buckets, so operators asking for a month of grain received
    // days. Missing / empty still means daily. Garbage 400s before
    // getById / getAnalytics. Date-range parsing is untouched.
    const APP_PERIODS = ["hourly", "daily", "monthly"] as const;
    const requestedPeriod = searchParams.get("period");
    if (
      requestedPeriod != null &&
      requestedPeriod !== "" &&
      !APP_PERIODS.includes(requestedPeriod as (typeof APP_PERIODS)[number])
    ) {
      return c.json(
        {
          success: false,
          error: "invalid_period",
          message: 'period must be "hourly", "daily", or "monthly".',
        },
        400,
      );
    }
    const periodType = (requestedPeriod || "daily") as
      | "hourly"
      | "daily"
      | "monthly";
    const dateRange = parseDateRangeParams(searchParams);
    if (!dateRange.success) return c.json(dateRange, 400);
    const startDate =
      dateRange.startDate ?? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const endDate = dateRange.endDate ?? new Date();

    const existingApp = await appsService.getById(id);

    if (!existingApp) {
      return c.json({ success: false, error: "App not found" }, 404);
    }

    if (existingApp.organization_id !== user.organization_id) {
      return c.json({ success: false, error: "Access denied" }, 403);
    }
    if (await isAppKeyOutOfScope(c.get("apiKeyId"), id)) {
      return c.json({ success: false, error: "Access denied" }, 403);
    }

    const analytics = await appsService.getAnalytics(
      id,
      periodType,
      startDate,
      endDate,
    );
    const totalStats = await appsService.getTotalStats(id);

    return c.json({
      success: true,
      analytics,
      totalStats,
      period: {
        type: periodType,
        start: startDate.toISOString(),
        end: endDate.toISOString(),
      },
    });
  } catch (error) {
    // error-policy:J1 route boundary — every catch in v1/apps/* translates a thrown error into a structured HTTP failure (500 with an error body), never a fabricated 200 with empty analytics.
    logger.error("Failed to get app analytics:", error);
    return c.json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to get app analytics",
      },
      500,
    );
  }
});

export default app;
