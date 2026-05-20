/**
 * Chat Leave API
 *
 * @route DELETE /api/chats/[id]/participants/me - Leave chat
 * @access Authenticated
 */

import {
  authenticate,
  errorResponse,
  successResponse,
  withErrorHandling,
} from '@babylon/api';
import { asUser } from '@babylon/db';
import { logger } from '@babylon/shared';
import type { NextRequest } from 'next/server';

export const DELETE = withErrorHandling(
  async (
    request: NextRequest,
    context: { params: Promise<{ id: string }> }
  ) => {
    const { id: chatId } = await context.params;
    const user = await authenticate(request);

    await asUser(user, async (db) => {
      // First, check if the user is actually a participant (compound key lookup)
      const participant = await db.chatParticipant.findFirst({
        where: {
          chatId,
          userId: user.userId,
        },
      });

      if (!participant) {
        throw errorResponse(
          'You are not a member of this chat.',
          'NOT_FOUND',
          404
        );
      }

      // Find the chat to get its groupId (Chat.groupId → Group.id)
      const chat = await db.chat.findUnique({
        where: { id: chatId },
        select: { groupId: true },
      });

      // If there's a group associated, mark membership as inactive
      if (chat?.groupId) {
        const membership = await db.groupMember.findFirst({
          where: {
            groupId: chat.groupId,
            userId: user.userId,
            isActive: true,
          },
        });

        if (membership) {
          // Cannot leave if you're the owner
          if (membership.role === 'owner') {
            throw errorResponse(
              'Group owners cannot leave. Transfer ownership or delete the group.',
              'FORBIDDEN',
              403
            );
          }

          await db.groupMember.update({
            where: { id: membership.id },
            data: {
              isActive: false,
              kickedAt: new Date(),
              kickReason: 'User left',
            },
          });
        }
      }

      // For all chats (NPC or user-created), we remove the participant record
      await db.chatParticipant.delete({
        where: {
          id: participant.id,
        },
      });
    });

    logger.info(
      'User left chat successfully',
      { chatId, userId: user.userId },
      'DELETE /api/chats/[id]/participants/me'
    );

    return successResponse({ message: 'You have left the chat.' }, 200);
  }
);
