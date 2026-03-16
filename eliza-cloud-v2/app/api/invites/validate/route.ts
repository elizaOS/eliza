import { type NextRequest, NextResponse } from "next/server";
import { logger } from "@/lib/utils/logger";
import { invitesService } from "@/lib/services/invites";
import { withRateLimit, RateLimitPresets } from "@/lib/middleware/rate-limit";

/**
 * GET /api/invites/validate?token=xxx
 * Validates an invitation token and returns invitation details.
 * Public endpoint - no authentication required.
 *
 * @param request - Request with token query parameter.
 * @returns Validation result with organization and role details if valid.
 */
async function handleGET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const token = searchParams.get("token");

    if (!token) {
      return NextResponse.json(
        {
          success: false,
          valid: false,
          error: "Token is required",
        },
        { status: 400 },
      );
    }

    const validation = await invitesService.validateToken(token);

    if (!validation.valid) {
      return NextResponse.json({
        success: false,
        valid: false,
        error: validation.error,
      });
    }

    return NextResponse.json({
      success: true,
      valid: true,
      data: {
        organization_name: validation.invite!.organization.name,
        organization_slug: validation.invite!.organization.slug,
        role: validation.invite!.invited_role,
        invited_email: validation.invite!.invited_email,
        expires_at: validation.invite!.expires_at,
      },
    });
  } catch (error) {
    logger.error("Error validating invite token:", error);

    return NextResponse.json(
      {
        success: false,
        valid: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to validate invitation",
      },
      { status: 500 },
    );
  }
}

export const GET = withRateLimit(handleGET, RateLimitPresets.STANDARD);
