/**
 * Credit Balance API (v1)
 *
 * GET /api/v1/credits/balance
 * Gets the credit balance for the authenticated user's organization.
 *
 * CORS: Fully open (wildcard). Security is via auth tokens, not origin validation.
 */

import { type NextRequest, NextResponse } from "next/server";
import { logger } from "@/lib/utils/logger";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import { organizationsService } from "@/lib/services/organizations";

export const dynamic = "force-dynamic";
export const revalidate = 0;

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
 * OPTIONS handler for CORS preflight
 */
export async function OPTIONS(request: NextRequest) {
  const origin = request.headers.get("origin");
  return new NextResponse(null, {
    status: 204,
    headers: getCorsHeaders(origin),
  });
}

/**
 * GET /api/v1/credits/balance
 * Gets the credit balance for the authenticated user's organization.
 *
 * Query params:
 * - fresh=true: Bypass cache and fetch directly from DB (use after payments)
 *
 * @param req - The Next.js request object.
 * @returns JSON response with balance or error.
 */
export async function GET(req: NextRequest) {
  const origin = req.headers.get("origin");
  const corsHeaders = getCorsHeaders(origin);

  try {
    const { user } = await requireAuthOrApiKeyWithOrg(req);

    // Check if fresh data is requested (e.g., after payment)
    const forceFresh = req.nextUrl.searchParams.get("fresh") === "true";

    let balance: number;

    if (forceFresh) {
      // Fetch fresh from database - bypass session cache
      const freshOrg = await organizationsService.getById(user.organization_id);
      balance = Number(freshOrg?.credit_balance || 0);
    } else {
      // Use cached session data for normal polling (fast)
      balance = Number(user.organization.credit_balance || 0);
    }

    return NextResponse.json(
      { balance },
      {
        headers: {
          ...corsHeaders,
          "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
          Pragma: "no-cache",
          Expires: "0",
        },
      },
    );
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Failed to fetch balance";

    // Return 401 for authentication errors
    const isAuthError =
      errorMessage.includes("Unauthorized") ||
      errorMessage.includes("Authentication required") ||
      errorMessage.includes("Forbidden");

    if (isAuthError) {
      return NextResponse.json(
        { error: "Unauthorized" },
        {
          status: 401,
          headers: {
            ...corsHeaders,
            "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
            Pragma: "no-cache",
            Expires: "0",
          },
        },
      );
    }

    logger.error("[Balance API v1] Error:", error);
    return NextResponse.json(
      { error: errorMessage },
      {
        status: 500,
        headers: {
          ...corsHeaders,
          "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
          Pragma: "no-cache",
          Expires: "0",
        },
      },
    );
  }
}
