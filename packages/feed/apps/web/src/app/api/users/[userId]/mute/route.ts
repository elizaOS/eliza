/**
 * User Mute API
 *
 * @route POST /api/users/[userId]/mute - Mute or unmute user
 * @route GET /api/users/[userId]/mute - Check if user is muted
 * @access Authenticated
 *
 * @description
 * Manages user muting/unmuting. POST mutes or unmutes a user (hides their posts
 * from feed). GET checks if the current user has muted the target user. Handles
 * race conditions for concurrent mute requests.
 *
 * @openapi
 * /api/users/{userId}/mute:
 *   post:
 *     tags:
 *       - Users
 *     summary: Mute or unmute user
 *     description: Mutes or unmutes a user (hides their posts from feed)
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: userId
 *         required: true
 *         schema:
 *           type: string
 *         description: Target user ID to mute/unmute
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - action
 *             properties:
 *               action:
 *                 type: string
 *                 enum: [mute, unmute]
 *               reason:
 *                 type: string
 *                 description: Optional reason for muting
 *     responses:
 *       200:
 *         description: Mute/unmute action completed successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 message:
 *                   type: string
 *                 mute:
 *                   type: object
 *                   nullable: true
 *       400:
 *         description: Invalid action or already muted/unmuted
 *       401:
 *         description: Unauthorized
 *       404:
 *         description: Target user not found
 *   get:
 *     tags:
 *       - Users
 *     summary: Check if user is muted
 *     description: Returns whether the current user has muted the target user
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: userId
 *         required: true
 *         schema:
 *           type: string
 *         description: Target user ID to check
 *     responses:
 *       200:
 *         description: Mute status retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 isMuted:
 *                   type: boolean
 *                 mute:
 *                   type: object
 *                   nullable: true
 *
 * @example
 * ```typescript
 * // Mute user
 * await fetch(`/api/users/${userId}/mute`, {
 *   method: 'POST',
 *   headers: { 'Authorization': `Bearer ${token}` },
 *   body: JSON.stringify({ action: 'mute' })
 * });
 * ```
 *
 * @see {@link /lib/moderation/filters} Moderation filters
 */

import {
  authenticate,
  BusinessLogicError,
  NotFoundError,
  successResponse,
  withErrorHandling,
} from "@feed/api";
import { and, db, eq, userMutes, users } from "@feed/db";
import { generateSnowflakeId, logger, MuteUserSchema } from "@feed/shared";
import type { NextRequest } from "next/server";

export const POST = withErrorHandling(
  async (
    request: NextRequest,
    context: { params: Promise<{ userId: string }> },
  ) => {
    // Authenticate the user
    const authUser = await authenticate(request);
    const { userId: targetUserId } = await context.params;

    // Parse request body
    const body = (await request.json()) as { action: string; reason?: string };
    const { action, reason } = MuteUserSchema.parse(body);

    logger.info(
      `User ${action} request`,
      {
        userId: authUser.userId,
        targetUserId,
        action,
      },
      "POST /api/users/[userId]/mute",
    );

    // Cannot mute yourself
    if (authUser.userId === targetUserId) {
      throw new BusinessLogicError("Cannot mute yourself", "CANNOT_MUTE_SELF");
    }

    // Check if target user exists
    const [targetUser] = await db
      .select({
        id: users.id,
        username: users.username,
        displayName: users.displayName,
        isActor: users.isActor,
      })
      .from(users)
      .where(eq(users.id, targetUserId))
      .limit(1);

    if (!targetUser) {
      throw new NotFoundError("User", targetUserId);
    }

    // Note: Muting NPCs is allowed - it hides their posts from your feed

    if (action === "mute") {
      // Check if already muted
      const [existingMute] = await db
        .select({ id: userMutes.id })
        .from(userMutes)
        .where(
          and(
            eq(userMutes.muterId, authUser.userId),
            eq(userMutes.mutedId, targetUserId),
          ),
        )
        .limit(1);

      if (existingMute) {
        throw new BusinessLogicError("User is already muted", "ALREADY_MUTED");
      }

      // Create mute
      const muteId = await generateSnowflakeId();
      const [insertedMute] = await db
        .insert(userMutes)
        .values({
          id: muteId,
          muterId: authUser.userId,
          mutedId: targetUserId,
          reason: reason || null,
        })
        .returning();
      const mute = insertedMute;

      logger.info(
        "User muted successfully",
        {
          userId: authUser.userId,
          targetUserId,
          muteId: mute?.id,
        },
        "POST /api/users/[userId]/mute",
      );

      return successResponse({
        success: true,
        message: "User muted successfully",
        mute,
      });
    }
    // Unmute
    const deleted = await db
      .delete(userMutes)
      .where(
        and(
          eq(userMutes.muterId, authUser.userId),
          eq(userMutes.mutedId, targetUserId),
        ),
      )
      .returning({ id: userMutes.id });

    if (deleted.length === 0) {
      throw new BusinessLogicError("User is not muted", "NOT_MUTED");
    }

    logger.info(
      "User unmuted successfully",
      {
        userId: authUser.userId,
        targetUserId,
      },
      "POST /api/users/[userId]/mute",
    );

    return successResponse({
      success: true,
      message: "User unmuted successfully",
    });
  },
);

/**
 * GET /api/users/[userId]/mute
 * Check if current user has muted the target user
 */
export const GET = withErrorHandling(
  async (
    request: NextRequest,
    context: { params: Promise<{ userId: string }> },
  ) => {
    const authUser = await authenticate(request);
    const { userId: targetUserId } = await context.params;

    const [mute] = await db
      .select({
        id: userMutes.id,
        createdAt: userMutes.createdAt,
        reason: userMutes.reason,
      })
      .from(userMutes)
      .where(
        and(
          eq(userMutes.muterId, authUser.userId),
          eq(userMutes.mutedId, targetUserId),
        ),
      )
      .limit(1);

    return successResponse({
      isMuted: !!mute,
      mute: mute || null,
    });
  },
);
