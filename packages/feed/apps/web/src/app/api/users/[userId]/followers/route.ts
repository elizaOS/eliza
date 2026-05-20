/**
 * User Followers API
 *
 * @route GET /api/users/[userId]/followers - Get followers list
 * @access Public
 *
 * @description
 * Returns list of users and actors following the target user. Supports both
 * regular users and NPCs/actors.
 *
 * @openapi
 * /api/users/{userId}/followers:
 *   get:
 *     tags:
 *       - Users
 *     summary: Get followers list
 *     description: Returns list of users/actors following the target user
 *     parameters:
 *       - in: path
 *         name: userId
 *         required: true
 *         schema:
 *           type: string
 *         description: User ID, username, or wallet address
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *         description: Page number
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *         description: Results per page
 *       - in: query
 *         name: includeMutual
 *         schema:
 *           type: boolean
 *         description: Include mutual follow indicators
 *     responses:
 *       200:
 *         description: Followers list retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 followers:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id:
 *                         type: string
 *                       displayName:
 *                         type: string
 *                       username:
 *                         type: string
 *                         nullable: true
 *                       profileImageUrl:
 *                         type: string
 *                         nullable: true
 *                       bio:
 *                         type: string
 *                       followedAt:
 *                         type: string
 *                         format: date-time
 *                       isActor:
 *                         type: boolean
 *                       tier:
 *                         type: string
 *                 count:
 *                   type: integer
 *
 * @example
 * ```typescript
 * const response = await fetch('/api/users/user_123/followers');
 * const { followers, count } = await response.json();
 * ```
 *
 * @see {@link /lib/db/context} RLS context
 */

import {
  optionalAuth,
  requireTargetByIdentifier,
  successResponse,
  withErrorHandling,
} from '@babylon/api';
import {
  actorFollows,
  and,
  db,
  desc,
  eq,
  followStatuses,
  follows,
  inArray,
  not,
  userActorFollows,
  users,
} from '@babylon/db';
import { StaticDataRegistry } from '@babylon/engine';
import {
  logger,
  toISO,
  UserFollowersQuerySchema,
  UserIdParamSchema,
} from '@babylon/shared';
import type { NextRequest } from 'next/server';

interface FollowerResponse {
  id: string;
  displayName: string;
  username: string | null;
  profileImageUrl: string | null;
  bio: string;
  followedAt: string;
  isActor: boolean;
  tier?: string;
  isMutualFollow?: boolean;
}

/**
 * GET /api/users/[userId]/followers
 * Get list of users following the target user
 */
export const GET = withErrorHandling(
  async (
    request: NextRequest,
    context: { params: Promise<{ userId: string }> }
  ) => {
    const authUser = await optionalAuth(request);
    const params = await context.params;
    const { userId: targetIdentifier } = UserIdParamSchema.parse(params);

    // Validate query parameters
    const { searchParams } = new URL(request.url);
    const queryParams = {
      page: searchParams.get('page'),
      limit: searchParams.get('limit'),
      includeMutual: searchParams.get('includeMutual'),
    };
    UserFollowersQuerySchema.parse(queryParams);

    // Find target (user or actor) - throws NotFoundError if neither exists
    const { actor: targetActor, targetId } =
      await requireTargetByIdentifier(targetIdentifier);

    let followersList: FollowerResponse[] = [];

    if (targetActor) {
      // Target is an NPC - get both actor followers and user followers
      const actorFollowRelations = await db
        .select({
          id: actorFollows.id,
          followerId: actorFollows.followerId,
          createdAt: actorFollows.createdAt,
        })
        .from(actorFollows)
        .where(eq(actorFollows.followingId, targetId))
        .orderBy(desc(actorFollows.createdAt));

      // Enrich with static actor data
      const actorFollowersList = actorFollowRelations
        .map((rel) => {
          const followerActor = StaticDataRegistry.getActor(rel.followerId);
          if (!followerActor) return null;
          return {
            id: rel.id,
            followerId: rel.followerId,
            createdAt: rel.createdAt,
            followerName: followerActor.name,
            followerUsername: followerActor.username,
            followerTier: followerActor.tier,
            followerProfileImageUrl: followerActor.profileImageUrl,
            followerDescription: followerActor.description,
          };
        })
        .filter((f): f is NonNullable<typeof f> => f !== null);

      const userActorFollowersList = await db
        .select({
          id: userActorFollows.id,
          userId: userActorFollows.userId,
          createdAt: userActorFollows.createdAt,
          userDisplayName: users.displayName,
          userUsername: users.username,
          userProfileImageUrl: users.profileImageUrl,
          userBio: users.bio,
        })
        .from(userActorFollows)
        .innerJoin(users, eq(userActorFollows.userId, users.id))
        .where(eq(userActorFollows.actorId, targetId))
        .orderBy(desc(userActorFollows.createdAt))
        .limit(200);

      followersList = [
        ...actorFollowersList.map((f) => ({
          id: f.followerId,
          displayName: f.followerName,
          username: f.followerUsername || null,
          profileImageUrl: f.followerProfileImageUrl || null,
          bio: f.followerDescription || '',
          followedAt: toISO(f.createdAt),
          isActor: true,
          tier: f.followerTier || undefined,
        })),
        ...userActorFollowersList.map((f) => ({
          id: f.userId,
          displayName: f.userDisplayName || '',
          username: f.userUsername || null,
          profileImageUrl: f.userProfileImageUrl || null,
          bio: f.userBio || '',
          followedAt: toISO(f.createdAt),
          isActor: false,
        })),
      ].sort(
        (a, b) =>
          new Date(b.followedAt).getTime() - new Date(a.followedAt).getTime()
      );
    } else {
      // Target is a regular user
      const userFollows = await db
        .select({
          id: follows.id,
          followerId: follows.followerId,
          createdAt: follows.createdAt,
          followerDisplayName: users.displayName,
          followerUsername: users.username,
          followerProfileImageUrl: users.profileImageUrl,
          followerBio: users.bio,
        })
        .from(follows)
        .innerJoin(users, eq(follows.followerId, users.id))
        .where(eq(follows.followingId, targetId))
        .orderBy(desc(follows.createdAt));

      const npcFollowersList = await db
        .select()
        .from(followStatuses)
        .where(
          and(
            eq(followStatuses.userId, targetId),
            eq(followStatuses.isActive, true),
            not(eq(followStatuses.followReason, 'user_followed'))
          )
        )
        .orderBy(desc(followStatuses.followedAt));

      const npcIds = npcFollowersList.map((f) => f.npcId);
      const actorMap = new Map(
        npcIds
          .map((id) => StaticDataRegistry.getActor(id))
          .filter((a): a is NonNullable<typeof a> => a !== null)
          .map((a) => [a.id, a])
      );

      followersList = [
        ...userFollows.map((f) => ({
          id: f.followerId,
          displayName: f.followerDisplayName || '',
          username: f.followerUsername || null,
          profileImageUrl: f.followerProfileImageUrl || null,
          bio: f.followerBio || '',
          followedAt: toISO(f.createdAt),
          isActor: false,
        })),
        ...npcFollowersList.map((f) => {
          const actor = actorMap.get(f.npcId);
          return {
            id: f.npcId,
            displayName: actor?.name || f.npcId,
            username: actor?.username || null,
            profileImageUrl: actor?.profileImageUrl || null,
            bio: actor?.description || '',
            followedAt: toISO(f.followedAt),
            isActor: true,
            tier: actor?.tier || undefined,
          };
        }),
      ].sort(
        (a, b) =>
          new Date(b.followedAt).getTime() - new Date(a.followedAt).getTime()
      );
    }

    // Check if authenticated user follows each follower (for showing follow/unfollow button state)
    if (authUser?.userId) {
      const followerIds = followersList
        .filter((f) => !f.isActor)
        .map((f) => f.id);
      const actorFollowerIds = followersList
        .filter((f) => f.isActor)
        .map((f) => f.id);

      // Check which followers the authenticated user follows (using inArray for efficiency)
      const followedUserIds = new Set<string>();
      if (followerIds.length > 0) {
        const userFollowResults = await db
          .select({ followingId: follows.followingId })
          .from(follows)
          .where(
            and(
              eq(follows.followerId, authUser.userId),
              inArray(follows.followingId, followerIds)
            )
          );
        for (const f of userFollowResults) {
          followedUserIds.add(f.followingId);
        }
      }

      // Check actor follows (using inArray for efficiency)
      const followedActorIds = new Set<string>();
      if (actorFollowerIds.length > 0) {
        const actorFollowResults = await db
          .select({ actorId: userActorFollows.actorId })
          .from(userActorFollows)
          .where(
            and(
              eq(userActorFollows.userId, authUser.userId),
              inArray(userActorFollows.actorId, actorFollowerIds)
            )
          );
        for (const f of actorFollowResults) {
          followedActorIds.add(f.actorId);
        }
      }

      // Add isMutualFollow to each follower (true if auth user follows them)
      for (const follower of followersList) {
        follower.isMutualFollow = follower.isActor
          ? followedActorIds.has(follower.id)
          : followedUserIds.has(follower.id);
      }
    }

    logger.info(
      'Followers fetched successfully',
      { targetId, count: followersList.length, isActor: !!targetActor },
      'GET /api/users/[userId]/followers'
    );

    return successResponse({
      followers: followersList,
      count: followersList.length,
    });
  }
);
