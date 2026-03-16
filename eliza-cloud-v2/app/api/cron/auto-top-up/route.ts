/**
 * Cron Job: Auto Top-Up Balance Checker
 *
 * This endpoint should be called periodically (e.g., every 15-30 minutes) to:
 * 1. Find organizations with auto top-up enabled
 * 2. Check if balance is below threshold
 * 3. Automatically charge the configured amount
 * 4. Add credits to organization
 *
 * Setup with Vercel Cron (add to vercel.json):
 * Schedule: Every 15 minutes
 * Path: /api/cron/auto-top-up
 *
 * Or manually trigger via:
 * curl -H "Authorization: Bearer YOUR_CRON_SECRET" \
 *   https://your-domain.com/api/cron/auto-top-up
 */

import { type NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import { autoTopUpService } from "@/lib/services/auto-top-up";
import { logger } from "@/lib/utils/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300; // 5 minutes timeout for processing multiple orgs

/**
 * GET /api/cron/auto-top-up
 * Cron job endpoint that checks and executes auto top-ups for all organizations.
 * Protected by CRON_SECRET authentication.
 *
 * @param request - Request with Bearer token containing CRON_SECRET.
 * @returns Summary of auto top-up checks and executions.
 */
export async function GET(request: NextRequest) {
  const startTime = Date.now();

  try {
    // Verify cron secret using timing-safe comparison to prevent timing attacks
    const authHeader = request.headers.get("authorization");
    const cronSecret = process.env.CRON_SECRET;

    if (!cronSecret) {
      logger.error("auto-top-up-cron", "CRON_SECRET not configured");
      return NextResponse.json(
        { error: "Cron not configured" },
        { status: 500 },
      );
    }

    const providedSecret = authHeader?.replace("Bearer ", "") || "";

    // Use timing-safe comparison to prevent timing attacks
    const providedBuffer = Buffer.from(providedSecret, "utf8");
    const secretBuffer = Buffer.from(cronSecret, "utf8");

    const isValidSecret =
      providedBuffer.length === secretBuffer.length &&
      timingSafeEqual(providedBuffer, secretBuffer);

    if (!isValidSecret) {
      logger.warn("auto-top-up-cron", "Invalid cron secret provided");
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    logger.info("auto-top-up-cron", "Starting auto top-up check");

    // Execute auto top-up checks
    const result = await autoTopUpService.checkAndExecuteAutoTopUps();

    const duration = Date.now() - startTime;

    logger.info("auto-top-up-cron", "Auto top-up check completed", {
      duration: `${duration}ms`,
      checked: result.organizationsChecked,
      processed: result.organizationsProcessed,
      successful: result.successful,
      failed: result.failed,
    });

    // Return summary
    return NextResponse.json({
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

    return NextResponse.json(
      {
        success: false,
        error:
          error instanceof Error ? error.message : "Auto top-up check failed",
        duration: `${duration}ms`,
      },
      { status: 500 },
    );
  }
}
