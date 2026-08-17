/**
 * Runs a bounded recovery and claim sweep for durable auto-top-up attempts.
 * The internal GET and scheduled POST boundary are protected by CRON_SECRET.
 */

import { type Context, Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireCronSecret } from "@/lib/auth/workers-hono-auth";
import { autoTopUpService } from "@/lib/services/auto-top-up";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();
const AUTO_TOP_UP_CRON_LIMIT = 100;

async function handleAutoTopUp(c: Context<AppEnv>) {
  const startTime = Date.now();
  try {
    requireCronSecret(c);

    const result = await autoTopUpService.checkAndExecuteAutoTopUps({
      source: "cron",
      limit: AUTO_TOP_UP_CRON_LIMIT,
    });
    const durationMs = Date.now() - startTime;

    logger.info("[AutoTopUp] Scheduled durable sweep completed", {
      durationMs,
      checked: result.organizationsChecked,
      processed: result.organizationsProcessed,
      successful: result.successful,
      failed: result.failed,
      recovered: result.recovered,
      claimed: result.claimed,
      skipped: result.skipped,
      rolloutPaused: result.rolloutPaused,
      cutoverPaused: result.cutoverPaused,
      controlMode: result.controlMode,
    });

    return c.json({
      success: true,
      message: "Auto top-up check completed successfully",
      cutoverPaused: result.cutoverPaused,
      controlMode: result.controlMode,
      stats: {
        timestamp: result.timestamp.toISOString(),
        durationMs,
        organizationsChecked: result.organizationsChecked,
        organizationsProcessed: result.organizationsProcessed,
        successful: result.successful,
        failed: result.failed,
        limit: AUTO_TOP_UP_CRON_LIMIT,
        recovered: result.recovered,
        claimed: result.claimed,
        skipped: result.skipped,
        rolloutPaused: result.rolloutPaused,
        cutoverPaused: result.cutoverPaused,
        controlMode: result.controlMode,
        details: result.results.map((item) => ({
          organizationId: item.organizationId,
          success: item.success,
          amount: item.amount,
          previousBalance: item.previousBalance,
          newBalance: item.newBalance,
          message: item.message,
          error: item.error,
          attemptId: item.attemptId,
          status: item.status,
          recovered: item.recovered,
        })),
      },
    });
  } catch (error) {
    // error-policy:J1 The internal HTTP boundary reports a retryable sweep failure.
    logger.error("[AutoTopUp] Scheduled durable sweep failed", {
      error: error instanceof Error ? error.message : "Unknown error",
      durationMs: Date.now() - startTime,
    });
    return failureResponse(c, error);
  }
}

app.get("/", handleAutoTopUp);
app.post("/", handleAutoTopUp);

export default app;
