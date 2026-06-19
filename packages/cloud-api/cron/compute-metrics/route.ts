/**
 * GET /api/cron/compute-metrics
 * Daily aggregation cron — rolls conversation/phone/eliza memory data into
 * `daily_metrics` and `retention_cohorts`. Protected by CRON_SECRET.
 */

import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireCronSecret } from "@/lib/auth/workers-hono-auth";
import { cache } from "@/lib/cache/client";
import { CacheKeys } from "@/lib/cache/keys";
import { userMetricsService } from "@/lib/services/user-metrics";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.get("/", async (c) => {
  const startTime = Date.now();
  try {
    requireCronSecret(c);
    logger.info("[Compute Metrics] Starting daily metrics computation");

    const yesterday = new Date();
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);

    await Promise.all([
      userMetricsService.computeDailyMetrics(yesterday),
      userMetricsService.computeRetentionCohorts(yesterday),
    ]);

    await cache.delPattern(CacheKeys.userMetrics.pattern());

    const duration = Date.now() - startTime;
    logger.info("[Compute Metrics] Completed", { duration });

    return c.json({
      success: true,
      data: {
        date: yesterday.toISOString().split("T")[0],
        duration,
        timestamp: new Date().toISOString(),
      },
    });
  } catch (error) {
    logger.error("[Compute Metrics] Failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return failureResponse(c, error);
  }
});

export default app;
