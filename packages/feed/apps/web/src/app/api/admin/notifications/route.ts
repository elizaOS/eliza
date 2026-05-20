/**
 * Admin Notifications API
 *
 * @route POST /api/admin/notifications - Create notification
 * @access Admin
 *
 * @description
 * Creates and sends a notification to a specific user or all users.
 * Supports various notification types and optional links. Admin only.
 *
 * @openapi
 * /api/admin/notifications:
 *   post:
 *     tags:
 *       - Admin
 *     summary: Create notification
 *     description: Sends notification to user or all users (admin only)
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - message
 *             properties:
 *               userId:
 *                 type: string
 *                 description: Target user ID (optional, sends to all if omitted)
 *               message:
 *                 type: string
 *                 minLength: 1
 *                 maxLength: 500
 *               type:
 *                 type: string
 *                 enum: [system, comment, reaction, follow, mention, reply, share]
 *                 default: system
 *               postId:
 *                 type: string
 *               commentId:
 *                 type: string
 *               link:
 *                 type: string
 *               sendToAll:
 *                 type: boolean
 *                 default: false
 *     responses:
 *       200:
 *         description: Notification created successfully
 *       400:
 *         description: Invalid input
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Admin access required
 *       404:
 *         description: User not found (if userId specified)
 *
 * @example
 * ```typescript
 * await fetch('/api/admin/notifications', {
 *   method: 'POST',
 *   headers: { 'Authorization': `Bearer ${adminToken}` },
 *   body: JSON.stringify({
 *     message: 'System maintenance scheduled',
 *     type: 'system',
 *     sendToAll: true
 *   })
 * });
 * ```
 */

import {
  createNotification,
  NotFoundError,
  requireAdmin,
  successResponse,
  withErrorHandling,
} from '@babylon/api';
import { db } from '@babylon/db';
import { logger } from '@babylon/shared';
import type { NextRequest } from 'next/server';
import { z } from 'zod';

const CreateNotificationSchema = z.object({
  userId: z.string().optional(), // If not provided, send to all users
  message: z.string().min(1).max(500),
  type: z
    .enum([
      'system',
      'comment',
      'reaction',
      'follow',
      'mention',
      'reply',
      'share',
    ])
    .default('system'),
  postId: z.string().optional(),
  commentId: z.string().optional(),
  link: z.string().optional(), // Optional custom link
  sendToAll: z.boolean().default(false), // Send to all users
});

export const POST = withErrorHandling(async (request: NextRequest) => {
  // Require admin authentication
  const adminUser = await requireAdmin(request);

  // Parse request body
  const body = await request.json();
  const { userId, message, type, postId, commentId, sendToAll } =
    CreateNotificationSchema.parse(body);

  logger.info(
    'Admin creating notification',
    {
      adminUserId: adminUser.userId,
      targetUserId: userId,
      sendToAll,
      type,
    },
    'POST /api/admin/notifications'
  );

  if (sendToAll) {
    // Send notification to all users
    const users = await db.user.findMany({
      where: {
        isActor: false, // Don't send to NPCs/actors
        isBanned: false, // Don't send to banned users
      },
      select: {
        id: true,
      },
    });

    // Send notifications in batches to avoid overwhelming the database
    const batchSize = 50;
    for (let i = 0; i < users.length; i += batchSize) {
      const batch = users.slice(i, i + batchSize);
      await Promise.all(
        batch.map((user) =>
          createNotification({
            userId: user.id,
            type,
            message,
            title: 'Notification',
            postId,
            commentId,
          }).catch((error) => {
            logger.warn(
              'Failed to send notification to user',
              {
                error,
                userId: user.id,
              },
              'POST /api/admin/notifications'
            );
          })
        )
      );
    }

    logger.info(
      'Admin notification sent to all users',
      {
        adminUserId: adminUser.userId,
        userCount: users.length,
      },
      'POST /api/admin/notifications'
    );

    return successResponse({
      success: true,
      message: `Notification sent to ${users.length} users`,
      recipientCount: users.length,
    });
  }
  if (userId) {
    // Send notification to specific user
    const targetUser = await db.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        username: true,
        displayName: true,
        isActor: true,
      },
    });

    if (!targetUser) {
      throw new NotFoundError('User', userId);
    }

    if (targetUser.isActor) {
      return successResponse({
        success: false,
        message: 'Cannot send notifications to game actors/NPCs',
      });
    }

    await createNotification({
      userId: targetUser.id,
      type,
      message,
      title: 'Notification',
      postId,
      commentId,
    });

    logger.info(
      'Admin notification sent to user',
      {
        adminUserId: adminUser.userId,
        targetUserId: userId,
        targetUsername: targetUser.username,
      },
      'POST /api/admin/notifications'
    );

    return successResponse({
      success: true,
      message: `Notification sent to ${targetUser.displayName}`,
      recipient: {
        id: targetUser.id,
        username: targetUser.username,
        displayName: targetUser.displayName,
      },
    });
  }
  return successResponse({
    success: false,
    message: 'Please provide a userId or set sendToAll to true',
  });
});
