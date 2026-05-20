/**
 * Chat Unread Count API
 *
 * @route GET /api/chats/unread-count - Get unread message counts
 * @access Authenticated
 *
 * @description
 * Lightweight endpoint for polling unread message counts. Returns pending DM
 * requests and new message indicators. Optimized for frequent polling.
 *
 * @openapi
 * /api/chats/unread-count:
 *   get:
 *     tags:
 *       - Chats
 *     summary: Get unread message counts
 *     description: Returns counts of pending DMs and unread messages (lightweight polling endpoint)
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: Counts retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 pendingDMs:
 *                   type: integer
 *                   description: Combined DM/chat badge count for backwards compatibility
 *                 pendingDMRequests:
 *                   type: integer
 *                   description: Number of pending DM requests
 *                 unreadMessages:
 *                   type: integer
 *                   description: Number of unread chat notifications
 *                 hasNewMessages:
 *                   type: boolean
 *                   description: Whether there are unread chat notifications
 *       401:
 *         description: Unauthorized
 *
 * @example
 * ```typescript
 * // Poll for unread counts
 * const response = await fetch('/api/chats/unread-count', {
 *   headers: { 'Authorization': `Bearer ${token}` }
 * });
 * const { pendingDMs, hasNewMessages } = await response.json();
 * ```
 *
 * @see {@link /lib/db/context} RLS context
 */

import { authenticate, successResponse, withErrorHandling } from '@babylon/api';
import { asUser } from '@babylon/db';
import type { NextRequest } from 'next/server';

/**
 * GET /api/chats/unread-count
 * Get counts of pending DMs and unread messages
 *
 * Returns:
 * - pendingDMs: Combined chat badge count (legacy field)
 * - pendingDMRequests: Number of DM requests from anons awaiting acceptance
 * - unreadMessages: Number of unread chat notifications
 * - hasNewMessages: Boolean indicating if there are any unread chat notifications
 */
export const GET = withErrorHandling(async (request: NextRequest) => {
  const user = await authenticate(request);

  const counts = await asUser(user, async (db) => {
    const pendingDMCount = await db.dmAcceptance.count({
      where: {
        userId: user.userId,
        status: 'pending',
      },
    });

    const unreadMessageCount = await db.notification.count({
      where: {
        userId: user.userId,
        read: false,
        chatId: {
          not: null,
        },
      },
    });

    return {
      pendingDMs: pendingDMCount + unreadMessageCount,
      pendingDMRequests: pendingDMCount,
      unreadMessages: unreadMessageCount,
      hasNewMessages: unreadMessageCount > 0,
    };
  });

  return successResponse(counts);
});
