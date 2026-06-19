/**
 * User Notification Email Preferences API
 *
 * @route GET /api/users/[userId]/notification-email-preferences
 * @route POST /api/users/[userId]/notification-email-preferences
 * @access Authenticated (own profile only)
 */

import {
  AuthorizationError,
  authenticate,
  BadRequestError,
  requireUserByIdentifier,
  successResponse,
  withErrorHandling,
} from "@feed/api";
import { db, eq, users } from "@feed/db";
import { logger, UserIdParamSchema } from "@feed/shared";
import type { NextRequest } from "next/server";
import { z } from "zod";

const UpdateNotificationEmailPreferencesSchema = z
  .object({
    enabled: z.boolean().optional(),
    realtime: z.boolean().optional(),
    dailySummary: z.boolean().optional(),
    weeklySummary: z.boolean().optional(),
    monthlySummary: z.boolean().optional(),
  })
  .refine(
    (data) =>
      data.enabled !== undefined ||
      data.realtime !== undefined ||
      data.dailySummary !== undefined ||
      data.weeklySummary !== undefined ||
      data.monthlySummary !== undefined,
    {
      message: "At least one preference must be provided",
    },
  );

// Phase 2: legacy email lookup removed. Email comes from Feed's users.email
// column which is populated by Steward at login time.
async function getVerifiedEmailFromDb(userId: string): Promise<string | null> {
  const [user] = await db
    .select({ email: users.email, emailVerified: users.emailVerified })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return user?.emailVerified ? (user.email ?? null) : null;
}

export const GET = withErrorHandling(
  async (
    request: NextRequest,
    context: { params: Promise<{ userId: string }> },
  ) => {
    const authUser = await authenticate(request);
    const params = await context.params;
    const { userId } = UserIdParamSchema.parse(params);
    const targetUser = await requireUserByIdentifier(userId, { id: true });
    const canonicalUserId = targetUser.id;

    if (authUser.userId !== canonicalUserId) {
      throw new AuthorizationError(
        "You can only access your own notification email preferences",
        "notification-email-preferences",
        "read",
      );
    }

    const [userRecord] = await db
      .select({
        email: users.email,
        emailVerified: users.emailVerified,
        enabled: users.emailNotificationsEnabled,
        realtime: users.emailNotificationsRealtime,
        dailySummary: users.emailNotificationsDailySummary,
        weeklySummary: users.emailNotificationsWeeklySummary,
        monthlySummary: users.emailNotificationsMonthlySummary,
      })
      .from(users)
      .where(eq(users.id, canonicalUserId))
      .limit(1);

    return successResponse({
      success: true,
      preferences: {
        enabled: userRecord?.enabled ?? false,
        realtime: userRecord?.realtime ?? true,
        dailySummary: userRecord?.dailySummary ?? true,
        weeklySummary: userRecord?.weeklySummary ?? true,
        monthlySummary: userRecord?.monthlySummary ?? true,
      },
      email: userRecord?.email ?? null,
      emailVerified: userRecord?.emailVerified ?? false,
    });
  },
);

export const POST = withErrorHandling(
  async (
    request: NextRequest,
    context: { params: Promise<{ userId: string }> },
  ) => {
    const authUser = await authenticate(request);
    const params = await context.params;
    const { userId } = UserIdParamSchema.parse(params);
    const targetUser = await requireUserByIdentifier(userId, { id: true });
    const canonicalUserId = targetUser.id;

    if (authUser.userId !== canonicalUserId) {
      throw new AuthorizationError(
        "You can only update your own notification email preferences",
        "notification-email-preferences",
        "update",
      );
    }

    const body = await request.json();
    const payload = UpdateNotificationEmailPreferencesSchema.parse(body);

    const [existingUser] = await db
      .select({
        email: users.email,
        emailVerified: users.emailVerified,
      })
      .from(users)
      .where(eq(users.id, canonicalUserId))
      .limit(1);

    if (!existingUser) {
      throw new BadRequestError("User not found");
    }

    const isEnablingEmailNotifications =
      payload.enabled === true ||
      payload.realtime === true ||
      payload.dailySummary === true ||
      payload.weeklySummary === true ||
      payload.monthlySummary === true;

    let effectiveEmail = existingUser.email;
    let effectiveEmailVerified = existingUser.emailVerified;

    if (
      isEnablingEmailNotifications &&
      (!effectiveEmail || !effectiveEmailVerified)
    ) {
      const verifiedEmail = await getVerifiedEmailFromDb(canonicalUserId);

      if (!verifiedEmail) {
        throw new BadRequestError(
          "No verified email was found on your account. Please link and verify an email address first.",
        );
      }

      const [updatedEmailUser] = await db
        .update(users)
        .set({
          email: verifiedEmail,
          emailVerified: true,
          updatedAt: new Date(),
        })
        .where(eq(users.id, canonicalUserId))
        .returning({
          email: users.email,
          emailVerified: users.emailVerified,
        });

      effectiveEmail = updatedEmailUser?.email ?? verifiedEmail;
      effectiveEmailVerified = updatedEmailUser?.emailVerified ?? true;
    }

    const updateData: Partial<typeof users.$inferInsert> = {
      updatedAt: new Date(),
    };

    if (payload.enabled !== undefined) {
      updateData.emailNotificationsEnabled = payload.enabled;
      updateData.emailNotificationsUnsubscribedAt = payload.enabled
        ? null
        : new Date();

      if (!payload.enabled) {
        updateData.emailNotificationsRealtime = false;
        updateData.emailNotificationsDailySummary = false;
        updateData.emailNotificationsWeeklySummary = false;
        updateData.emailNotificationsMonthlySummary = false;
      }
    }

    if (payload.realtime !== undefined) {
      updateData.emailNotificationsRealtime = payload.realtime;
    }
    if (payload.dailySummary !== undefined) {
      updateData.emailNotificationsDailySummary = payload.dailySummary;
    }
    if (payload.weeklySummary !== undefined) {
      updateData.emailNotificationsWeeklySummary = payload.weeklySummary;
    }
    if (payload.monthlySummary !== undefined) {
      updateData.emailNotificationsMonthlySummary = payload.monthlySummary;
    }

    if (
      payload.realtime === true ||
      payload.dailySummary === true ||
      payload.weeklySummary === true ||
      payload.monthlySummary === true
    ) {
      updateData.emailNotificationsEnabled = true;
      updateData.emailNotificationsUnsubscribedAt = null;
    }

    const [updatedUser] = await db
      .update(users)
      .set(updateData)
      .where(eq(users.id, canonicalUserId))
      .returning({
        email: users.email,
        emailVerified: users.emailVerified,
        enabled: users.emailNotificationsEnabled,
        realtime: users.emailNotificationsRealtime,
        dailySummary: users.emailNotificationsDailySummary,
        weeklySummary: users.emailNotificationsWeeklySummary,
        monthlySummary: users.emailNotificationsMonthlySummary,
      });

    logger.info(
      "Updated notification email preferences",
      {
        userId: canonicalUserId,
        enabled: updatedUser?.enabled,
        realtime: updatedUser?.realtime,
        dailySummary: updatedUser?.dailySummary,
        weeklySummary: updatedUser?.weeklySummary,
        monthlySummary: updatedUser?.monthlySummary,
      },
      "POST /api/users/[userId]/notification-email-preferences",
    );

    return successResponse({
      success: true,
      preferences: {
        enabled: updatedUser?.enabled ?? false,
        realtime: updatedUser?.realtime ?? false,
        dailySummary: updatedUser?.dailySummary ?? false,
        weeklySummary: updatedUser?.weeklySummary ?? false,
        monthlySummary: updatedUser?.monthlySummary ?? false,
      },
      email: updatedUser?.email ?? effectiveEmail ?? null,
      emailVerified: updatedUser?.emailVerified ?? effectiveEmailVerified,
    });
  },
);
