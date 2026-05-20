/**
 * Admin Debug DM API
 *
 * @route GET /api/admin/debug-dm - Debug user DM chats
 * @access Admin
 *
 * @description
 * Debug endpoint to check what DM chats exist for a user. Bypasses RLS for
 * admin debugging purposes. Returns all chats and messages for the user.
 *
 * @openapi
 * /api/admin/debug-dm:
 *   get:
 *     tags:
 *       - Admin
 *     summary: Debug user DM chats
 *     description: Returns all DM chats for a user (admin only, bypasses RLS)
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: query
 *         name: userId
 *         required: true
 *         schema:
 *           type: string
 *         description: User ID to debug
 *     responses:
 *       200:
 *         description: Debug info retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 user:
 *                   type: object
 *                 chats:
 *                   type: array
 *       400:
 *         description: userId parameter required
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Admin access required
 *
 * @example
 * ```typescript
 * const debug = await fetch('/api/admin/debug-dm?userId=user-id', {
 *   headers: { 'Authorization': `Bearer ${adminToken}` }
 * }).then(r => r.json());
 * ```
 */

import { requireAdmin, successResponse, withErrorHandling } from '@babylon/api';
import {
  asSystem,
  chatParticipants,
  chats,
  db,
  desc,
  inArray,
  messages,
} from '@babylon/db';
import { logger } from '@babylon/shared';
import type { NextRequest } from 'next/server';

export const GET = withErrorHandling(async (request: NextRequest) => {
  // Require admin authentication
  await requireAdmin(request);

  const { searchParams } = new URL(request.url);
  const userId = searchParams.get('userId');

  if (!userId) {
    return successResponse({
      error: 'userId parameter required',
    });
  }

  logger.info('Debug DM lookup', { userId }, 'GET /api/admin/debug-dm');

  // Get user info (try by ID, username, or privyId)
  let user = await db.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      privyId: true,
      username: true,
      displayName: true,
    },
  });

  if (!user) {
    // Try by username
    user = await db.user.findUnique({
      where: { username: userId },
      select: {
        id: true,
        privyId: true,
        username: true,
        displayName: true,
      },
    });
  }

  if (!user) {
    // Try by privyId
    user = await db.user.findUnique({
      where: { privyId: userId },
      select: {
        id: true,
        privyId: true,
        username: true,
        displayName: true,
      },
    });
  }

  // Use the resolved user ID
  const resolvedUserId = user?.id || user?.privyId || userId;

  // Get all ChatParticipant records for this user (bypass RLS)
  const participants = await db.chatParticipant.findMany({
    where: {
      userId: resolvedUserId,
    },
  });

  // Get details for each chat using Drizzle query builder
  const chatIds = participants.map((p) => p.chatId);

  const { chatsList, allParticipants, allMessages, messageCounts } =
    await asSystem(async (database) => {
      // Get chats
      const chatsList =
        chatIds.length > 0
          ? await database
              .select()
              .from(chats)
              .where(inArray(chats.id, chatIds))
          : [];

      // Get all participants for these chats
      const allParticipants =
        chatIds.length > 0
          ? await database
              .select()
              .from(chatParticipants)
              .where(inArray(chatParticipants.chatId, chatIds))
          : [];

      // Get recent messages for each chat (last 5)
      const allMessages =
        chatIds.length > 0
          ? await database
              .select()
              .from(messages)
              .where(inArray(messages.chatId, chatIds))
              .orderBy(desc(messages.createdAt))
          : [];

      // Get message counts for each chat
      const messageCounts = await Promise.all(
        chatIds.map((chatId) =>
          database.message.count({
            where: { chatId: { equals: chatId } },
          })
        )
      );

      return { chatsList, allParticipants, allMessages, messageCounts };
    }, 'admin-debug-dm');

  // Get all user IDs from participants
  const participantUserIds = [...new Set(allParticipants.map((p) => p.userId))];
  const participantUsers = await db.user.findMany({
    where: {
      id: { in: participantUserIds },
    },
    select: {
      id: true,
      username: true,
      displayName: true,
    },
  });

  const usersMap = new Map(participantUsers.map((u) => [u.id, u]));

  // Group participants and messages by chat
  const participantsByChat = new Map<string, typeof allParticipants>();
  allParticipants.forEach((p) => {
    const list = participantsByChat.get(p.chatId) || [];
    list.push(p);
    participantsByChat.set(p.chatId, list);
  });

  const messagesByChat = new Map<string, typeof allMessages>();
  allMessages.forEach((m) => {
    const list = messagesByChat.get(m.chatId) || [];
    if (list.length < 5) {
      list.push(m);
    }
    messagesByChat.set(m.chatId, list);
  });

  logger.info(
    'Debug DM results',
    {
      userId,
      participantsCount: participants.length,
      chatsCount: chatsList.length,
    },
    'GET /api/admin/debug-dm'
  );

  return successResponse({
    user,
    note: user
      ? `User database ID: ${user.id}, Privy ID: ${user.privyId}`
      : 'User not found',
    participantRecords: participants,
    chats: chatsList.map((chat, index) => ({
      id: chat.id,
      name: chat.name,
      isGroup: chat.isGroup,
      createdAt: chat.createdAt,
      updatedAt: chat.updatedAt,
      participants: (participantsByChat.get(chat.id) || []).map((p) => {
        const user = usersMap.get(p.userId);
        return {
          id: p.id,
          userId: p.userId,
          username: user?.username || null,
          displayName: user?.displayName || null,
        };
      }),
      totalMessageCount: messageCounts[index] || 0,
      loadedMessageCount: (messagesByChat.get(chat.id) || []).length,
      recentMessages: (messagesByChat.get(chat.id) || [])
        .slice(0, 3)
        .map((m) => ({
          id: m.id,
          content: m.content.substring(0, 50),
          senderId: m.senderId,
          createdAt: m.createdAt,
        })),
    })),
  });
});
