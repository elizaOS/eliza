import { type NextRequest, NextResponse } from "next/server";
import { logger } from "@/lib/utils/logger";
import { requireAuth } from "@/lib/auth";
import { usersService } from "@/lib/services/users";
import { z } from "zod";
import { revalidateTag } from "next/cache";
import { withRateLimit, RateLimitPresets } from "@/lib/middleware/rate-limit";

const updateMemberSchema = z.object({
  role: z
    .enum(["admin", "member"])
    .refine((val) => val === "admin" || val === "member", {
      message: "Role must be 'admin' or 'member'",
    }),
});

/**
 * PATCH /api/organizations/members/[userId]
 * Updates a member's role in the organization.
 * Requires owner role. Cannot change own role or owner role.
 *
 * @param request - Request body with new role (admin or member).
 * @param context - Route context containing the user ID parameter.
 * @returns Updated member details.
 */
async function handlePATCH(
  request: NextRequest,
  context?: { params: Promise<{ userId: string }> },
) {
  try {
    const currentUser = await requireAuth();

    if (currentUser.role !== "owner") {
      return NextResponse.json(
        {
          success: false,
          error: "Only organization owners can update member roles",
        },
        { status: 403 },
      );
    }

    if (!context?.params) {
      return NextResponse.json(
        { success: false, error: "Invalid request" },
        { status: 400 },
      );
    }

    const { userId } = await context.params;
    const body = await request.json();
    const validated = updateMemberSchema.parse(body);

    const targetUser = await usersService.getById(userId);

    if (!targetUser) {
      return NextResponse.json(
        {
          success: false,
          error: "User not found",
        },
        { status: 404 },
      );
    }

    if (targetUser.organization_id !== currentUser.organization_id) {
      return NextResponse.json(
        {
          success: false,
          error: "User does not belong to your organization",
        },
        { status: 403 },
      );
    }

    if (targetUser.id === currentUser.id) {
      return NextResponse.json(
        {
          success: false,
          error: "Cannot change your own role",
        },
        { status: 400 },
      );
    }

    if (targetUser.role === "owner") {
      return NextResponse.json(
        {
          success: false,
          error: "Cannot change owner role",
        },
        { status: 400 },
      );
    }

    const updated = await usersService.update(userId, {
      role: validated.role,
      updated_at: new Date(),
    });

    if (!updated) {
      return NextResponse.json(
        {
          success: false,
          error: "Failed to update member",
        },
        { status: 500 },
      );
    }

    revalidateTag("user-auth", {});

    return NextResponse.json({
      success: true,
      data: {
        id: updated.id,
        name: updated.name,
        email: updated.email,
        role: updated.role,
        updated_at: updated.updated_at,
      },
      message: "Member role updated successfully",
    });
  } catch (error) {
    logger.error("Error updating member:", error);

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

    return NextResponse.json(
      {
        success: false,
        error:
          error instanceof Error ? error.message : "Failed to update member",
      },
      { status: 500 },
    );
  }
}

/**
 * DELETE /api/organizations/members/[userId]
 * Removes a member from the organization.
 * Requires owner or admin role. Admins cannot remove other admins.
 *
 * @param request - The Next.js request object.
 * @param context - Route context containing the user ID parameter.
 * @returns Success status.
 */
async function handleDELETE(
  request: NextRequest,
  context?: { params: Promise<{ userId: string }> },
) {
  try {
    const currentUser = await requireAuth();

    if (currentUser.role !== "owner" && currentUser.role !== "admin") {
      return NextResponse.json(
        {
          success: false,
          error: "Only owners and admins can remove members",
        },
        { status: 403 },
      );
    }

    if (!context?.params) {
      return NextResponse.json(
        { success: false, error: "Invalid request" },
        { status: 400 },
      );
    }

    const { userId } = await context.params;

    const targetUser = await usersService.getById(userId);

    if (!targetUser) {
      return NextResponse.json(
        {
          success: false,
          error: "User not found",
        },
        { status: 404 },
      );
    }

    if (targetUser.organization_id !== currentUser.organization_id) {
      return NextResponse.json(
        {
          success: false,
          error: "User does not belong to your organization",
        },
        { status: 403 },
      );
    }

    if (targetUser.id === currentUser.id) {
      return NextResponse.json(
        {
          success: false,
          error: "Cannot remove yourself from the organization",
        },
        { status: 400 },
      );
    }

    if (targetUser.role === "owner") {
      return NextResponse.json(
        {
          success: false,
          error: "Cannot remove organization owner",
        },
        { status: 400 },
      );
    }

    if (currentUser.role === "admin" && targetUser.role === "admin") {
      return NextResponse.json(
        {
          success: false,
          error: "Admins cannot remove other admins",
        },
        { status: 403 },
      );
    }

    await usersService.delete(userId);

    revalidateTag("user-auth", {});

    return NextResponse.json({
      success: true,
      message: "Member removed successfully",
    });
  } catch (error) {
    logger.error("Error removing member:", error);

    return NextResponse.json(
      {
        success: false,
        error:
          error instanceof Error ? error.message : "Failed to remove member",
      },
      { status: 500 },
    );
  }
}

export const PATCH = withRateLimit(handlePATCH, RateLimitPresets.STANDARD);
export const DELETE = withRateLimit(handleDELETE, RateLimitPresets.STANDARD);
