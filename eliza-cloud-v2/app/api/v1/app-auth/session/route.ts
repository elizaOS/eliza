import { NextRequest, NextResponse } from "next/server";
import { logger } from "@/lib/utils/logger";
import { dbRead } from "@/db/client";
import { users } from "@/db/schemas/users";
import { apps } from "@/db/schemas/apps";
import { eq } from "drizzle-orm";
import { verifyAuthTokenCached } from "@/lib/auth";

export const dynamic = "force-dynamic";

// CORS headers - fully open, security via auth tokens
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, X-API-Key, X-App-Id, X-Request-ID",
  "Access-Control-Max-Age": "86400",
};

/**
 * OPTIONS /api/v1/app-auth/session
 * CORS preflight handler
 */
export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: CORS_HEADERS,
  });
}

/**
 * GET /api/v1/app-auth/session
 *
 * Get the current user's session for an app.
 * Validates the auth token and returns user info if valid.
 *
 * Headers:
 * - Authorization: Bearer <token>
 * - X-App-Id: <app_id> (optional but recommended)
 *
 * Returns:
 * - user: User info (id, email, name, avatar)
 * - app: App info (id, name) if X-App-Id provided
 */
export async function GET(request: NextRequest) {
  try {
    // Get auth token
    const authHeader = request.headers.get("Authorization");
    const appId = request.headers.get("X-App-Id");

    if (!authHeader?.startsWith("Bearer ")) {
      return NextResponse.json(
        { success: false, error: "Authorization header required" },
        { status: 401, headers: CORS_HEADERS },
      );
    }

    const token = authHeader.slice(7);

    // Verify the token with Privy
    const verifiedClaims = await verifyAuthTokenCached(token);

    if (!verifiedClaims) {
      return NextResponse.json(
        { success: false, error: "Invalid or expired token" },
        { status: 401, headers: CORS_HEADERS },
      );
    }

    // Get user from database
    const [user] = await dbRead
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
        avatar: users.avatar,
        createdAt: users.created_at,
      })
      .from(users)
      .where(eq(users.privy_user_id, verifiedClaims.userId))
      .limit(1);

    if (!user) {
      return NextResponse.json(
        { success: false, error: "User not found" },
        { status: 404, headers: CORS_HEADERS },
      );
    }

    // Optionally get app info
    let appInfo = null;
    if (appId) {
      const [app] = await dbRead
        .select({
          id: apps.id,
          name: apps.name,
        })
        .from(apps)
        .where(eq(apps.id, appId))
        .limit(1);

      if (app) {
        appInfo = app;
      }
    }

    logger.info("App auth session verified", {
      userId: user.id,
      appId,
    });

    return NextResponse.json(
      {
        success: true,
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          avatar: user.avatar,
          createdAt: user.createdAt,
        },
        app: appInfo,
      },
      { headers: CORS_HEADERS },
    );
  } catch (error) {
    logger.error("App auth session error:", error);
    return NextResponse.json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Session verification failed",
      },
      { status: 500, headers: CORS_HEADERS },
    );
  }
}
