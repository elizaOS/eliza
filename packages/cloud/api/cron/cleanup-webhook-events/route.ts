/**
 * GET|POST /api/cron/cleanup-webhook-events
 * Removes webhook event records older than the retention period.
 *
 * Both verbs are registered: the Worker's scheduled() dispatcher fans out with
 * POST (see `makeCronHandler`), so a GET-only route 404s every cycle.
 */

import { type Context, Hono } from "hono";
import { webhookEventsRepository } from "@/db/repositories/webhook-events";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireCronSecret } from "@/lib/auth/workers-hono-auth";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const WEBHOOK_EVENT_RETENTION_DAYS = 30;

const app = new Hono<AppEnv>();

async function handle(c: Context<AppEnv>) {
  try {
    requireCronSecret(c);

    logger.info(
      "[Webhook Events Cleanup] Starting old webhook events cleanup",
      {
        retentionDays: WEBHOOK_EVENT_RETENTION_DAYS,
      },
    );

    const deletedCount = await webhookEventsRepository.cleanupOldEvents(
      WEBHOOK_EVENT_RETENTION_DAYS,
    );

    return c.json({
      success: true,
      deleted: deletedCount,
      retentionDays: WEBHOOK_EVENT_RETENTION_DAYS,
      message:
        deletedCount > 0
          ? `Cleaned up ${deletedCount} old webhook events`
          : "No old webhook events to clean up",
    });
  } catch (error) {
    logger.error("[Webhook Events Cleanup] Cleanup job failed", { error });
    return failureResponse(c, error);
  }
}

app.get("/", handle);
app.post("/", handle);

export default app;
