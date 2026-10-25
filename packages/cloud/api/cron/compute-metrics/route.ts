/**
 * GET|POST /api/cron/compute-metrics
 * Daily aggregation cron — rolls conversation/phone/eliza memory data into
 * `daily_metrics` and `retention_cohorts`. Protected by CRON_SECRET.
 *
 * Both verbs are registered: the Worker's scheduled() dispatcher fans out with
 * POST (see `makeCronHandler`), so a GET-only route 404s every cycle.
 */

import { requireCronSecret } from "@elizaos/cloud-shared/auth";
import { failureResponse } from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import { cache } from "@elizaos/cloud-shared/lib/cache/client";
import { CacheKeys } from "@elizaos/cloud-shared/lib/cache/keys";
import { userMetricsService } from "@elizaos/cloud-shared/lib/services/user-metrics";
import { logger } from "@elizaos/cloud-shared/lib/utils/logger";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { type Context, Hono } from "hono";

const app = new Hono<AppEnv>();

async function handle(c: Context<AppEnv>) {
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
}

app.get("/", handle);
app.post("/", handle);

export default app;
