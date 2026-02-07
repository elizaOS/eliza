import { NextRequest, NextResponse } from "next/server";
import { logger } from "@/lib/utils/logger";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import { usageQuotasService } from "@/lib/services/usage-quotas";
import { withRateLimit, RateLimitPresets } from "@/lib/middleware/rate-limit";

/**
 * GET /api/quotas/usage
 * Gets current quota usage statistics for the organization.
 * Supports both Privy session and API key authentication.
 *
 * @returns Current usage data across all quota types.
 */
async function handleGET(req: NextRequest) {
  try {
    const { user } = await requireAuthOrApiKeyWithOrg(req);

    const usage = await usageQuotasService.getCurrentUsage(
      user.organization_id,
    );

    return NextResponse.json({
      success: true,
      data: usage,
    });
  } catch (error) {
    logger.error("Error fetching quota usage:", error);

    return NextResponse.json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to fetch quota usage",
      },
      { status: 500 },
    );
  }
}

export const GET = withRateLimit(handleGET, RateLimitPresets.STANDARD);
