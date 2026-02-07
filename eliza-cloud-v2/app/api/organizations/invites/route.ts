import { type NextRequest, NextResponse } from "next/server";
import { logger } from "@/lib/utils/logger";
import { requireAuthWithOrg } from "@/lib/auth";
import { invitesService } from "@/lib/services/invites";
import { z } from "zod";
import { withRateLimit, RateLimitPresets } from "@/lib/middleware/rate-limit";

const createInviteSchema = z.object({
  email: z.string().email("Invalid email address"),
  role: z
    .enum(["admin", "member"])
    .refine((val) => val === "admin" || val === "member", {
      message: "Role must be 'admin' or 'member'",
    }),
});

/**
 * POST /api/organizations/invites
 * Creates a new organization invitation.
 * Requires owner or admin role.
 *
 * @param request - Request body with email and role (admin or member).
 * @returns Created invite details.
 */
async function handlePOST(request: NextRequest) {
  try {
    const user = await requireAuthWithOrg();

    if (user.role !== "owner" && user.role !== "admin") {
      return NextResponse.json(
        {
          success: false,
          error: "Only owners and admins can invite members",
        },
        { status: 403 },
      );
    }

    const body = await request.json();
    const validated = createInviteSchema.parse(body);

    const result = await invitesService.createInvite({
      organizationId: user.organization_id!!,
      inviterUserId: user.id,
      invitedEmail: validated.email,
      invitedRole: validated.role,
    });

    return NextResponse.json({
      success: true,
      data: {
        id: result.invite.id,
        email: result.invite.invited_email,
        role: result.invite.invited_role,
        expires_at: result.invite.expires_at,
        status: result.invite.status,
      },
      message: "Invitation sent successfully",
    });
  } catch (error) {
    logger.error("Error creating invite:", error);

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
      error instanceof Error ? error.message : "Failed to create invitation";

    return NextResponse.json(
      {
        success: false,
        error: errorMessage,
      },
      {
        status:
          errorMessage.includes("already a member") ||
          errorMessage.includes("already pending")
            ? 409
            : 500,
      },
    );
  }
}

/**
 * GET /api/organizations/invites
 * Lists all invitations for the organization.
 * Requires owner or admin role.
 *
 * @returns Array of invitations with inviter details.
 */
async function handleGET() {
  try {
    const user = await requireAuthWithOrg();

    if (user.role !== "owner" && user.role !== "admin") {
      return NextResponse.json(
        {
          success: false,
          error: "Only owners and admins can view invitations",
        },
        { status: 403 },
      );
    }

    const invites = await invitesService.listByOrganization(
      user.organization_id!,
    );

    /**
     * Type for invite with inviter relation.
     * The repository query uses `with: { inviter }` but Drizzle's base return type
     * doesn't include relations. This type extends the base invite with the relation.
     */
    type InviteWithInviter = (typeof invites)[number] & {
      inviter?: {
        id: string;
        name: string | null;
        email: string | null;
      } | null;
    };

    return NextResponse.json({
      success: true,
      data: invites.map((invite) => {
        // Safe cast: repository query includes inviter relation via `with` clause
        const inviteWithRelation = invite as InviteWithInviter;
        return {
          id: inviteWithRelation.id,
          email: inviteWithRelation.invited_email,
          role: inviteWithRelation.invited_role,
          status: inviteWithRelation.status,
          expires_at: inviteWithRelation.expires_at,
          created_at: inviteWithRelation.created_at,
          inviter: inviteWithRelation.inviter
            ? {
                id: inviteWithRelation.inviter.id,
                name: inviteWithRelation.inviter.name,
                email: inviteWithRelation.inviter.email,
              }
            : null,
          accepted_at: inviteWithRelation.accepted_at,
        };
      }),
    });
  } catch (error) {
    logger.error("Error fetching invites:", error);

    return NextResponse.json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to fetch invitations",
      },
      { status: 500 },
    );
  }
}

export const POST = withRateLimit(handlePOST, RateLimitPresets.STRICT);
export const GET = withRateLimit(handleGET, RateLimitPresets.STANDARD);
