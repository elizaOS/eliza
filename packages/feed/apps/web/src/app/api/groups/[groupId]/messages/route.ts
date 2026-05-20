/**
 * Group Messages API
 *
 * @route GET /api/groups/[groupId]/messages - List group chat messages
 * @access Authenticated members only
 */

import {
  ApiError,
  authenticate,
  successResponse,
  withErrorHandling,
} from '@babylon/api';
import { asUser } from '@babylon/db';
import { StaticDataRegistry } from '@babylon/engine';
import { logger } from '@babylon/shared';
import type { NextRequest } from 'next/server';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

export const GET = withErrorHandling(
  async (
    request: NextRequest,
    { params }: { params: Promise<{ groupId: string }> }
  ) => {
    const user = await authenticate(request);
    const { groupId } = await params;
    const { searchParams } = new URL(request.url);
    const cursor = searchParams.get('cursor');
    const limit = Math.min(
      MAX_LIMIT,
      Math.max(
        1,
        Number.parseInt(searchParams.get('limit') ?? String(DEFAULT_LIMIT), 10)
      )
    );

    const result = await asUser(user, async (db) => {
      const group = await db.group.findUnique({
        where: { id: groupId },
        select: { id: true, name: true },
      });

      if (!group) {
        throw new ApiError('Group not found', 404);
      }

      const membership = await db.groupMember.findFirst({
        where: {
          groupId,
          userId: user.userId,
          isActive: true,
        },
      });

      if (!membership) {
        throw new ApiError('You are not a member of this group', 403);
      }

      const groupChat = await db.chat.findFirst({
        where: { groupId },
        select: { id: true, name: true },
      });

      if (!groupChat) {
        throw new ApiError('Group chat not found', 404);
      }

      const cursorMessage = cursor
        ? await db.message.findUnique({
            where: { id: cursor },
            select: { createdAt: true },
          })
        : null;

      const messages = await db.message.findMany({
        where: {
          chatId: groupChat.id,
          ...(cursorMessage
            ? {
                createdAt: {
                  lt: cursorMessage.createdAt,
                },
              }
            : {}),
        },
        orderBy: {
          createdAt: 'desc',
        },
        take: limit + 1,
        select: {
          id: true,
          content: true,
          createdAt: true,
          senderId: true,
          type: true,
        },
      });

      const hasMore = messages.length > limit;
      const visibleMessages = hasMore ? messages.slice(0, limit) : messages;

      const senderIds = Array.from(
        new Set(
          visibleMessages
            .map((message) => message.senderId)
            .filter((senderId) => senderId !== 'system')
        )
      );

      const senderUsers =
        senderIds.length > 0
          ? await db.user.findMany({
              where: {
                id: { in: senderIds },
              },
              select: {
                id: true,
                displayName: true,
                username: true,
                profileImageUrl: true,
                isActor: true,
              },
            })
          : [];
      const senderUserMap = new Map(
        senderUsers.map((senderUser) => [senderUser.id, senderUser])
      );

      return {
        groupId,
        groupName: group.name,
        chatId: groupChat.id,
        messages: visibleMessages.map((message) => {
          if (message.senderId === 'system') {
            return {
              id: message.id,
              content: message.content,
              createdAt: message.createdAt,
              type: message.type,
              sender: {
                id: 'system',
                name: 'System',
                username: null,
                profileImageUrl: null,
                isNPC: false,
              },
            };
          }

          const senderUser = senderUserMap.get(message.senderId);
          const actor = StaticDataRegistry.getActor(message.senderId);

          return {
            id: message.id,
            content: message.content,
            createdAt: message.createdAt,
            type: message.type,
            sender: {
              id: message.senderId,
              name:
                senderUser?.displayName ||
                senderUser?.username ||
                actor?.name ||
                'Unknown',
              username: senderUser?.username ?? null,
              profileImageUrl:
                senderUser?.profileImageUrl || actor?.profileImageUrl || null,
              isNPC: actor !== null || senderUser?.isActor === true,
            },
          };
        }),
        pagination: {
          limit,
          hasMore,
          nextCursor: hasMore
            ? (visibleMessages[visibleMessages.length - 1]?.id ?? null)
            : null,
        },
      };
    });

    logger.info(
      'Group messages retrieved',
      {
        userId: user.userId,
        groupId,
        count: result.messages.length,
        limit,
        hasCursor: !!cursor,
      },
      'GET /api/groups/:groupId/messages'
    );

    return successResponse(result);
  }
);
