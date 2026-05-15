import { Hono } from "hono";

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

    const periodType = (searchParams.get("period") || "daily") as "hourly" | "daily" | "monthly";
    const startDate = searchParams.get("start_date")
      ? new Date(searchParams.get("start_date")!)
      : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const endDate = searchParams.get("end_date")
      ? new Date(searchParams.get("end_date")!)
      : new Date();

    const existingApp = await appsService.getById(id);

    if (!existingApp) {
      return c.json({ success: false, error: "App not found" }, 404);
    }

    if (existingApp.organization_id !== user.organization_id) {
      return c.json({ success: false, error: "Access denied" }, 403);
    }

    const analytics = await appsService.getAnalytics(id, periodType, startDate, endDate);
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
    logger.error("Failed to get app analytics:", error);
    return c.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Failed to get app analytics",
      },
      500,
    );
  }
});

export default app;
