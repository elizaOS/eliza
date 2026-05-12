/**
 * /api/v1/cron/health-check
 * Cron job that monitors deployed container health. Schedule: every minute
 * (registered in CRON_FANOUT for "* * * * *" alongside deployment-monitor).
 * Protected by CRON_SECRET; supports GET (Workers cron trigger) and POST (manual hits).
 */

import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireCronSecret } from "@/lib/auth/workers-hono-auth";
import { monitorAllContainers } from "@/lib/services/health-monitor";
import { logger } from "@/lib/utils/logger";
import type { AppContext, AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

async function runHealthCheck(c: AppContext) {
  try {
    requireCronSecret(c);

    logger.info("[Health Check Cron] Starting scheduled container health check");

    const results = await monitorAllContainers({
      checkIntervalMs: 60000,
      timeout: 10000,
      unhealthyThreshold: 3,
      retryOnFailure: true,
    });

    const healthyCount = results.filter((r) => r.healthy).length;
    const unhealthyCount = results.length - healthyCount;

    logger.info("[Health Check Cron] Health check completed", {
      total: results.length,
      healthy: healthyCount,
      unhealthy: unhealthyCount,
    });

    return c.json({
      success: true,
      data: {
        total: results.length,
        healthy: healthyCount,
        unhealthy: unhealthyCount,
        timestamp: new Date().toISOString(),
        results: results.map((r) => ({
          containerId: r.containerId,
          healthy: r.healthy,
          statusCode: r.statusCode,
          responseTime: r.responseTime,
          error: r.error,
        })),
      },
    });
  } catch (error) {
    logger.error(
      "[Health Check Cron] Failed:",
      error instanceof Error ? error.message : String(error),
    );
    return failureResponse(c, error);
  }
}

app.get("/", runHealthCheck);
app.post("/", runHealthCheck);

export default app;
