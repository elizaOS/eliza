import { NextRequest, NextResponse } from "next/server";
import { logger } from "@/lib/utils/logger";
import { appCreditsService } from "@/lib/services/app-credits";
import { requireAuthOrApiKeyWithOrg, verifyAuthTokenCached } from "@/lib/auth";
import { dbRead } from "@/db/client";
import { users } from "@/db/schemas/users";
import { eq } from "drizzle-orm";

export const dynamic = "force-dynamic";

// CORS headers - reflect origin for credentialed requests
function getCorsHeaders(origin: string | null) {
  return {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers":
      "Content-Type, Authorization, X-API-Key, X-App-Id, X-Request-ID",
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Max-Age": "86400",
  };
}

/**
 * OPTIONS /api/v1/app-credits/balance
 * CORS preflight handler
 */
export async function OPTIONS(request: NextRequest) {
  const origin = request.headers.get("origin");
  return new NextResponse(null, {
    status: 204,
    headers: getCorsHeaders(origin),
  });
}

/**
 * GET /api/v1/app-credits/balance
 *
 * Get the user's credit balance for a specific app.
 *
 * Query Params:
 * - app_id: The app ID (required)
 *
 * Headers:
 * - Authorization: Bearer <user_token>
 * - X-Api-Key: <app_api_key> (optional, for app context)
 *
 * Returns:
 * - balance: Current credit balance
 * - totalPurchased: Total credits ever purchased
 * - totalSpent: Total credits spent
 * - isLow: Whether balance is below threshold
 */
export async function GET(request: NextRequest) {
  const origin = request.headers.get("origin");
  const corsHeaders = getCorsHeaders(origin);

  try {
    const { searchParams } = new URL(request.url);
    const appId = searchParams.get("app_id") || request.headers.get("X-App-Id");

    if (!appId) {
      return NextResponse.json(
        { success: false, error: "app_id is required" },
        { status: 400, headers: corsHeaders },
      );
    }

    // Get user from auth token
    const authHeader = request.headers.get("Authorization");
    let userId: string | null = null;
    let organizationId: string | null = null;

    if (authHeader?.startsWith("Bearer ")) {
      const token = authHeader.slice(7);

      // Check if it's a Privy token (user auth)
      const verifiedClaims = await verifyAuthTokenCached(token);

      if (verifiedClaims) {
        // Get user from Privy ID
        const [user] = await dbRead
          .select({
            id: users.id,
            organization_id: users.organization_id,
          })
          .from(users)
          .where(eq(users.privy_user_id, verifiedClaims.userId))
          .limit(1);

        if (user) {
          userId = user.id;
          organizationId = user.organization_id;
        }
      }
    }

    // Fallback to API key auth if no user token
    if (!userId) {
      try {
        const authResult = await requireAuthOrApiKeyWithOrg(request);
        userId = authResult.user.id;
        organizationId = authResult.user.organization_id;
      } catch {
        return NextResponse.json(
          { success: false, error: "Authentication required" },
          { status: 401, headers: corsHeaders },
        );
      }
    }

    if (!organizationId) {
      return NextResponse.json(
        { success: false, error: "User organization not found" },
        { status: 400, headers: corsHeaders },
      );
    }

    // Get user's balance for this app
    let balance = await appCreditsService.getBalance(appId, userId);

    // If no balance exists, create one with 0 credits
    if (!balance) {
      await appCreditsService.getOrCreateBalance(appId, userId, organizationId);
      balance = await appCreditsService.getBalance(appId, userId);
    }

    const LOW_BALANCE_THRESHOLD = 5;

    return NextResponse.json(
      {
        success: true,
        balance: balance?.balance ?? 0,
        totalPurchased: balance?.totalPurchased ?? 0,
        totalSpent: balance?.totalSpent ?? 0,
        isLow: (balance?.balance ?? 0) < LOW_BALANCE_THRESHOLD,
      },
      { headers: corsHeaders },
    );
  } catch (error) {
    logger.error("Failed to get app credits balance:", error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Failed to get balance",
      },
      { status: 500, headers: getCorsHeaders(request.headers.get("origin")) },
    );
  }
}
