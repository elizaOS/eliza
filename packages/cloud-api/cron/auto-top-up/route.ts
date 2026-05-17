/**
 * GET /api/cron/auto-top-up
 * Periodic cron that processes auto top-up for orgs whose balance is below
 * threshold. Protected by CRON_SECRET.
 */

import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireCronSecret } from "@/lib/auth/workers-hono-auth";
import { autoTopUpService } from "@/lib/services/auto-top-up";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.get("/", async (c) => {
  const startTime = Date.now();
  try {
    requireCronSecret(c);

    logger.info("auto-top-up-cron", "Starting auto top-up check");

    const result = await autoTopUpService.checkAndExecuteAutoTopUps();
    const duration = Date.now() - startTime;

    logger.info("auto-top-up-cron", "Auto top-up check completed", {
      duration: `${duration}ms`,
      checked: result.organizationsChecked,
      processed: result.organizationsProcessed,
      successful: result.successful,
      failed: result.failed,
    });

    return c.json({
      success: true,
      message: "Auto top-up check completed successfully",
      stats: {
        timestamp: result.timestamp.toISOString(),
        duration: `${duration}ms`,
        organizationsChecked: result.organizationsChecked,
        organizationsProcessed: result.organizationsProcessed,
        successful: result.successful,
        failed: result.failed,
        details: result.results.map((r) => ({
          organizationId: r.organizationId,
          success: r.success,
          amount: r.amount,
          newBalance: r.newBalance,
          error: r.error,
        })),
      },
    });
  } catch (error) {
    const duration = Date.now() - startTime;
    logger.error("auto-top-up-cron", "Auto top-up check failed", {
      error: error instanceof Error ? error.message : "Unknown error",
      duration: `${duration}ms`,
    });
    return failureResponse(c, error);
  }
});

export default app;
