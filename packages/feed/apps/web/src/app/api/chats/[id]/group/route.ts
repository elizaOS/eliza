/**
 * Chat Group ID API
 *
 * @route GET /api/chats/[id]/group - Get group ID for chat
 * @access Authenticated (participants only)
 *
 * @description
 * Returns the user group ID associated with a group chat. Only works for
 * group chats (not DMs). Requires user to be a participant.
 *
 * @openapi
 * /api/chats/{id}/group:
 *   get:
 *     tags:
 *       - Chats
 *     summary: Get group ID for chat
 *     description: Returns user group ID associated with group chat (participants only)
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Chat ID
 *     responses:
 *       200:
 *         description: Group ID retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 groupId:
 *                   type: string
 *       400:
 *         description: Chat is not a group chat
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Not a participant
 *       404:
 *         description: Chat not found
 *
 * @example
 * ```typescript
 * const { groupId } = await fetch(`/api/chats/${chatId}/group`, {
 *   headers: { 'Authorization': `Bearer ${token}` }
 * }).then(r => r.json());
 * ```
 */

import {
  ApiError,
  authenticate,
  successResponse,
  withErrorHandling,
} from '@feed/api';
import { and, asUser, chatParticipants, chats, eq } from '@feed/db';
import { logger } from '@feed/shared';
import type { NextRequest } from 'next/server';

/**
 * GET /api/chats/[id]/group
 * Get the group ID associated with a chat
 */
export const GET = withErrorHandling(
  async (
    request: NextRequest,
    { params }: { params: Promise<{ id: string }> }
  ) => {
    const user = await authenticate(request);
    const { id: chatId } = await params;

    const groupId = await asUser(user, async (dbClient) => {
      // Check if user is a participant in the chat
      const [participant] = await dbClient
        .select()
        .from(chatParticipants)
        .where(
          and(
            eq(chatParticipants.chatId, chatId),
            eq(chatParticipants.userId, user.userId)
          )
        )
        .limit(1);

      if (!participant) {
        throw new ApiError('You are not a participant in this chat', 403);
      }

      // Get the chat and its groupId
      const [chat] = await dbClient
        .select({ groupId: chats.groupId, isGroup: chats.isGroup })
        .from(chats)
        .where(eq(chats.id, chatId))
        .limit(1);

      if (!chat) {
        throw new ApiError('Chat not found', 404);
      }

      if (!chat.isGroup || !chat.groupId) {
        throw new ApiError('This chat is not associated with a group', 400);
      }

      return chat.groupId;
    });

    logger.info(
      'Group ID retrieved from chat',
      { userId: user.userId, chatId, groupId },
      'GET /api/chats/:id/group'
    );

    return successResponse({ groupId });
  }
);
