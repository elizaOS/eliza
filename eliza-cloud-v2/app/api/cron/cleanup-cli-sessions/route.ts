import { NextRequest, NextResponse } from "next/server";
import { logger } from "@/lib/utils/logger";
import { cliAuthSessionsService } from "@/lib/services/cli-auth-sessions";

/**
 * GET /api/cron/cleanup-cli-sessions
 * Cron job endpoint that cleans up expired CLI authentication sessions.
 * Protected by CRON_SECRET authentication.
 *
 * @param request - Request with Bearer token containing CRON_SECRET.
 * @returns Success status.
 */
export async function GET(request: NextRequest) {
  try {
    // Verify cron secret
    const authHeader = request.headers.get("authorization");
    const cronSecret = process.env.CRON_SECRET;

    if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Clean up expired sessions
    await cliAuthSessionsService.cleanupExpiredSessions();

    return NextResponse.json({
      success: true,
      message: "Expired CLI auth sessions cleaned up successfully",
    });
  } catch (error) {
    logger.error("Error cleaning up CLI auth sessions:", error);
    return NextResponse.json(
      { error: "Failed to clean up sessions" },
      { status: 500 },
    );
  }
}
