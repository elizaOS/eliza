/**
 * Credits Verify API (v1)
 *
 * GET /api/v1/credits/verify
 * Verifies a completed Stripe checkout session and confirms credits were added.
 *
 * CORS: Reflects origin header. Security is via auth tokens.
 */

import { type NextRequest, NextResponse } from "next/server";
import { logger } from "@/lib/utils/logger";
import { requireStripe } from "@/lib/stripe";

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
 * GET /api/v1/credits/verify
 * Verifies a completed checkout session.
 *
 * Query Params:
 * - session_id: Stripe checkout session ID
 *
 * Returns:
 * - success: Whether the purchase was successful
 * - amount: Amount of credits purchased (if successful)
 */
export async function GET(request: NextRequest) {
  const origin = request.headers.get("origin");
  const corsHeaders = getCorsHeaders(origin);

  try {
    const { searchParams } = new URL(request.url);
    const sessionId = searchParams.get("session_id");

    if (!sessionId) {
      return NextResponse.json(
        { success: false, error: "session_id is required" },
        { status: 400, headers: corsHeaders },
      );
    }

    // Retrieve the checkout session from Stripe
    const session = await requireStripe().checkout.sessions.retrieve(sessionId);

    if (!session) {
      return NextResponse.json(
        { success: false, error: "Session not found" },
        { status: 404, headers: corsHeaders },
      );
    }

    // Check if payment was successful
    if (session.payment_status !== "paid") {
      return NextResponse.json(
        {
          success: false,
          error: "Payment not completed",
          status: session.payment_status,
        },
        { headers: corsHeaders },
      );
    }

    // Verify this is an organization credit purchase
    const metadata = session.metadata || {};
    if (metadata.type !== "custom_amount" && metadata.type !== "credit_pack") {
      return NextResponse.json(
        {
          success: false,
          error: "Invalid session type",
        },
        { headers: corsHeaders },
      );
    }

    const amount = parseFloat(metadata.credits || "0");

    logger.info("Verified credits checkout session", {
      sessionId,
      organizationId: metadata.organization_id,
      amount,
    });

    // Credits are added via Stripe webhook - this endpoint just verifies payment status
    return NextResponse.json(
      {
        success: true,
        amount,
        message: "Payment verified successfully",
      },
      { headers: corsHeaders },
    );
  } catch (error) {
    logger.error("[Credits Verify API v1] Error:", error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Verification failed",
      },
      { status: 500, headers: corsHeaders },
    );
  }
}
