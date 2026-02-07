import { type NextRequest, NextResponse } from "next/server";
import { logger } from "@/lib/utils/logger";
import { requireAuth } from "@/lib/auth";
import { usersService } from "@/lib/services/users";
import { z } from "zod";
import { withRateLimit, RateLimitPresets } from "@/lib/middleware/rate-limit";

const updateUserSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  avatar: z.string().url().optional().or(z.literal("")),
  nickname: z.string().max(50).optional(),
  work_function: z
    .enum([
      "developer",
      "designer",
      "product",
      "data",
      "marketing",
      "sales",
      "other",
    ])
    .optional(),
  preferences: z.string().max(1000).optional(),
  response_notifications: z.boolean().optional(),
  email_notifications: z.boolean().optional(),
});

/**
 * GET /api/v1/user
 * Gets the current authenticated user's profile information.
 *
 * @returns User profile data including organization details.
 */
async function handleGET() {
  try {
    const user = await requireAuth();

    return NextResponse.json({
      success: true,
      data: {
        id: user.id,
        email: user.email,
        name: user.name,
        avatar: user.avatar,
        nickname: user.nickname,
        work_function: user.work_function,
        preferences: user.preferences,
        response_notifications: user.response_notifications,
        email_notifications: user.email_notifications,
        role: user.role,
        email_verified: user.email_verified,
        wallet_address: user.wallet_address,
        wallet_chain_type: user.wallet_chain_type,
        wallet_verified: user.wallet_verified,
        is_active: user.is_active,
        created_at: user.created_at,
        updated_at: user.updated_at,
        organization: {
          id: user.organization?.id,
          name: user.organization?.name,
          slug: user.organization?.slug,
          credit_balance: user.organization?.credit_balance,
        },
      },
    });
  } catch (error) {
    logger.error("Error fetching user:", error);

    return NextResponse.json(
      {
        success: false,
        error:
          error instanceof Error ? error.message : "Failed to fetch user data",
      },
      {
        status:
          error instanceof Error && error.message.includes("Forbidden")
            ? 403
            : 500,
      },
    );
  }
}

/**
 * PATCH /api/v1/user
 * Updates the current authenticated user's profile information.
 *
 * @param request - Request body with optional fields to update (name, avatar, nickname, etc.).
 * @returns Updated user profile data.
 */
async function handlePATCH(request: NextRequest) {
  try {
    const user = await requireAuth();
    const body = await request.json();

    // Validate input
    const validated = updateUserSchema.parse(body);

    // Update user
    const updated = await usersService.update(user.id, {
      ...(validated.name && { name: validated.name }),
      ...(validated.avatar !== undefined && {
        avatar: validated.avatar || null,
      }),
      ...(validated.nickname !== undefined && { nickname: validated.nickname }),
      ...(validated.work_function !== undefined && {
        work_function: validated.work_function,
      }),
      ...(validated.preferences !== undefined && {
        preferences: validated.preferences,
      }),
      ...(validated.response_notifications !== undefined && {
        response_notifications: validated.response_notifications,
      }),
      ...(validated.email_notifications !== undefined && {
        email_notifications: validated.email_notifications,
      }),
    });

    if (!updated) {
      return NextResponse.json(
        {
          success: false,
          error: "Failed to update user",
        },
        { status: 500 },
      );
    }

    return NextResponse.json({
      success: true,
      data: {
        id: updated.id,
        email: updated.email,
        name: updated.name,
        avatar: updated.avatar,
        nickname: updated.nickname,
        work_function: updated.work_function,
        preferences: updated.preferences,
        response_notifications: updated.response_notifications,
        email_notifications: updated.email_notifications,
        role: updated.role,
        wallet_address: updated.wallet_address,
        wallet_chain_type: updated.wallet_chain_type,
        wallet_verified: updated.wallet_verified,
        updated_at: updated.updated_at,
      },
      message: "Profile updated successfully",
    });
  } catch (error) {
    logger.error("Error updating user:", error);

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
          error instanceof Error ? error.message : "Failed to update profile",
      },
      {
        status:
          error instanceof Error && error.message.includes("Forbidden")
            ? 403
            : 500,
      },
    );
  }
}

export const GET = withRateLimit(handleGET, RateLimitPresets.STANDARD);
export const PATCH = withRateLimit(handlePATCH, RateLimitPresets.STANDARD);
