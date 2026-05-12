/**
 * GET /api/analytics/projections
 * Cost projections + alerts based on the last 30 days of usage. Mirrors the
 * legacy `getProjectionsData` server action consumed by `AnalyticsPageClient`.
 */

import { Hono } from "hono";
import { generateProjectionAlerts, generateProjections } from "@/lib/analytics/projections";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { RateLimitPresets, rateLimit } from "@/lib/middleware/rate-limit-hono-cloudflare";
import { analyticsService } from "@/lib/services/analytics";
import { organizationsService } from "@/lib/services/organizations";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.use("*", rateLimit(RateLimitPresets.STANDARD));

app.get("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const periodsRaw = Number(c.req.query("periods") ?? "7");
    const periods = Number.isFinite(periodsRaw) && periodsRaw > 0 ? Math.min(periodsRaw, 90) : 7;

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
    const alerts = generateProjectionAlerts(historicalData, projections, creditBalance);

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
        })),
        projections,
        alerts,
        creditBalance,
      },
    });
  } catch (error) {
    logger.error("[Analytics Projections] Error:", error);
    return failureResponse(c, error);
  }
});

export default app;
