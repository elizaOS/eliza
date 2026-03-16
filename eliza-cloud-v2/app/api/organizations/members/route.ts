import { NextResponse } from "next/server";
import { logger } from "@/lib/utils/logger";
import { requireAuthWithOrg } from "@/lib/auth";
import { usersService } from "@/lib/services/users";
import { withRateLimit, RateLimitPresets } from "@/lib/middleware/rate-limit";

/**
 * GET /api/organizations/members
 * Lists all members of the organization.
 * Requires owner or admin role.
 *
 * @returns Array of member details with roles and metadata.
 */
async function handleGET() {
  try {
    const user = await requireAuthWithOrg();

    if (user.role !== "owner" && user.role !== "admin") {
      return NextResponse.json(
        {
          success: false,
          error: "Only owners and admins can view members",
        },
        { status: 403 },
      );
    }

    const members = await usersService.listByOrganization(
      user.organization_id!,
    );

    return NextResponse.json({
      success: true,
      data: members.map((member) => ({
        id: member.id,
        name: member.name,
        email: member.email,
        wallet_address: member.wallet_address,
        wallet_chain_type: member.wallet_chain_type,
        role: member.role,
        is_active: member.is_active,
        created_at: member.created_at,
        updated_at: member.updated_at,
      })),
    });
  } catch (error) {
    logger.error("Error fetching members:", error);

    return NextResponse.json(
      {
        success: false,
        error:
          error instanceof Error ? error.message : "Failed to fetch members",
      },
      { status: 500 },
    );
  }
}

export const GET = withRateLimit(handleGET, RateLimitPresets.STANDARD);
