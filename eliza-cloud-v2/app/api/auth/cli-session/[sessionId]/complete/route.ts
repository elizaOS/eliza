import { NextRequest, NextResponse } from "next/server";
import { logger } from "@/lib/utils/logger";
import { requireAuthWithOrg } from "@/lib/auth";
import { cliAuthSessionsService } from "@/lib/services/cli-auth-sessions";

/**
 * POST /api/auth/cli-session/[sessionId]/complete
 * Complete CLI authentication for a session
 * Called by the web UI after user logs in via Privy
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  try {
    const { sessionId } = await params;

    if (!sessionId) {
      return NextResponse.json(
        { error: "Session ID is required" },
        { status: 400 },
      );
    }

    // Require user to be authenticated via Privy
    const user = await requireAuthWithOrg();

    // Complete the authentication and generate API key
    const result = await cliAuthSessionsService.completeAuthentication(
      sessionId,
      user.id,
      user.organization_id!,
    );

    return NextResponse.json(
      {
        success: true,
        apiKey: result.apiKey,
        keyPrefix: result.keyPrefix,
        expiresAt: result.expiresAt,
      },
      { status: 200 },
    );
  } catch (error) {
    logger.error("Error completing CLI authentication:", error);

    if (error instanceof Error) {
      if (
        error.message.includes("Invalid or expired session") ||
        error.message.includes("already authenticated")
      ) {
        return NextResponse.json({ error: error.message }, { status: 400 });
      }
    }

    return NextResponse.json(
      { error: "Failed to complete authentication" },
      { status: 500 },
    );
  }
}
