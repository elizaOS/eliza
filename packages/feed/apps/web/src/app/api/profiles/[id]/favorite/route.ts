/**
 * Profile Favorite API
 *
 * @route POST /api/profiles/[id]/favorite - Favorite profile
 * @route DELETE /api/profiles/[id]/favorite - Unfavorite profile
 * @access Authenticated
 *
 * @description
 * Manages profile favorites. POST favorites a profile. DELETE removes
 * favorite. Only accessible by authenticated user.
 *
 * @openapi
 * /api/profiles/{id}/favorite:
 *   post:
 *     tags:
 *       - Profiles
 *     summary: Favorite profile
 *     description: Adds profile to favorites (authenticated user only)
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Profile ID
 *     responses:
 *       200:
 *         description: Profile favorited successfully
 *       401:
 *         description: Unauthorized
 *       404:
 *         description: Profile not found
 *   delete:
 *     tags:
 *       - Profiles
 *     summary: Unfavorite profile
 *     description: Removes profile from favorites (authenticated user only)
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Profile ID
 *     responses:
 *       200:
 *         description: Profile unfavorited successfully
 *       401:
 *         description: Unauthorized
 *       404:
 *         description: Profile not found
 *
 * @example
 * ```typescript
 * // Favorite
 * await fetch(`/api/profiles/${profileId}/favorite`, {
 *   method: 'POST',
 *   headers: { 'Authorization': `Bearer ${token}` }
 * });
 * ```
 */

import {
  authenticate,
  BusinessLogicError,
  NotFoundError,
  successResponse,
  withErrorHandling,
} from '@feed/api';
import { asUser } from '@feed/db';
import { generateSnowflakeId, IdParamSchema, logger } from '@feed/shared';
import type { NextRequest } from 'next/server';

/**
 * POST /api/profiles/[id]/favorite
 * Favorite a profile
 */
export const POST = withErrorHandling(
  async (
    request: NextRequest,
    context: { params: Promise<{ id: string }> }
  ) => {
    // Authenticate user
    const user = await authenticate(request);
    const params = await context.params;
    const { id: targetIdentifier } = IdParamSchema.parse(params);

    // Favorite profile with RLS
    const result = await asUser(user, async (db) => {
      // Try to find user by ID first, then by username
      let targetUser = await db.user.findUnique({
        where: { id: targetIdentifier },
      });

      // If not found by ID, try username
      if (!targetUser) {
        targetUser = await db.user.findUnique({
          where: { username: targetIdentifier },
        });
      }

      if (!targetUser) {
        throw new NotFoundError('Profile', targetIdentifier);
      }

      const targetUserId = targetUser.id;

      // Prevent self-favoriting
      if (user.userId === targetUserId) {
        throw new BusinessLogicError(
          'Cannot favorite yourself',
          'SELF_FAVORITE_NOT_ALLOWED'
        );
      }

      // Check if already favorited
      const existingFavorite = await db.favorite.findFirst({
        where: {
          userId: user.userId,
          targetUserId,
        },
      });

      if (existingFavorite) {
        throw new BusinessLogicError(
          'Profile already favorited',
          'ALREADY_FAVORITED'
        );
      }

      // Create favorite
      const fav = await db.favorite.create({
        data: {
          id: await generateSnowflakeId(),
          userId: user.userId,
          targetUserId,
        },
      });

      // Get target user details
      const targetUserDetails = await db.user.findUnique({
        where: { id: targetUserId },
        select: {
          id: true,
          displayName: true,
          username: true,
          profileImageUrl: true,
          bio: true,
        },
      });

      return { favorite: fav, targetUser: targetUserDetails, targetUserId };
    });

    logger.info(
      'Profile favorited successfully',
      { userId: user.userId, targetUserId: result.targetUserId },
      'POST /api/profiles/[id]/favorite'
    );

    if (!result.favorite) {
      throw new Error('Failed to create favorite');
    }

    return successResponse(
      {
        id: result.favorite.id,
        targetUser: result.targetUser ?? null,
        createdAt: result.favorite.createdAt,
      },
      201
    );
  }
);

/**
 * DELETE /api/profiles/[id]/favorite
 * Unfavorite a profile
 */
export const DELETE = withErrorHandling(
  async (
    request: NextRequest,
    context: { params: Promise<{ id: string }> }
  ) => {
    // Authenticate user
    const user = await authenticate(request);
    const params = await context.params;
    const { id: targetIdentifier } = IdParamSchema.parse(params);

    // Unfavorite profile with RLS
    const targetUserId = await asUser(user, async (db) => {
      // Try to find user by ID first, then by username
      let targetUser = await db.user.findUnique({
        where: { id: targetIdentifier },
      });

      // If not found by ID, try username
      if (!targetUser) {
        targetUser = await db.user.findUnique({
          where: { username: targetIdentifier },
        });
      }

      if (!targetUser) {
        throw new NotFoundError('Profile', targetIdentifier);
      }

      const targetUserId = targetUser.id;

      // Find existing favorite
      const favorite = await db.favorite.findFirst({
        where: {
          userId: user.userId,
          targetUserId,
        },
      });

      if (!favorite) {
        throw new NotFoundError('Favorite', `${user.userId}-${targetUserId}`);
      }

      // Delete favorite
      await db.favorite.delete({
        where: {
          id: favorite.id,
        },
      });

      return targetUserId;
    });

    logger.info(
      'Profile unfavorited successfully',
      { userId: user.userId, targetUserId },
      'DELETE /api/profiles/[id]/favorite'
    );

    return successResponse({ message: 'Profile unfavorited successfully' });
  }
);
