/**
 * Admin User Ban API
 *
 * @route POST /api/admin/users/[userId]/ban - Ban or unban user
 * @access Admin
 *
 * @description
 * Bans or unbans a user with reason tracking, scammer/CSAM flags, and ERC-8004
 * reputation sync. Includes points distribution to reporters for CSAM/scammer cases.
 * Requires admin authentication.
 *
 * @openapi
 * /api/admin/users/{userId}/ban:
 *   post:
 *     tags:
 *       - Admin
 *     summary: Ban or unban user
 *     description: Bans or unbans a user with moderation flags and reputation sync (admin only)
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: userId
 *         required: true
 *         schema:
 *           type: string
 *         description: User ID to ban/unban
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
 *                 enum: [ban, unban]
 *               reason:
 *                 type: string
 *                 minLength: 1
 *                 maxLength: 500
 *                 description: Ban reason
 *               isScammer:
 *                 type: boolean
 *                 description: Mark as scammer
 *               isCSAM:
 *                 type: boolean
 *                 description: Mark as CSAM
 *     responses:
 *       200:
 *         description: Ban/unban action completed successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 user:
 *                   type: object
 *                 message:
 *                   type: string
 *       400:
 *         description: Invalid action or cannot ban admin/actor
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Admin access required
 *       404:
 *         description: User not found
 *
 * @example
 * ```typescript
 * await fetch(`/api/admin/users/${userId}/ban`, {
 *   method: 'POST',
 *   headers: { 'Authorization': `Bearer ${adminToken}` },
 *   body: JSON.stringify({
 *     action: 'ban',
 *     reason: 'Violation of terms',
 *     isScammer: true
 *   })
 * });
 * ```
 *
 * @see {@link /lib/api/admin-middleware} Admin middleware
 * @see {@link /lib/reputation/erc8004-sync} ERC-8004 sync
 */

import {
  BusinessLogicError,
  distributeReputationToReporters,
  getClientIp,
  logAdminAction,
  NotFoundError,
  requireAdmin,
  successResponse,
  withErrorHandling,
} from '@feed/api';
import { db } from '@feed/db';
import { logger } from '@feed/shared';
import type { NextRequest } from 'next/server';
import { z } from 'zod';

const BanUserSchema = z.object({
  action: z.enum(['ban', 'unban']),
  reason: z.string().min(1).max(500).optional(),
  isScammer: z.boolean().optional(),
  isCSAM: z.boolean().optional(),
});

export const POST = withErrorHandling(
  async (
    request: NextRequest,
    context: { params: Promise<{ userId: string }> }
  ) => {
    // Require admin authentication
    const adminUser = await requireAdmin(request);

    // Parse params
    const { userId } = await context.params;

    // Parse request body
    const body = await request.json();
    const { action, reason, isScammer, isCSAM } = BanUserSchema.parse(body);

    logger.info(
      `Admin ${action} user request`,
      {
        adminUserId: adminUser.userId,
        targetUserId: userId,
        action,
        reason,
      },
      'POST /api/admin/users/[userId]/ban'
    );

    // Get target user
    const targetUser = await db.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        username: true,
        displayName: true,
        isActor: true,
        isAdmin: true,
        isBanned: true,
      },
    });

    if (!targetUser) {
      throw new NotFoundError('User', userId);
    }

    // Prevent banning admins (unless you're banning yourself, which is allowed)
    if (targetUser.isAdmin && targetUser.id !== adminUser.userId) {
      throw new BusinessLogicError(
        'Cannot ban other admins',
        'CANNOT_BAN_ADMIN'
      );
    }

    // Prevent banning NPCs/actors
    if (targetUser.isActor) {
      throw new BusinessLogicError(
        'Cannot ban game actors',
        'CANNOT_BAN_ACTOR'
      );
    }

    // Update user ban status and flags
    const updatedUser = await db.user.update({
      where: { id: userId },
      data: {
        isBanned: action === 'ban',
        bannedAt: action === 'ban' ? new Date() : null,
        bannedReason: action === 'ban' ? reason : null,
        bannedBy: action === 'ban' ? adminUser.userId : null,
        isScammer: action === 'ban' ? (isScammer ?? false) : false,
        isCSAM: action === 'ban' ? (isCSAM ?? false) : false,
      },
      select: {
        id: true,
        username: true,
        displayName: true,
        isBanned: true,
        bannedAt: true,
        bannedReason: true,
        bannedBy: true,
        isScammer: true,
        isCSAM: true,
      },
    });

    if (action === 'ban') {
      // Distribute points to successful reporters if CSAM/scammer
      if ((isScammer ?? false) || (isCSAM ?? false)) {
        const reason = isCSAM ? 'csam' : 'scammer';
        await distributeReputationToReporters(userId, reason);
      }
    }

    logger.info(
      `User ${action} successful`,
      {
        adminUserId: adminUser.userId,
        targetUserId: userId,
        targetUsername: targetUser.username,
        action,
      },
      'POST /api/admin/users/[userId]/ban'
    );

    // Audit log the ban/unban action (persist to database)
    logAdminAction(action === 'ban' ? 'BAN' : 'UNBAN', {
      adminId: adminUser.userId,
      ipAddress: getClientIp(request.headers) ?? undefined,
      resourceType: 'user',
      resourceId: userId,
      previousValue: {
        isBanned: targetUser.isBanned,
      },
      newValue: {
        isBanned: action === 'ban',
        reason: reason ?? null,
        isScammer: isScammer ?? false,
        isCSAM: isCSAM ?? false,
      },
      metadata: {
        targetUsername: targetUser.username,
        action,
      },
    }).catch((err) => {
      logger.error(
        'Failed to persist audit log for ban action',
        { err, userId, action },
        'POST /api/admin/users/[userId]/ban'
      );
    });

    return successResponse({
      success: true,
      user: updatedUser,
      message:
        action === 'ban'
          ? 'User banned successfully'
          : 'User unbanned successfully',
    });
  }
);
