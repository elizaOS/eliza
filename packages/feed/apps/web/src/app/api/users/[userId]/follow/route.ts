/**
 * User Follow/Unfollow API Route
 *
 * @description Manage user following relationships for both users and NPC actors
 *
 * @route POST /api/users/[userId]/follow - Follow a user or actor
 * @route DELETE /api/users/[userId]/follow - Unfollow a user or actor
 * @route GET /api/users/[userId]/follow - Check follow status
 * @access Private (requires authentication)
 *
 * @openapi
 * /api/users/{userId}/follow:
 *   post:
 *     tags:
 *       - Users
 *     summary: Follow user or actor
 *     description: Follow a user or NPC actor. Creates a follow relationship and sends notification.
 *     operationId: followUser
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - name: userId
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *         description: User ID or actor ID to follow
 *     responses:
 *       201:
 *         description: Successfully followed
 *       400:
 *         description: Already following or self-follow attempt
 *       401:
 *         description: Unauthorized
 *       404:
 *         description: User or actor not found
 *   delete:
 *     tags:
 *       - Users
 *     summary: Unfollow user or actor
 *     description: Remove a follow relationship with a user or actor
 *     operationId: unfollowUser
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - name: userId
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *         description: User ID or actor ID to unfollow
 *     responses:
 *       200:
 *         description: Successfully unfollowed
 *       401:
 *         description: Unauthorized
 *       404:
 *         description: Follow relationship not found
 *   get:
 *     tags:
 *       - Users
 *     summary: Check follow status
 *     description: Check if authenticated user is following the specified user or actor
 *     operationId: checkFollowStatus
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - name: userId
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *         description: User ID or actor ID to check
 *     responses:
 *       200:
 *         description: Follow status retrieved
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 isFollowing:
 *                   type: boolean
 *                   description: Whether user is following the target
 */

import {
  authenticate,
  BusinessLogicError,
  cachedDb,
  checkProgress,
  checkRateLimitAndDuplicates,
  findUserByIdentifier,
  InternalServerError,
  NotFoundError,
  notifyFollow,
  RATE_LIMIT_CONFIGS,
  successResponse,
  withErrorHandling,
} from "@feed/api";
import {
  and,
  db,
  eq,
  follows,
  userActorFollows,
  users,
  withTransaction,
} from "@feed/db";
import { StaticDataRegistry } from "@feed/engine";
import { generateSnowflakeId, logger, UserIdParamSchema } from "@feed/shared";
import type { NextRequest } from "next/server";
import { trackServerEvent } from "@/lib/posthog/server";

/**
 * POST /api/users/[userId]/follow
 *
 * Creates a follow relationship between the authenticated user and target user or actor.
 * Supports both regular users (via Follow model) and actors/NPCs (via UserActorFollow model).
 * Sends follow notifications, invalidates caches, and tracks analytics events.
 *
 * @param request - Next.js request object
 * @param context - Route context with user ID parameter (can be user ID or actor ID)
 * @returns Follow relationship data with target user/actor details
 * @throws {400} Already following, self-follow attempt, or rate limited
 * @throws {401} Unauthorized
 * @throws {404} Target user or actor not found
 */
export const POST = withErrorHandling(
  async (
    request: NextRequest,
    context: { params: Promise<{ userId: string }> },
  ) => {
    // Authenticate user
    const user = await authenticate(request);

    // Apply rate limiting (no duplicate detection needed)
    const rateLimitError = checkRateLimitAndDuplicates(
      user.userId,
      null,
      RATE_LIMIT_CONFIGS.FOLLOW_USER,
    );
    if (rateLimitError) {
      return rateLimitError;
    }

    const params = await context.params;
    const { userId: targetIdentifier } = UserIdParamSchema.parse(params);
    const targetUser = await findUserByIdentifier(targetIdentifier, {
      id: true,
      isActor: true,
    });
    const targetId = targetUser?.id ?? targetIdentifier;

    // Prevent self-following
    if (targetUser && user.userId === targetId) {
      throw new BusinessLogicError("Cannot follow yourself", "SELF_FOLLOW");
    }

    // Check if target exists (could be a user or actor)
    // Use static registry to check for actor
    const targetActorStatic = StaticDataRegistry.getActor(targetId);
    const targetActor = targetActorStatic ? { id: targetActorStatic.id } : null;

    // If neither user nor actor found, return error
    // Also error if targetUser has isActor flag but no Actor record exists
    if (!targetUser && !targetActor) {
      throw new NotFoundError("User or actor", targetId);
    }
    if (targetUser?.isActor && !targetActor) {
      throw new NotFoundError("Actor", targetId);
    }

    // If targetUser has isActor flag, treat as actor (not regular user)
    // Also check if targetActor exists (could be actor ID that doesn't match a user)
    if (targetUser && !targetUser.isActor) {
      // Target is a regular user - use Follow model
      // Check if already following and create follow inside transaction
      const newFollow = await withTransaction(async (tx) => {
        const [existingFollow] = await tx
          .select({ id: follows.id })
          .from(follows)
          .where(
            and(
              eq(follows.followerId, user.userId),
              eq(follows.followingId, targetId),
            ),
          )
          .limit(1)
          .for("update");

        if (existingFollow) {
          throw new BusinessLogicError(
            "Already following this user",
            "ALREADY_FOLLOWING",
          );
        }

        const followId = await generateSnowflakeId();
        const [createdFollow] = await tx
          .insert(follows)
          .values({
            id: followId,
            followerId: user.userId,
            followingId: targetId,
          })
          .returning();

        if (!createdFollow) {
          throw new InternalServerError("Failed to create follow record");
        }

        return createdFollow;
      });

      // Get target user details
      const [targetUserDetails] = await db
        .select({
          id: users.id,
          displayName: users.displayName,
          username: users.username,
          profileImageUrl: users.profileImageUrl,
          bio: users.bio,
        })
        .from(users)
        .where(eq(users.id, targetId))
        .limit(1);

      // Create notification for the followed user
      await notifyFollow(targetId, user.userId);

      // Invalidate caches for both users to update follower/following counts
      await Promise.all([
        cachedDb.invalidateUserCache(user.userId), // Invalidate follower's cache
        cachedDb.invalidateUserCache(targetId), // Invalidate target's cache
      ]).catch((error) => {
        logger.warn("Failed to invalidate user cache after follow", { error });
      });

      logger.info(
        "User followed successfully",
        { userId: user.userId, targetId },
        "POST /api/users/[userId]/follow",
      );

      // Track user followed event
      trackServerEvent(user.userId, "user_followed", {
        targetUserId: targetId,
        targetType: "user",
        ...(targetUserDetails?.username && {
          targetUsername: targetUserDetails.username,
        }),
      }).catch((error) => {
        logger.warn("Failed to track user_followed event", { error });
      });

      if (!newFollow) {
        throw new InternalServerError("Failed to create follow record");
      }

      void checkProgress(user.userId, { type: "follow_created" });

      return successResponse(
        {
          id: newFollow.id,
          following: targetUserDetails,
          createdAt: newFollow.createdAt,
        },
        201,
      );
    }
    // Target is an actor (NPC) or user with isActor=true - use UserActorFollow model
    const [existingUserActorFollow] = await db
      .select({ id: userActorFollows.id })
      .from(userActorFollows)
      .where(
        and(
          eq(userActorFollows.userId, user.userId),
          eq(userActorFollows.actorId, targetId),
        ),
      )
      .limit(1);

    if (existingUserActorFollow) {
      throw new BusinessLogicError(
        "Already following this actor",
        "ALREADY_FOLLOWING",
      );
    }

    const followId = await generateSnowflakeId();

    const actorDetails = StaticDataRegistry.getActor(targetId);

    // Create the follow
    await db.insert(userActorFollows).values({
      id: followId,
      userId: user.userId,
      actorId: targetId,
    });

    // Fetch the created follow for the response
    const [createdFollow] = await db
      .select()
      .from(userActorFollows)
      .where(eq(userActorFollows.id, followId))
      .limit(1);

    // Invalidate cache for the user to update following count
    await cachedDb.invalidateUserCache(user.userId).catch((error) => {
      logger.warn("Failed to invalidate user cache after actor follow", {
        error,
      });
    });

    logger.info(
      "Actor followed successfully",
      { userId: user.userId, npcId: targetId },
      "POST /api/users/[userId]/follow",
    );

    // Track actor followed event
    trackServerEvent(user.userId, "user_followed", {
      targetUserId: targetId,
      targetType: "actor",
      ...(actorDetails?.name && { actorName: actorDetails.name }),
      ...(actorDetails?.tier && { actorTier: actorDetails.tier }),
    }).catch((error) => {
      logger.warn("Failed to track user_followed event", { error });
    });

    if (!createdFollow) {
      throw new InternalServerError("Failed to fetch created follow record");
    }

    return successResponse(
      {
        id: createdFollow.id,
        actor: actorDetails,
        createdAt: createdFollow.createdAt,
      },
      201,
    );
  },
);

/**
 * DELETE /api/users/[userId]/follow
 * Unfollow a user or actor
 */
export const DELETE = withErrorHandling(
  async (
    request: NextRequest,
    context: { params: Promise<{ userId: string }> },
  ) => {
    // Authenticate user
    const user = await authenticate(request);

    // Apply rate limiting (no duplicate detection needed)
    const rateLimitError = checkRateLimitAndDuplicates(
      user.userId,
      null,
      RATE_LIMIT_CONFIGS.UNFOLLOW_USER,
    );
    if (rateLimitError) {
      return rateLimitError;
    }

    const params = await context.params;
    const { userId: targetIdentifier } = UserIdParamSchema.parse(params);
    const targetUser = await findUserByIdentifier(targetIdentifier, {
      id: true,
      isActor: true,
    });
    const targetId = targetUser?.id ?? targetIdentifier;

    // If targetUser has isActor flag, treat as actor (not regular user)
    if (targetUser && !targetUser.isActor) {
      // Target is a regular user - use Follow model
      const [follow] = await db
        .select({ id: follows.id })
        .from(follows)
        .where(
          and(
            eq(follows.followerId, user.userId),
            eq(follows.followingId, targetId),
          ),
        )
        .limit(1);

      if (!follow) {
        throw new NotFoundError(
          "Follow relationship",
          `${user.userId}-${targetId}`,
        );
      }

      // Delete follow relationship
      await db.delete(follows).where(eq(follows.id, follow.id));

      // Invalidate caches for both users to update follower/following counts
      await Promise.all([
        cachedDb.invalidateUserCache(user.userId), // Invalidate unfollower's cache
        cachedDb.invalidateUserCache(targetId), // Invalidate target's cache
      ]).catch((error) => {
        logger.warn("Failed to invalidate user cache after unfollow", {
          error,
        });
      });

      logger.info(
        "User unfollowed successfully",
        { userId: user.userId, targetId },
        "DELETE /api/users/[userId]/follow",
      );

      // Track user unfollowed event
      trackServerEvent(user.userId, "user_unfollowed", {
        targetUserId: targetId,
        targetType: "user",
      }).catch((error) => {
        logger.warn("Failed to track user_unfollowed event", { error });
      });

      return successResponse({
        message: "Unfollowed successfully",
      });
    }
    // Target is an actor (NPC) - use UserActorFollow model
    const [existingUserActorFollow] = await db
      .select({ id: userActorFollows.id })
      .from(userActorFollows)
      .where(
        and(
          eq(userActorFollows.userId, user.userId),
          eq(userActorFollows.actorId, targetId),
        ),
      )
      .limit(1);

    if (!existingUserActorFollow) {
      throw new NotFoundError("Follow status", `${user.userId}-${targetId}`);
    }

    await db
      .delete(userActorFollows)
      .where(eq(userActorFollows.id, existingUserActorFollow.id));

    // Invalidate cache for the user to update following count
    await cachedDb.invalidateUserCache(user.userId).catch((error) => {
      logger.warn("Failed to invalidate user cache after actor unfollow", {
        error,
      });
    });

    logger.info(
      "Actor unfollowed successfully",
      { userId: user.userId, npcId: targetId },
      "DELETE /api/users/[userId]/follow",
    );

    // Track actor unfollowed event
    trackServerEvent(user.userId, "user_unfollowed", {
      targetUserId: targetId,
      targetType: "actor",
    }).catch((error) => {
      logger.warn("Failed to track user_unfollowed event", { error });
    });

    return successResponse({
      message: "Unfollowed successfully",
    });
  },
);

/**
 * GET /api/users/[userId]/follow
 * Check if current user is following the target
 */
export const GET = withErrorHandling(
  async (
    request: NextRequest,
    context: { params: Promise<{ userId: string }> },
  ) => {
    // Optional authentication - if not authenticated, return false
    const authUser = await authenticate(request).catch(() => null);
    const params = await context.params;
    const { userId: targetId } = UserIdParamSchema.parse(params);

    if (!authUser) {
      return successResponse({ isFollowing: false });
    }

    // Check if target is a user
    const [targetUser] = await db
      .select({ id: users.id, isActor: users.isActor })
      .from(users)
      .where(eq(users.id, targetId))
      .limit(1);

    // If targetUser has isActor flag, treat as actor (not regular user)
    if (targetUser && !targetUser.isActor) {
      // Target is a regular user - check Follow model
      const [follow] = await db
        .select({ id: follows.id })
        .from(follows)
        .where(
          and(
            eq(follows.followerId, authUser.userId),
            eq(follows.followingId, targetId),
          ),
        )
        .limit(1);

      logger.info(
        "Follow status checked",
        { userId: authUser.userId, targetId, isFollowing: !!follow },
        "GET /api/users/[userId]/follow",
      );

      return successResponse({
        isFollowing: !!follow,
      });
    }
    // Target might be an actor (NPC) - check static registry
    const targetActorData = StaticDataRegistry.getActor(targetId);

    if (targetActorData) {
      const [userActorFollow] = await db
        .select({ id: userActorFollows.id })
        .from(userActorFollows)
        .where(
          and(
            eq(userActorFollows.userId, authUser.userId),
            eq(userActorFollows.actorId, targetId),
          ),
        )
        .limit(1);

      const isFollowing = !!userActorFollow;
      logger.info(
        "Actor follow status checked",
        { userId: authUser.userId, npcId: targetId, isFollowing },
        "GET /api/users/[userId]/follow",
      );

      return successResponse({
        isFollowing,
      });
    }
    // Neither user nor actor found - return false for isFollowing
    // This prevents errors when checking follow status for non-existent profiles
    logger.info(
      "Follow status checked for non-existent target",
      { userId: authUser.userId, targetId },
      "GET /api/users/[userId]/follow",
    );

    return successResponse({
      isFollowing: false,
    });
  },
);
