import { NextRequest, NextResponse } from "next/server";
import { logger } from "@/lib/utils/logger";
import { cliAuthSessionsService } from "@/lib/services/cli-auth-sessions";

/**
 * POST /api/auth/cli-session
 * Creates a new CLI authentication session for command-line tool authentication.
 *
 * @param request - Request body with sessionId.
 * @returns Created session details with status and expiration.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { sessionId } = body;

    if (!sessionId || typeof sessionId !== "string") {
      return NextResponse.json(
        { error: "Session ID is required" },
        { status: 400 },
      );
    }

    // Create new session
    const session = await cliAuthSessionsService.createSession(sessionId);

    return NextResponse.json(
      {
        sessionId: session.session_id,
        status: session.status,
        expiresAt: session.expires_at,
      },
      { status: 201 },
    );
  } catch (error) {
    logger.error("Error creating CLI auth session:", error);
    return NextResponse.json(
      { error: "Failed to create authentication session" },
      { status: 500 },
    );
  }
}
