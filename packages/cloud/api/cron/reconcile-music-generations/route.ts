// Handles scheduled cloud API cron reconcile music generations route traffic with cron auth expectations.
import type { Context } from "hono";
import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireCronSecret } from "@/lib/auth/workers-hono-auth";
import { collectAudioProviderApiKeys } from "@/lib/providers/audio/registry";
import { reconcilePendingMusicGenerations } from "@/lib/services/music-generation-reconcile";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

/**
 * Settles music generations whose upstream job outlived the route's poll
 * window (#18436): verifies the upstream terminal state, charges on late
 * success, refunds exactly once on verified failure, and never refunds while
 * the job may still complete and bill the platform.
 */
async function handleReconcileMusicGenerations(c: Context<AppEnv>) {
  try {
    requireCronSecret(c);
    const stats = await reconcilePendingMusicGenerations({
      apiKeys: collectAudioProviderApiKeys(c.env),
    });
    logger.info(
      "[MusicReconcile] pending music settlement sweep complete",
      stats,
    );
    return c.json({ success: true, stats });
  } catch (error) {
    logger.error("[MusicReconcile] pending music settlement sweep failed", {
      error,
    });
    return failureResponse(c, error);
  }
}

app.post("/", handleReconcileMusicGenerations);

export default app;
