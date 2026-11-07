// Handles scheduled cloud API cron reconcile video generations route traffic with cron auth expectations.

import { requireCronSecret } from "@elizaos/cloud-shared/auth";
import { failureResponse } from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import { collectVideoProviderApiKeys } from "@elizaos/cloud-shared/lib/providers/video/registry";
import { reconcilePendingVideoGenerations } from "@elizaos/cloud-shared/lib/services/video-generation-reconcile";
import { logger } from "@elizaos/cloud-shared/lib/utils/logger";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import type { Context } from "hono";
import { Hono } from "hono";

const app = new Hono<AppEnv>();

/**
 * Settles video generations whose upstream job outlived the route's poll
 * window (#11862): verifies the upstream terminal state, charges on late
 * success, refunds exactly once on verified failure, and never refunds while
 * the job may still complete and bill the platform.
 */
async function handleReconcileVideoGenerations(c: Context<AppEnv>) {
  try {
    requireCronSecret(c);
    const stats = await reconcilePendingVideoGenerations({
      apiKeys: collectVideoProviderApiKeys(c.env),
    });
    logger.info(
      "[VideoReconcile] pending video settlement sweep complete",
      stats,
    );
    return c.json({ success: true, stats });
  } catch (error) {
    logger.error("[VideoReconcile] pending video settlement sweep failed", {
      error,
    });
    return failureResponse(c, error);
  }
}

app.post("/", handleReconcileVideoGenerations);

export default app;
