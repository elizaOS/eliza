// Handles scheduled cloud API cron reconcile video generations route traffic with cron auth expectations.
import type { Context } from "hono";
import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireCronSecret } from "@/lib/auth/workers-hono-auth";
import { collectVideoProviderApiKeys } from "@/lib/providers/video/registry";
import { reconcilePendingVideoGenerations } from "@/lib/services/video-generation-reconcile";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

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
