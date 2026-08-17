/**
 * GET /api/analytics/projections
 * Cost projections + alerts based on the last 30 days of usage. Mirrors the
 * legacy `getProjectionsData` server action consumed by `AnalyticsPageClient`.
 */

import { Hono } from "hono";
import {
  generateProjectionAlerts,
  generateProjections,
} from "@/lib/analytics/projections";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import {
  RateLimitPresets,
  rateLimit,
} from "@/lib/middleware/rate-limit-hono-cloudflare";
import { analyticsService } from "@/lib/services/analytics";
import { analyticsAlertsService } from "@/lib/services/analytics-alerts";
import { toSuccessRatePercent } from "@/lib/services/analytics-derived";
import { organizationsService } from "@/lib/services/organizations";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.use("*", rateLimit(RateLimitPresets.STANDARD));

app.get("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const periodsRaw = c.req.query("periods");
    let periods = 7;
    if (periodsRaw !== undefined && periodsRaw !== "") {
      // Forecast horizon is a canonical positive integer. Number("1e2") is 100
      // and Number("12px") is NaN — both used to silently forecast the wrong
      // window (capped 90 or default 7) instead of rejecting the query.
      if (!/^[1-9]\d*$/.test(periodsRaw)) {
        return c.json({ error: "Invalid periods" }, 400);
      }
      const parsed = Number(periodsRaw);
      if (!Number.isSafeInteger(parsed) || parsed < 1) {
        return c.json({ error: "Invalid periods" }, 400);
      }
      periods = Math.min(parsed, 90);
    }

    const now = new Date();
    const startDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const [historicalData, organization] = await Promise.all([
      analyticsService.getUsageTimeSeries(user.organization_id, {
        startDate,
        endDate: now,
        granularity: "day",
      }),
      organizationsService.getById(user.organization_id),
    ]);

    if (!organization) {
      throw new Error(`Organization ${user.organization_id} not found`);
    }

    const creditBalance = Number(organization.credit_balance ?? 0);
    const projections = generateProjections(historicalData, periods);
    const alerts = generateProjectionAlerts(
      historicalData,
      projections,
      creditBalance,
    );
    const alertEvents = await analyticsAlertsService.persistProjectionAlerts({
      organizationId: user.organization_id,
      alerts,
      historicalData,
      projectedData: projections,
      creditBalance,
    });

    return c.json({
      success: true,
      data: {
        historicalData: historicalData.map((point) => ({
          timestamp: point.timestamp.toISOString(),
          totalRequests: point.totalRequests,
          totalCost: point.totalCost,
          inputTokens: point.inputTokens,
          outputTokens: point.outputTokens,
          successRate: point.successRate,
          successRatePercent: toSuccessRatePercent(point.successRate),
        })),
        projections,
        alerts: alerts.map((alert) => {
          const event = alertEvents.find(
            (candidate) => candidate.title === alert.title,
          );
          return {
            ...alert,
            eventId: event?.id,
            severity: event?.severity,
            status: event?.status,
          };
        }),
        alertEvents,
        creditBalance,
      },
    });
  } catch (error) {
    logger.error("[Analytics Projections] Error:", error);
    return failureResponse(c, error);
  }
});

export default app;
