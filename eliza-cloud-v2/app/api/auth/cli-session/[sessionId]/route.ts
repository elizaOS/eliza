import { NextRequest, NextResponse } from "next/server";
import { cliAuthSessionsService } from "@/lib/services/cli-auth-sessions";
import { logger } from "@/lib/utils/logger";

/**
 * GET /api/auth/cli-session/[sessionId]
 * Get the status of a CLI authentication session
 * Used by CLI to poll for authentication completion
 *
 * NOTE: This endpoint is PUBLIC (no auth required) for CLI polling
 */
export async function GET(
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

    const session = await cliAuthSessionsService.getActiveSession(sessionId);

    if (!session) {
      return NextResponse.json(
        { error: "Session not found or expired" },
        { status: 404 },
      );
    }

    // Check if session is authenticated
    if (session.status === "authenticated") {
      // Retrieve and clear the plain API key (one-time retrieval for security)
      const apiKeyData =
        await cliAuthSessionsService.getAndClearApiKey(sessionId);

      if (!apiKeyData) {
        return NextResponse.json(
          {
            status: "authenticated",
            message: "API key already retrieved",
          },
          { status: 200 },
        );
      }

      return NextResponse.json(
        {
          status: "authenticated",
          apiKey: apiKeyData.apiKey,
          keyPrefix: apiKeyData.keyPrefix,
          expiresAt: apiKeyData.expiresAt,
        },
        { status: 200 },
      );
    }

    // Session is still pending or expired
    return NextResponse.json(
      {
        status: session.status,
      },
      { status: 200 },
    );
  } catch (error) {
    logger.error("[CLI Auth] Error getting CLI auth session", { error });
    return NextResponse.json(
      { error: "Failed to get session status" },
      { status: 500 },
    );
  }
}
