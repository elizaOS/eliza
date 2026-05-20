/**
 * Admin Moderation Human Review Process API
 *
 * @route POST /api/admin/moderation/human-review/[userId] - Process appeal
 * @access Admin
 *
 * @description
 * Processes an individual user appeal. Approves or denies the appeal with
 * reasoning. Approving unban restores user and refunds stake. Denying
 * keeps user banned and may transfer stake.
 *
 * @openapi
 * /api/admin/moderation/human-review/{userId}:
 *   post:
 *     tags:
 *       - Admin
 *     summary: Process user appeal
 *     description: Approves or denies user appeal (admin only)
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: userId
 *         required: true
 *         schema:
 *           type: string
 *         description: User ID to process appeal for
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - action
 *               - reasoning
 *             properties:
 *               action:
 *                 type: string
 *                 enum: [approve, deny]
 *               reasoning:
 *                 type: string
 *                 minLength: 10
 *                 maxLength: 2000
 *     responses:
 *       200:
 *         description: Appeal processed successfully
 *       400:
 *         description: Invalid action or reasoning
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Admin access required
 *       404:
 *         description: User or appeal not found
 *
 * @example
 * ```typescript
 * await fetch(`/api/admin/moderation/human-review/${userId}`, {
 *   method: 'POST',
 *   headers: { 'Authorization': `Bearer ${adminToken}` },
 *   body: JSON.stringify({
 *     action: 'approve',
 *     reasoning: 'Appeal approved after review'
 *   })
 * });
 * ```
 */

import {
  createNotification,
  requireAdmin,
  successResponse,
  withErrorHandling,
} from '@babylon/api';
import type { JsonValue } from '@babylon/db';
import { db } from '@babylon/db';
import { WalletService } from '@babylon/engine';
import { logger } from '@babylon/shared';
import type { NextRequest } from 'next/server';
import { z } from 'zod';

const HumanReviewActionSchema = z.object({
  action: z.enum(['approve', 'deny']),
  reasoning: z.string().min(10).max(2000),
});

export const POST = withErrorHandling(
  async (
    request: NextRequest,
    context: { params: Promise<{ userId: string }> }
  ) => {
    const adminUser = await requireAdmin(request);
    const { userId } = await context.params;

    const body = await request.json();
    const { action, reasoning } = HumanReviewActionSchema.parse(body);

    const user = await db.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        appealStatus: true,
        isBanned: true,
        appealStaked: true,
        appealStakeAmount: true,
        falsePositiveHistory: true,
      },
    });

    if (!user || user.appealStatus !== 'human_review') {
      return successResponse(
        { success: false, error: 'Appeal not in human review' },
        400
      );
    }

    if (action === 'approve') {
      // Mark as false positive and restore account
      const falsePositiveHistory =
        (user.falsePositiveHistory as Array<Record<string, unknown>> | null) ||
        [];
      falsePositiveHistory.push({
        date: new Date().toISOString(),
        reason: reasoning,
        reviewedBy: adminUser.userId,
        type: 'human_review',
      });

      await db.user.update({
        where: { id: userId },
        data: {
          isBanned: false,
          isScammer: false,
          isCSAM: false,
          bannedAt: null,
          bannedBy: null,
          bannedReason: null,
          appealStatus: 'approved',
          appealReviewedAt: new Date(),
          falsePositiveHistory: falsePositiveHistory as JsonValue,
        },
      });

      // Refund stake if staked
      if (user.appealStaked && user.appealStakeAmount) {
        await refundAppealStake(userId, Number(user.appealStakeAmount));
      }

      await createNotification({
        userId,
        type: 'system',
        title: 'Appeal Approved - Account Restored',
        message: `A moderator reviewed your appeal and restored your account. ${reasoning}`,
      });

      logger.info(
        'Human review approved',
        {
          userId,
          adminUserId: adminUser.userId,
          reasoning,
        },
        'HumanReview'
      );

      return successResponse({
        success: true,
        message: 'Appeal approved - account restored',
      });
    }
    // Deny - permanent ban
    await db.user.update({
      where: { id: userId },
      data: {
        appealStatus: 'denied',
        appealReviewedAt: new Date(),
        // Keep banned, scammer, CSAM flags
      },
    });

    await createNotification({
      userId,
      type: 'system',
      title: 'Appeal Denied - Permanent Ban',
      message: `After human review, your appeal was denied. ${reasoning}`,
    });

    logger.info(
      'Human review denied',
      {
        userId,
        adminUserId: adminUser.userId,
        reasoning,
      },
      'HumanReview'
    );

    return successResponse({
      success: true,
      message: 'Appeal denied - permanent ban confirmed',
    });
  }
);

/**
 * Refund appeal stake to user's virtual balance
 */
async function refundAppealStake(
  userId: string,
  stakeAmount: number
): Promise<void> {
  await WalletService.credit(
    userId,
    stakeAmount,
    'appeal_stake_refund',
    'Appeal stake refund - account restored via human review',
    undefined
  );

  // Clear stake flags
  await db.user.update({
    where: { id: userId },
    data: {
      appealStaked: false,
      appealStakeAmount: null,
      appealStakeTxHash: null,
    },
  });

  logger.info(
    'Appeal stake refunded',
    {
      userId,
      stakeAmount,
    },
    'HumanReview'
  );
}
