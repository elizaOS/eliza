import { type NextRequest, NextResponse } from "next/server";
import { logger } from "@/lib/utils/logger";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import { autoTopUpService } from "@/lib/services/auto-top-up";
import { withRateLimit, RateLimitPresets } from "@/lib/middleware/rate-limit";
import { organizationsRepository } from "@/db/repositories";

/**
 * POST /api/auto-top-up/trigger
 * Manually triggers an auto top-up check for the authenticated user's organization.
 * Supports both Privy session and API key authentication.
 * Allows testing auto top-up functionality without waiting for the cron job.
 *
 * @param req - The Next.js request object.
 * @returns Success status with top-up amount and balance information.
 */
async function handleTriggerAutoTopUp(req: NextRequest) {
  try {
    const { user } = await requireAuthOrApiKeyWithOrg(req);
    const organizationId = user.organization_id!;

    // Get organization details
    const org = await organizationsRepository.findById(organizationId);
    if (!org) {
      return NextResponse.json(
        { error: "Organization not found" },
        { status: 404 },
      );
    }

    // Check if auto top-up is enabled
    if (!org.auto_top_up_enabled) {
      return NextResponse.json(
        {
          error: "Auto top-up is not enabled",
          message: "Please enable auto top-up first",
        },
        { status: 400 },
      );
    }

    // Check if balance is below threshold
    const currentBalance = Number(org.credit_balance || 0);
    const threshold = Number(org.auto_top_up_threshold || 0);

    if (currentBalance >= threshold) {
      return NextResponse.json({
        success: false,
        message: `Balance ($${currentBalance.toFixed(2)}) is above threshold ($${threshold.toFixed(2)}). Auto top-up not needed.`,
        currentBalance,
        threshold,
      });
    }

    // Execute auto top-up (this is the same function the cron uses)
    const result = await autoTopUpService["executeAutoTopUp"](org);

    if (result.success) {
      return NextResponse.json({
        success: true,
        message: `Auto top-up successful! Added $${result.amount?.toFixed(2)}`,
        amount: result.amount,
        previousBalance: currentBalance,
        newBalance: result.newBalance,
      });
    } else {
      return NextResponse.json(
        {
          success: false,
          error: result.error || "Auto top-up failed",
          message: "Please check your payment method and try again",
        },
        { status: 400 },
      );
    }
  } catch (error) {
    logger.error("Error triggering auto top-up:", error);

    if (error instanceof Error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json(
      { error: "Failed to trigger auto top-up" },
      { status: 500 },
    );
  }
}

// Export rate-limited handler
export const POST = withRateLimit(
  handleTriggerAutoTopUp,
  RateLimitPresets.STRICT,
);
