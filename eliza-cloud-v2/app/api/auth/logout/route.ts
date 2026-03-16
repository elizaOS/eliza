import { NextRequest, NextResponse } from "next/server";
import { logger } from "@/lib/utils/logger";
import { cookies } from "next/headers";
import { withRateLimit, RateLimitPresets } from "@/lib/middleware/rate-limit";
import { getCurrentUser, invalidateSessionCaches } from "@/lib/auth";
import { userSessionsService } from "@/lib/services/user-sessions";

/**
 * POST /api/auth/logout
 * Logs out the current user by ending all sessions and clearing auth cookies.
 * Also invalidates Redis caches to ensure immediate token invalidation.
 *
 * @param req - The Next.js request object.
 * @returns JSON response indicating success or failure.
 */
async function handlePOST(req: NextRequest) {
  try {
    const cookieStore = await cookies();
    const privyToken = cookieStore.get("privy-token")?.value;

    const user = await getCurrentUser();

    // Invalidate Redis caches BEFORE deleting cookies
    // This ensures the token can't be used even if cached
    if (privyToken) {
      await invalidateSessionCaches(privyToken);
      logger.debug("[Logout] Invalidated session caches for token");
    }

    if (user) {
      await userSessionsService.endAllUserSessions(user.id);
    }

    cookieStore.delete("privy-token");
    cookieStore.delete("privy-refresh-token");
    cookieStore.delete("privy-id-token");
    cookieStore.delete("eliza-anon-session");

    return NextResponse.json(
      {
        success: true,
        message: "Logged out successfully",
      },
      { status: 200 },
    );
  } catch (error) {
    logger.error("Error during logout:", error);

    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Failed to logout",
      },
      { status: 500 },
    );
  }
}

export const POST = withRateLimit(handlePOST, RateLimitPresets.STANDARD);
