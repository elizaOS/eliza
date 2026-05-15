/**
 * Admin Engagement Metrics API
 *
 * GET /api/v1/admin/metrics?view=overview|retention|daily&timeRange=7d|30d|90d
 *
 * Returns pre-computed and live engagement metrics for the admin dashboard.
 * Requires super_admin role.
 */

import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireAdmin } from "@/lib/auth/workers-hono-auth";
import { RateLimitPresets, rateLimit } from "@/lib/middleware/rate-limit-hono-cloudflare";
import { userMetricsService } from "@/lib/services/user-metrics";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const TIME_RANGE_MS: Record<string, number> = {
  "7d": 7 * 86_400_000,
  "30d": 30 * 86_400_000,
  "90d": 90 * 86_400_000,
};

const app = new Hono<AppEnv>();

app.use("*", rateLimit(RateLimitPresets.STANDARD));

app.get("/", async (c) => {
  try {
    const auth = await requireAdmin(c);
    if (auth.role !== "super_admin") {
      return c.json({ error: "Only super_admin can access engagement metrics" }, 403);
    }

    const view = c.req.query("view") || "overview";
    const timeRange = c.req.query("timeRange") || "30d";

    const rangeMs = TIME_RANGE_MS[timeRange] ?? TIME_RANGE_MS["30d"];
    const rangeDays = Math.round(rangeMs / 86_400_000);
    const now = new Date();
    const startDate = new Date(now.getTime() - rangeMs);

    switch (view) {
      case "overview":
        return c.json(await userMetricsService.getMetricsOverview(rangeDays));

      case "daily":
        return c.json(await userMetricsService.getDailyMetrics(startDate, now));

      case "retention":
        return c.json(await userMetricsService.getRetentionCohorts(startDate, now));

      case "active": {
        const activeRangeMap: Record<string, "day" | "7d" | "30d"> = {
          "7d": "7d",
          "30d": "30d",
          "90d": "30d",
        };
        const range = activeRangeMap[timeRange] ?? "day";
        return c.json(await userMetricsService.getActiveUsers(range));
      }

      case "signups":
        return c.json(await userMetricsService.getNewSignups(startDate, now));

      case "oauth":
        return c.json(await userMetricsService.getOAuthConnectionRate());

      default:
        return c.json({ error: "Unknown view parameter" }, 400);
    }
  } catch (error) {
    logger.error("[Admin Metrics API] Query failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return failureResponse(c, error);
  }
});

export default app;
