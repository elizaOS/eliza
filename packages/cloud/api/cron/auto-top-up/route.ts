/**
 * Exposes the secret-protected scheduled auto-top-up cutover check. Both the
 * Worker scheduler's POST and an operator's GET return the authoritative
 * paused state with zero work while this bridge release is deployed.
 */

import { type Context, Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireCronSecret } from "@/lib/auth/workers-hono-auth";
import { autoTopUpService } from "@/lib/services/auto-top-up";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

async function handleAutoTopUpCutover(c: Context<AppEnv>) {
  const startTime = Date.now();
  try {
    requireCronSecret(c);

    const result = await autoTopUpService.checkAndExecuteAutoTopUps();
    const durationMs = Date.now() - startTime;

    logger.info("[AutoTopUp] Scheduled cutover check remained sealed", {
      durationMs,
      controlMode: result.controlMode,
      checked: result.organizationsChecked,
      processed: result.organizationsProcessed,
    });

    return c.json({
      success: true,
      status: "cutover_paused" as const,
      message: "Auto top-up charging is paused during the durable cutover.",
      cutoverPaused: result.cutoverPaused,
      controlMode: result.controlMode,
      stats: {
        timestamp: result.timestamp.toISOString(),
        durationMs,
        organizationsChecked: result.organizationsChecked,
        organizationsProcessed: result.organizationsProcessed,
        successful: result.successful,
        failed: result.failed,
        details: result.results,
      },
    });
  } catch (error) {
    // error-policy:J1 boundary translation — a missing secret or unavailable
    // control authority is returned as failure, never fabricated zero work.
    logger.error("[AutoTopUp] Scheduled cutover check failed", {
      error: error instanceof Error ? error.message : String(error),
      durationMs: Date.now() - startTime,
    });
    return failureResponse(c, error);
  }
}

app.get("/", handleAutoTopUpCutover);
app.post("/", handleAutoTopUpCutover);

export default app;
