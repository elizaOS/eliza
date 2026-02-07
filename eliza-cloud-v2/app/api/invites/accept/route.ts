import { type NextRequest, NextResponse } from "next/server";
import { logger } from "@/lib/utils/logger";
import { requireAuth } from "@/lib/auth";
import { invitesService } from "@/lib/services/invites";
import { z } from "zod";
import { revalidateTag } from "next/cache";
import { withRateLimit, RateLimitPresets } from "@/lib/middleware/rate-limit";

const acceptInviteSchema = z.object({
  token: z.string().min(1, "Token is required"),
});

/**
 * POST /api/invites/accept
 * Accepts an organization invitation using the invitation token.
 *
 * @param request - Request body containing the invitation token.
 * @returns Accepted invite details with organization ID and role.
 */
async function handlePOST(request: NextRequest) {
  try {
    const user = await requireAuth();

    const body = await request.json();
    const validated = acceptInviteSchema.parse(body);

    const acceptedInvite = await invitesService.acceptInvite(
      validated.token,
      user.id,
    );

    revalidateTag("user-auth", {});

    return NextResponse.json({
      success: true,
      data: {
        organization_id: acceptedInvite.organization_id,
        role: acceptedInvite.invited_role,
        accepted_at: acceptedInvite.accepted_at,
      },
      message: "Invitation accepted successfully",
    });
  } catch (error) {
    logger.error("Error accepting invite:", error);

    if (error instanceof z.ZodError) {
      return NextResponse.json(
        {
          success: false,
          error: "Validation error",
          details: error.issues,
        },
        { status: 400 },
      );
    }

    const errorMessage =
      error instanceof Error ? error.message : "Failed to accept invitation";

    return NextResponse.json(
      {
        success: false,
        error: errorMessage,
      },
      {
        status:
          errorMessage.includes("sign in with") ||
          errorMessage.includes("already a member")
            ? 409
            : errorMessage.includes("Invalid invite") ||
                errorMessage.includes("expired")
              ? 400
              : 500,
      },
    );
  }
}

export const POST = withRateLimit(handlePOST, RateLimitPresets.STRICT);
