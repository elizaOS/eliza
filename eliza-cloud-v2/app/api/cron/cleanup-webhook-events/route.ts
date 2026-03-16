import { type NextRequest, NextResponse } from "next/server";
import { webhookEventsRepository } from "@/db/repositories/webhook-events";
import { logger } from "@/lib/utils/logger";

/**
 * Retention period for webhook events in days.
 * Events older than this will be cleaned up.
 */
const WEBHOOK_EVENT_RETENTION_DAYS = 30;

/**
 * Cron job to clean up old webhook events.
 * Prevents table bloat from accumulated webhook event records.
 *
 * Should be scheduled to run daily.
 *
 * Example Vercel cron schedule: once per day at 2 AM UTC
 */
export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;

  if (!cronSecret) {
    logger.error("[Webhook Events Cleanup] CRON_SECRET not configured");
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (authHeader !== `Bearer ${cronSecret}`) {
    logger.warn("[Webhook Events Cleanup] Unauthorized cron attempt");
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    logger.info(
      "[Webhook Events Cleanup] Starting old webhook events cleanup",
      {
        retentionDays: WEBHOOK_EVENT_RETENTION_DAYS,
      },
    );

    const deletedCount = await webhookEventsRepository.cleanupOldEvents(
      WEBHOOK_EVENT_RETENTION_DAYS,
    );

    logger.info("[Webhook Events Cleanup] Cleanup completed", {
      deletedCount,
      retentionDays: WEBHOOK_EVENT_RETENTION_DAYS,
    });

    return NextResponse.json({
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
    return NextResponse.json({ error: "Cleanup job failed" }, { status: 500 });
  }
}
