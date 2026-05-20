/**
 * User Verify Twitter Follow API
 *
 * @route POST /api/users/[userId]/verify-twitter-follow - Verify Twitter follow
 * @access Authenticated
 *
 * @description
 * Awards points for following @PlayFeed on Twitter/X.
 * Uses a trusted reward system (no API verification needed).
 *
 * @openapi
 * /api/users/{userId}/verify-twitter-follow:
 *   post:
 *     tags:
 *       - Users
 *     summary: Award points for Twitter follow
 *     description: Awards points for following @PlayFeed (trusted system, authenticated user only)
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: userId
 *         required: true
 *         schema:
 *           type: string
 *         description: User ID
 *     responses:
 *       200:
 *         description: Points awarded successfully
 *       400:
 *         description: Invalid input
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Not authorized for this user
 *
 * @example
 * ```typescript
 * await fetch(`/api/users/${userId}/verify-twitter-follow`, {
 *   method: 'POST',
 *   headers: { 'Authorization': `Bearer ${token}` },
 * });
 * ```
 */

import {
  AuthorizationError,
  authenticate,
  BusinessLogicError,
  invalidateCache,
  ReputationService,
  requireUserByIdentifier,
  successResponse,
  withErrorHandling,
} from '@feed/api';
import { db, eq, users } from '@feed/db';
import { logger, UserIdParamSchema } from '@feed/shared';
import type { NextRequest } from 'next/server';

/**
 * POST /api/users/[userId]/verify-twitter-follow
 * Award points for following @PlayFeed on Twitter (trusted system)
 */
export const POST = withErrorHandling(
  async (
    request: NextRequest,
    context: { params: Promise<{ userId: string }> }
  ) => {
    // Authenticate user
    const authUser = await authenticate(request);
    const { userId } = UserIdParamSchema.parse(await context.params);

    // Check if the authenticated user has a database record
    if (!authUser.dbUserId) {
      throw new AuthorizationError(
        'User profile not found. Please complete onboarding first.',
        'twitter-follow-verification',
        'create'
      );
    }

    const targetUser = await requireUserByIdentifier(userId, { id: true });
    const canonicalUserId = targetUser.id;

    // Verify user is claiming their own follow reward
    if (authUser.dbUserId !== canonicalUserId) {
      throw new AuthorizationError(
        'You can only claim your own Twitter follow reward',
        'twitter-follow-verification',
        'create'
      );
    }

    // Get user's Twitter info
    const [user] = await db
      .select({
        twitterUsername: users.twitterUsername,
        twitterId: users.twitterId,
        pointsAwardedForTwitterFollow: users.pointsAwardedForTwitterFollow,
      })
      .from(users)
      .where(eq(users.id, canonicalUserId))
      .limit(1);

    // VALIDATION: Check if user has linked Twitter account
    if (!user?.twitterUsername && !user?.twitterId) {
      throw new BusinessLogicError(
        'Please link your Twitter account first to claim this reward.',
        'TWITTER_NOT_LINKED'
      );
    }

    const alreadyAwarded = user.pointsAwardedForTwitterFollow;

    if (alreadyAwarded) {
      logger.info(
        'Twitter follow reward already claimed',
        { userId: canonicalUserId },
        'POST /api/users/[userId]/verify-twitter-follow'
      );

      return successResponse({
        verified: true,
        message: 'You already received reputation for this action.',
        reputation: {
          awarded: 0,
          newReputationTotal: 0,
        },
      });
    }

    // Award reputation (trusted system - no API verification).
    const reputationResult =
      await ReputationService.awardTwitterFollow(canonicalUserId);

    let reputationAwarded = 0;
    let newReputationTotal = 0;

    if (reputationResult.success) {
      reputationAwarded = reputationResult.reputationAwarded;
      newReputationTotal = reputationResult.newReputationTotal;

      // Ensure the waitlist dashboard reflects new reputation immediately.
      await invalidateCache(canonicalUserId, {
        namespace: 'waitlist:position',
      });

      logger.info(
        `Awarded ${reputationAwarded} reputation for Twitter follow (trusted)`,
        { userId: canonicalUserId, reputationAwarded },
        'POST /api/users/[userId]/verify-twitter-follow'
      );
    }

    return successResponse({
      verified: true,
      message:
        reputationAwarded > 0
          ? `Thank you for following! You earned ${reputationAwarded} reputation.`
          : 'Follow reward claimed successfully!',
      reputation: {
        awarded: reputationAwarded,
        newReputationTotal,
      },
    });
  }
);
