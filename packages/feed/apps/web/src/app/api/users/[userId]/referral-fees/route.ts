/**
 * User Referral Fees API
 *
 * @route GET /api/users/[userId]/referral-fees - Get referral fee earnings
 * @access Authenticated (own profile only)
 *
 * @description
 * Returns referral fee earnings including total earned, total referrals, top
 * referrals, and recent fee transactions. Requires own profile access.
 *
 * @openapi
 * /api/users/{userId}/referral-fees:
 *   get:
 *     tags:
 *       - Users
 *     summary: Get referral fee earnings
 *     description: Returns referral fee earnings and statistics (own profile only)
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
 *         description: Referral fees retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 totalEarned:
 *                   type: number
 *                 totalReferrals:
 *                   type: integer
 *                 topReferrals:
 *                   type: array
 *                 recentFees:
 *                   type: array
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Cannot access another user's referral fees
 *
 * @example
 * ```typescript
 * const { totalEarned, recentFees } = await fetch(`/api/users/${userId}/referral-fees`, {
 *   headers: { 'Authorization': `Bearer ${token}` }
 * }).then(r => r.json());
 * ```
 *
 * @see {@link /lib/services/fee-service} Fee service
 */

import {
  authenticate,
  requireUserByIdentifier,
  successResponse,
  withErrorHandling,
} from "@feed/api";
import { FeeService } from "@feed/engine";
import { logger } from "@feed/shared";
import type { NextRequest } from "next/server";

export const GET = withErrorHandling(
  async (
    request: NextRequest,
    context: { params: Promise<{ userId: string }> },
  ) => {
    const authUser = await authenticate(request);
    const { userId } = await context.params;

    // Verify authorization
    const user = await requireUserByIdentifier(userId, {
      id: true,
      totalFeesEarned: true,
    });

    if (authUser.userId !== user.id) {
      throw new Error("Unauthorized");
    }

    // Get referral earnings
    const earnings = await FeeService.getReferralEarnings(user.id, {
      limit: 20,
    });

    logger.info(
      "Referral fees fetched",
      {
        userId: user.id,
        totalEarned: earnings.totalEarned,
        totalReferrals: earnings.totalReferrals,
      },
      "GET /api/users/[userId]/referral-fees",
    );

    return successResponse({
      totalEarned: earnings.totalEarned,
      totalReferrals: earnings.totalReferrals,
      topReferrals: earnings.topReferrals,
      recentFees: earnings.recentFees,
    });
  },
);
