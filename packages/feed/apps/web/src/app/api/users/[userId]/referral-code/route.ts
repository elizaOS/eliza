/**
 * User Referral Code API
 *
 * @route GET /api/users/[userId]/referral-code - Get or generate referral code
 * @access Authenticated (own profile only)
 *
 * @description
 * Gets user's referral code, generating one if it doesn't exist. Creates referral
 * entry if needed. Returns referral code, count, and shareable URL.
 *
 * @openapi
 * /api/users/{userId}/referral-code:
 *   get:
 *     tags:
 *       - Users
 *     summary: Get referral code
 *     description: Gets or generates user's referral code (own profile only)
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: userId
 *         required: true
 *         schema:
 *           type: string
 *         description: User ID (must match authenticated user)
 *     responses:
 *       200:
 *         description: Referral code retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 referralCode:
 *                   type: string
 *                 referralCount:
 *                   type: integer
 *                 referralUrl:
 *                   type: string
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Cannot access another user's referral code
 *
 * @example
 * ```typescript
 * const { referralCode, referralUrl } = await fetch(`/api/users/${userId}/referral-code`, {
 *   headers: { 'Authorization': `Bearer ${token}` }
 * }).then(r => r.json());
 * ```
 */

import {
  AuthorizationError,
  authenticate,
  getOrCreateReferralCode,
  NotFoundError,
  requireUserByIdentifier,
  successResponse,
  withErrorHandling,
} from '@feed/api';
import { db, eq, users } from '@feed/db';
import { logger, UserIdParamSchema } from '@feed/shared';
import type { NextRequest } from 'next/server';

/**
 * GET /api/users/[userId]/referral-code
 * Get user's referral code (create if doesn't exist)
 */
export const GET = withErrorHandling(
  async (
    request: NextRequest,
    context: { params: Promise<{ userId: string }> }
  ) => {
    // Authenticate user
    const authUser = await authenticate(request);
    const params = await context.params;
    const { userId } = UserIdParamSchema.parse(params);
    const targetUser = await requireUserByIdentifier(userId, { id: true });
    const canonicalUserId = targetUser.id;

    // Verify user is accessing their own referral code
    if (authUser.userId !== canonicalUserId) {
      throw new AuthorizationError(
        'You can only access your own referral code',
        'referral-code',
        'read'
      );
    }

    // Get or create referral code
    const referralCode = await getOrCreateReferralCode(canonicalUserId);

    // Get user stats
    const [user] = await db
      .select({
        referralCount: users.referralCount,
      })
      .from(users)
      .where(eq(users.id, canonicalUserId))
      .limit(1);

    if (!user) {
      throw new NotFoundError('User', canonicalUserId);
    }

    logger.info(
      'Referral code fetched successfully',
      { userId: canonicalUserId, referralCode },
      'GET /api/users/[userId]/referral-code'
    );

    return successResponse({
      referralCode,
      referralCount: user.referralCount,
      referralUrl: `${process.env.NEXT_PUBLIC_APP_URL || 'https://feed.market'}?ref=${referralCode}`,
    });
  }
);
