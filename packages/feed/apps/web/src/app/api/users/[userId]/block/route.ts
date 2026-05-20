/**
 * User Block API
 *
 * @route POST /api/users/[userId]/block - Block or unblock user
 * @route GET /api/users/[userId]/block - Check if user is blocked
 * @access Authenticated
 *
 * @description
 * Manages user blocking/unblocking. POST blocks or unblocks a user (also removes
 * follow relationships). GET checks if the current user has blocked the target user.
 *
 * @openapi
 * /api/users/{userId}/block:
 *   post:
 *     tags:
 *       - Users
 *     summary: Block or unblock user
 *     description: Blocks or unblocks a user and removes follow relationships
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: userId
 *         required: true
 *         schema:
 *           type: string
 *         description: Target user ID to block/unblock
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
 *                 enum: [block, unblock]
 *               reason:
 *                 type: string
 *                 description: Optional reason for blocking
 *     responses:
 *       200:
 *         description: Block/unblock action completed successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 message:
 *                   type: string
 *                 block:
 *                   type: object
 *                   nullable: true
 *       400:
 *         description: Invalid action or already blocked/unblocked
 *       401:
 *         description: Unauthorized
 *       404:
 *         description: Target user not found
 *   get:
 *     tags:
 *       - Users
 *     summary: Check if user is blocked
 *     description: Returns whether the current user has blocked the target user
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
 *         description: Block status retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 isBlocked:
 *                   type: boolean
 *                 block:
 *                   type: object
 *                   nullable: true
 *
 * @example
 * ```typescript
 * // Block user
 * await fetch(`/api/users/${userId}/block`, {
 *   method: 'POST',
 *   headers: { 'Authorization': `Bearer ${token}` },
 *   body: JSON.stringify({ action: 'block', reason: 'Spam' })
 * });
 *
 * // Check block status
 * const { isBlocked } = await fetch(`/api/users/${userId}/block`, {
 *   headers: { 'Authorization': `Bearer ${token}` }
 * }).then(r => r.json());
 * ```
 *
 * @see {@link /lib/moderation/filters} Moderation filters
 */

import {
  authenticate,
  BusinessLogicError,
  InternalServerError,
  NotFoundError,
  successResponse,
  withErrorHandling,
} from "@feed/api";
import { and, db, eq, follows, or, userBlocks, users } from "@feed/db";
import { BlockUserSchema, generateSnowflakeId, logger } from "@feed/shared";
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
    const body = await request.json();
    const { action, reason } = BlockUserSchema.parse(body);

    logger.info(
      `User ${action} request`,
      {
        userId: authUser.userId,
        targetUserId,
        action,
      },
      "POST /api/users/[userId]/block",
    );

    // Cannot block yourself
    if (authUser.userId === targetUserId) {
      throw new BusinessLogicError(
        "Cannot block yourself",
        "CANNOT_BLOCK_SELF",
      );
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

    // Note: Blocking NPCs is allowed - it means they won't add you to group chats

    if (action === "block") {
      // Check if already blocked
      const [existingBlock] = await db
        .select({ id: userBlocks.id })
        .from(userBlocks)
        .where(
          and(
            eq(userBlocks.blockerId, authUser.userId),
            eq(userBlocks.blockedId, targetUserId),
          ),
        )
        .limit(1);

      if (existingBlock) {
        throw new BusinessLogicError(
          "User is already blocked",
          "ALREADY_BLOCKED",
        );
      }

      // Create block
      const blockId = await generateSnowflakeId();
      const [block] = await db
        .insert(userBlocks)
        .values({
          id: blockId,
          blockerId: authUser.userId,
          blockedId: targetUserId,
          reason: reason || null,
        })
        .returning();

      if (!block) {
        throw new InternalServerError("Failed to create block record");
      }

      // Also unfollow if following
      await db
        .delete(follows)
        .where(
          or(
            and(
              eq(follows.followerId, authUser.userId),
              eq(follows.followingId, targetUserId),
            ),
            and(
              eq(follows.followerId, targetUserId),
              eq(follows.followingId, authUser.userId),
            ),
          ),
        );

      logger.info(
        "User blocked successfully",
        {
          userId: authUser.userId,
          targetUserId,
          blockId: block?.id,
        },
        "POST /api/users/[userId]/block",
      );

      return successResponse({
        success: true,
        message: "User blocked successfully",
        block,
      });
    }
    // Unblock
    const deleted = await db
      .delete(userBlocks)
      .where(
        and(
          eq(userBlocks.blockerId, authUser.userId),
          eq(userBlocks.blockedId, targetUserId),
        ),
      )
      .returning();

    if (deleted.length === 0) {
      throw new BusinessLogicError("User is not blocked", "NOT_BLOCKED");
    }

    logger.info(
      "User unblocked successfully",
      {
        userId: authUser.userId,
        targetUserId,
      },
      "POST /api/users/[userId]/block",
    );

    return successResponse({
      success: true,
      message: "User unblocked successfully",
    });
  },
);

/**
 * GET /api/users/[userId]/block
 * Check if current user has blocked the target user
 */
export const GET = withErrorHandling(
  async (
    request: NextRequest,
    context: { params: Promise<{ userId: string }> },
  ) => {
    const authUser = await authenticate(request);
    const { userId: targetUserId } = await context.params;

    const [block] = await db
      .select({
        id: userBlocks.id,
        createdAt: userBlocks.createdAt,
        reason: userBlocks.reason,
      })
      .from(userBlocks)
      .where(
        and(
          eq(userBlocks.blockerId, authUser.userId),
          eq(userBlocks.blockedId, targetUserId),
        ),
      )
      .limit(1);

    return successResponse({
      isBlocked: !!block,
      block: block ?? null,
    });
  },
);
