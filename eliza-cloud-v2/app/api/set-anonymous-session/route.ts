import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { anonymousSessionsService } from "@/lib/services/anonymous-sessions";
import { usersService } from "@/lib/services/users";
import { logger } from "@/lib/utils/logger";
import { dbWrite } from "@/db/client";
import { users, anonymousSessions } from "@/db/schemas";
import { eq } from "drizzle-orm";

const ANON_SESSION_COOKIE = "eliza-anon-session";

/**
 * POST /api/set-anonymous-session
 * Sets the anonymous session cookie when a user arrives with a session token.
 * Public endpoint - no authentication required.
 * Necessary because the affiliate API creates the session server-side,
 * but the cookie needs to be set in the user's browser.
 *
 * Request Body:
 * - `sessionToken`: The anonymous session token to set (required).
 *
 * @param request - Request body with sessionToken.
 * @returns Success status with user and session IDs.
 */
export async function POST(request: NextRequest) {
  logger.info("[Set Session] Received request to set anonymous session cookie");

  try {
    // Parse request body
    let body;
    try {
      body = await request.json();
    } catch (parseError) {
      logger.error("[Set Session] Failed to parse request body:", parseError);
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const { sessionToken } = body;

    if (!sessionToken || typeof sessionToken !== "string") {
      logger.warn("[Set Session] Missing or invalid session token in request");
      return NextResponse.json(
        { error: "Session token is required" },
        { status: 400 },
      );
    }

    logger.info(
      "[Set Session] Looking up session:",
      sessionToken.substring(0, 8) + "...",
    );

    // Validate that the session exists
    const session = await anonymousSessionsService.getByToken(sessionToken);

    if (!session) {
      logger.warn(
        "[Set Session] Session not found for token:",
        sessionToken.substring(0, 8) + "...",
      );
      return NextResponse.json(
        { error: "Invalid session token", code: "SESSION_NOT_FOUND" },
        { status: 404 },
      );
    }

    logger.info("[Set Session] Session found:", {
      sessionId: session.id,
      userId: session.user_id,
      expiresAt: session.expires_at,
    });

    // Check if session is expired
    if (session.expires_at < new Date()) {
      logger.warn("[Set Session] Session expired:", session.id);
      return NextResponse.json(
        { error: "Session has expired", code: "SESSION_EXPIRED" },
        { status: 410 },
      );
    }

    // Check if the user exists (handles old-style sessions with placeholder user_id)
    let user = await usersService.getById(session.user_id);

    if (!user) {
      // User doesn't exist - create a real anonymous user and update the session
      logger.info(
        "[Set Session] User not found, creating anonymous user for session:",
        session.id,
      );

      // Create anonymous user
      const [newUser] = await dbWrite
        .insert(users)
        .values({
          is_anonymous: true,
          anonymous_session_id: sessionToken,
          organization_id: null,
          is_active: true,
          expires_at: session.expires_at,
          role: "member",
        })
        .returning();

      // Update the existing session to point to the new user
      await dbWrite
        .update(anonymousSessions)
        .set({ user_id: newUser.id })
        .where(eq(anonymousSessions.id, session.id));

      user = newUser;
      logger.info("[Set Session] Created anonymous user:", newUser.id);
    }

    // Set the cookie
    try {
      const cookieStore = await cookies();
      cookieStore.set(ANON_SESSION_COOKIE, sessionToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        path: "/",
        expires: session.expires_at,
      });
      logger.info("[Set Session] Cookie set successfully");
    } catch (cookieError) {
      logger.error("[Set Session] Failed to set cookie:", cookieError);
      // Continue anyway - the session is valid, just cookie setting failed
    }

    logger.info("[Set Session] ✅ Successfully processed session", {
      sessionId: session.id,
      userId: user.id,
    });

    return NextResponse.json({
      success: true,
      message: "Session cookie set successfully",
      userId: user.id,
      sessionId: session.id,
    });
  } catch (error) {
    logger.error("[Set Session] Unexpected error:", error);
    return NextResponse.json(
      {
        error: "Internal server error",
        code: "INTERNAL_ERROR",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}
