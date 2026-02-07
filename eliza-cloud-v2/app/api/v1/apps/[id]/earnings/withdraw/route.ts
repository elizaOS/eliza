import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import { appsService } from "@/lib/services/apps";
import { appEarningsService } from "@/lib/services/app-earnings";
import { logger } from "@/lib/utils/logger";
import { withRateLimit, RateLimitPresets } from "@/lib/middleware/rate-limit";
import { z } from "zod";

// Default minimum payout threshold (used as fallback if DB value unavailable)
const DEFAULT_MINIMUM_PAYOUT = 25.0;

// Maximum withdrawal per request to prevent numeric overflow/abuse
const MAXIMUM_WITHDRAWAL = 1000000.0;

const WithdrawRequestSchema = z.object({
  amount: z
    .number()
    .positive("Amount must be positive")
    .max(
      MAXIMUM_WITHDRAWAL,
      `Maximum withdrawal is $${MAXIMUM_WITHDRAWAL.toLocaleString()}`,
    ),
  idempotency_key: z
    .string()
    .min(16, "Idempotency key must be at least 16 characters")
    .max(64, "Idempotency key must be at most 64 characters")
    .optional(),
});

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * POST /api/v1/apps/[id]/earnings/withdraw
 * Request a withdrawal of app earnings.
 *
 * Request Body:
 * - `amount`: number - Amount to withdraw (must be >= payout threshold)
 *
 * Validates:
 * - App exists and belongs to the authenticated user's organization
 * - User is the app creator (only creators can withdraw)
 * - Monetization is enabled for the app
 * - Amount meets the minimum payout threshold ($25)
 * - Sufficient withdrawable balance
 *
 * @returns Success status, transaction ID, and new balance
 */
async function handlePOST(request: NextRequest, context?: RouteContext) {
  try {
    if (!context?.params) {
      return NextResponse.json(
        { success: false, error: "Missing route parameters" },
        { status: 400 },
      );
    }

    const { user } = await requireAuthOrApiKeyWithOrg(request);
    const { id } = await context.params;

    const app = await appsService.getById(id);

    if (!app) {
      return NextResponse.json(
        { success: false, error: "App not found" },
        { status: 404 },
      );
    }

    if (app.organization_id !== user.organization_id) {
      return NextResponse.json(
        { success: false, error: "Access denied" },
        { status: 403 },
      );
    }

    // CRITICAL: Only the app creator can withdraw earnings
    if (app.created_by_user_id !== user.id) {
      return NextResponse.json(
        {
          success: false,
          error: "Only the app creator can withdraw earnings",
        },
        { status: 403 },
      );
    }

    if (!app.monetization_enabled) {
      return NextResponse.json(
        { success: false, error: "Monetization is not enabled for this app" },
        { status: 400 },
      );
    }

    // Parse and validate request body
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json(
        { success: false, error: "Invalid JSON in request body" },
        { status: 400 },
      );
    }

    const validationResult = WithdrawRequestSchema.safeParse(body);

    if (!validationResult.success) {
      return NextResponse.json(
        {
          success: false,
          error: "Invalid request data",
          details: validationResult.error.format(),
        },
        { status: 400 },
      );
    }

    const { amount, idempotency_key } = validationResult.data;

    // Get earnings summary to read the actual payout threshold from database
    const earningsSummary = await appEarningsService.getEarningsSummary(id);
    const minimumPayout =
      earningsSummary?.payoutThreshold ?? DEFAULT_MINIMUM_PAYOUT;

    // Early validation: fail fast if amount below minimum (using database value)
    if (amount < minimumPayout) {
      return NextResponse.json(
        {
          success: false,
          error: `Minimum withdrawal amount is $${minimumPayout.toFixed(2)}`,
        },
        { status: 400 },
      );
    }

    const result = await appEarningsService.requestWithdrawal(
      id,
      amount,
      idempotency_key,
    );

    if (!result.success) {
      logger.warn("[Withdrawal] Request failed", {
        appId: id,
        userId: user.id,
        amount,
        error: result.message,
      });

      return NextResponse.json(
        { success: false, error: result.message },
        { status: 400 },
      );
    }

    logger.info("[Withdrawal] Request successful", {
      appId: id,
      userId: user.id,
      amount,
      transactionId: result.transactionId,
    });

    // Get updated summary to return new balance
    const updatedSummary = await appEarningsService.getEarningsSummary(id);

    return NextResponse.json({
      success: true,
      message: result.message,
      transactionId: result.transactionId,
      newBalance: updatedSummary?.withdrawableBalance ?? 0,
    });
  } catch (error) {
    logger.error("[Withdrawal] Unexpected error", {
      error: error instanceof Error ? error.message : "Unknown error",
      stack: error instanceof Error ? error.stack : undefined,
    });

    // Check for auth errors (they have specific status codes)
    if (error instanceof Error && error.message.includes("Unauthorized")) {
      return NextResponse.json(
        { success: false, error: "Unauthorized" },
        { status: 401 },
      );
    }

    return NextResponse.json(
      { success: false, error: "Internal server error" },
      { status: 500 },
    );
  }
}

// Apply strict rate limiting for financial operations (5 requests per 5 minutes)
export const POST = withRateLimit(handlePOST, RateLimitPresets.CRITICAL);
