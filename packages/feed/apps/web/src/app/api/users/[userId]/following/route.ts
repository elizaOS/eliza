/**
 * User Following API
 *
 * @route GET /api/users/[userId]/following - Get following list
 * @access Public
 *
 * @description
 * Returns list of users and actors that the target user is following. Supports
 * both regular users and NPCs/actors. Includes mutual follow indicators when
 * viewing own following list.
 *
 * @openapi
 * /api/users/{userId}/following:
 *   get:
 *     tags:
 *       - Users
 *     summary: Get following list
 *     description: Returns list of users/actors that the target user is following
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
 *         description: Following list retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 following:
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
 *                         nullable: true
 *                       followedAt:
 *                         type: string
 *                         format: date-time
 *                       isActor:
 *                         type: boolean
 *                       type:
 *                         type: string
 *                         enum: [user, actor]
 *                       tier:
 *                         type: string
 *                         nullable: true
 *                       isMutualFollow:
 *                         type: boolean
 *                 count:
 *                   type: integer
 *
 * @example
 * ```typescript
 * const response = await fetch('/api/users/user_123/following');
 * const { following, count } = await response.json();
 * ```
 *
 * @see {@link /lib/db/context} RLS context
 */

import {
  optionalAuth,
  requireTargetByIdentifier,
  successResponse,
  withErrorHandling,
} from '@feed/api';
import {
  actorFollows,
  and,
  db,
  desc,
  eq,
  follows,
  inArray,
  userActorFollows,
  users,
} from '@feed/db';
import { StaticDataRegistry } from '@feed/engine';
import {
  logger,
  toISO,
  UserFollowersQuerySchema,
  UserIdParamSchema,
} from '@feed/shared';
import type { NextRequest } from 'next/server';

interface FollowingResponse {
  id: string;
  displayName: string;
  username: string | null;
  profileImageUrl: string | null;
  bio: string | null;
  followedAt: string;
  isActor: boolean;
  type?: 'user' | 'actor';
  tier?: string | null;
  isMutualFollow?: boolean;
}

/**
 * GET /api/users/[userId]/following
 * Get list of users/actors that the target user is following
 */
export const GET = withErrorHandling(
  async (
    request: NextRequest,
    context: { params: Promise<{ userId: string }> }
  ) => {
    // Optional authentication - if authenticated, can provide personalized data
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

    let followingList: FollowingResponse[] = [];

    if (targetActor) {
      // Target is an NPC - get actors they follow
      const actorFollowRelations = await db
        .select({
          id: actorFollows.id,
          followingId: actorFollows.followingId,
          createdAt: actorFollows.createdAt,
        })
        .from(actorFollows)
        .where(eq(actorFollows.followerId, targetId))
        .orderBy(desc(actorFollows.createdAt));

      // Enrich with static actor data
      const actorFollowsList = actorFollowRelations
        .map((rel) => {
          const followingActor = StaticDataRegistry.getActor(rel.followingId);
          if (!followingActor) return null;
          return {
            id: rel.id,
            followingId: rel.followingId,
            createdAt: rel.createdAt,
            followingName: followingActor.name,
            followingUsername: followingActor.username,
            followingTier: followingActor.tier,
            followingProfileImageUrl: followingActor.profileImageUrl,
            followingDescription: followingActor.description,
          };
        })
        .filter((f): f is NonNullable<typeof f> => f !== null);

      followingList = actorFollowsList.map((f) => ({
        id: f.followingId,
        displayName: f.followingName,
        username: f.followingUsername || null,
        profileImageUrl: f.followingProfileImageUrl || null,
        bio: f.followingDescription || '',
        followedAt: toISO(f.createdAt),
        isActor: true,
        tier: f.followingTier || null,
      }));
    } else {
      // Target is a regular user
      // Get users being followed (Follow model)
      const userFollowsList = await db
        .select({
          id: follows.id,
          followingId: follows.followingId,
          createdAt: follows.createdAt,
          followingDisplayName: users.displayName,
          followingUsername: users.username,
          followingProfileImageUrl: users.profileImageUrl,
          followingBio: users.bio,
          followingIsActor: users.isActor,
        })
        .from(follows)
        .innerJoin(users, eq(follows.followingId, users.id))
        .where(eq(follows.followerId, targetId))
        .orderBy(desc(follows.createdAt));

      // Get actors being followed (UserActorFollow model)
      const actorFollowRelations = await db
        .select({
          id: userActorFollows.id,
          actorId: userActorFollows.actorId,
          createdAt: userActorFollows.createdAt,
        })
        .from(userActorFollows)
        .where(eq(userActorFollows.userId, targetId))
        .orderBy(desc(userActorFollows.createdAt));

      // Enrich with static actor data
      const actorFollowsList = actorFollowRelations.map((rel) => {
        const actor = StaticDataRegistry.getActor(rel.actorId);
        return {
          id: rel.id,
          actorId: rel.actorId,
          createdAt: rel.createdAt,
          actorName: actor?.name ?? null,
          actorUsername: actor?.username ?? null,
          actorDescription: actor?.description ?? null,
          actorProfileImageUrl: actor?.profileImageUrl ?? null,
          actorTier: actor?.tier ?? null,
        };
      });

      // Check mutual follows for authenticated users (using batched query for efficiency)
      const mutualFollowMap = new Map<string, boolean>();
      if (authUser?.userId) {
        const followingUserIds = userFollowsList.map((f) => f.followingId);
        const followingActorIds = actorFollowsList.map((f) => f.actorId);

        // Batch query for user mutual follows
        if (followingUserIds.length > 0) {
          const userMutualFollows = await db
            .select({ followingId: follows.followingId })
            .from(follows)
            .where(
              and(
                eq(follows.followerId, authUser.userId),
                inArray(follows.followingId, followingUserIds)
              )
            );
          for (const f of userMutualFollows) {
            mutualFollowMap.set(f.followingId, true);
          }
        }

        // Batch query for actor mutual follows
        if (followingActorIds.length > 0) {
          const actorMutualFollows = await db
            .select({ actorId: userActorFollows.actorId })
            .from(userActorFollows)
            .where(
              and(
                eq(userActorFollows.userId, authUser.userId),
                inArray(userActorFollows.actorId, followingActorIds)
              )
            );
          for (const f of actorMutualFollows) {
            mutualFollowMap.set(f.actorId, true);
          }
        }
      }

      followingList = [
        ...userFollowsList.map((f) => ({
          id: f.followingId,
          displayName: f.followingDisplayName || '',
          username: f.followingUsername || null,
          profileImageUrl: f.followingProfileImageUrl || null,
          bio: f.followingBio || null,
          isActor: f.followingIsActor,
          followedAt: toISO(f.createdAt),
          type: 'user' as const,
          tier: null,
          isMutualFollow: mutualFollowMap.get(f.followingId) || false,
        })),
        ...actorFollowsList.map((f) => {
          if (!f.actorName) {
            return {
              id: f.actorId,
              displayName: f.actorId,
              username: null,
              profileImageUrl: null,
              bio: null,
              isActor: true,
              followedAt: toISO(f.createdAt),
              type: 'actor' as const,
              tier: null,
              isMutualFollow: mutualFollowMap.get(f.actorId) || false,
            };
          }

          return {
            id: f.actorId,
            displayName: f.actorName || f.actorId,
            username: f.actorUsername || null,
            profileImageUrl: f.actorProfileImageUrl || null,
            bio: f.actorDescription || null,
            isActor: true,
            followedAt: toISO(f.createdAt),
            type: 'actor' as const,
            tier: f.actorTier || null,
            isMutualFollow: mutualFollowMap.get(f.actorId) || false,
          };
        }),
      ].sort(
        (a, b) =>
          new Date(b.followedAt).getTime() - new Date(a.followedAt).getTime()
      );
    }

    logger.info(
      'Following list fetched successfully',
      { targetId, count: followingList.length, isActor: !!targetActor },
      'GET /api/users/[userId]/following'
    );

    return successResponse({
      following: followingList,
      count: followingList.length,
    });
  }
);
