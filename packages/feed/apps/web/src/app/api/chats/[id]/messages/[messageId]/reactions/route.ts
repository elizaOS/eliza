/**
 * Chat Message Reactions API
 *
 * @route POST /api/chats/[id]/messages/[messageId]/reactions
 * @route DELETE /api/chats/[id]/messages/[messageId]/reactions?emoji=...
 */

import {
  AuthorizationError,
  authenticate,
  BusinessLogicError,
  broadcastChatMessageReaction,
  checkRateLimitAsync,
  NotFoundError,
  RATE_LIMIT_CONFIGS,
  rateLimitError,
  successResponse,
  withErrorHandling,
} from '@babylon/api';
import { requireNftChatAccess } from '@babylon/api/services/nft-chat-gating-service';
import {
  and,
  asSystem,
  asUser,
  chatParticipants,
  chats,
  count,
  eq,
  messageReactions,
  messages,
} from '@babylon/db';
import {
  ALLOWED_REACTION_EMOJI_SET,
  ChatMessageReactionCreateSchema,
  generateSnowflakeId,
} from '@babylon/shared';
import type { NextRequest } from 'next/server';

async function requireChatAccess(
  user: Awaited<ReturnType<typeof authenticate>>,
  chatId: string
) {
  const [chat] = await asSystem(async (db) => {
    return await db.select().from(chats).where(eq(chats.id, chatId)).limit(1);
  }, 'get-chat-for-reaction');
  if (!chat) throw new NotFoundError('Chat', chatId);

  const [isMember] = await asUser(user, async (db) => {
    return await db
      .select()
      .from(chatParticipants)
      .where(
        and(
          eq(chatParticipants.chatId, chatId),
          eq(chatParticipants.userId, user.userId)
        )
      )
      .limit(1);
  });
  if (!isMember) {
    throw new AuthorizationError(
      'You do not have access to this chat',
      'chat',
      'read'
    );
  }

  await requireNftChatAccess(user, chatId);
}

async function requireMessageInChat(chatId: string, messageId: string) {
  const [msg] = await asSystem(async (db) => {
    return await db
      .select({ id: messages.id })
      .from(messages)
      .where(and(eq(messages.id, messageId), eq(messages.chatId, chatId)))
      .limit(1);
  }, 'get-message-for-reaction');
  if (!msg) throw new NotFoundError('Message', messageId);
}

async function getReactionSummary(messageId: string, currentUserId: string) {
  const [countsByEmoji, myEmojis] = await Promise.all([
    asSystem(async (db) => {
      return await db
        .select({
          emoji: messageReactions.emoji,
          count: count(),
        })
        .from(messageReactions)
        .where(eq(messageReactions.messageId, messageId))
        .groupBy(messageReactions.emoji);
    }, 'get-message-reaction-counts'),
    asSystem(async (db) => {
      return await db
        .select({ emoji: messageReactions.emoji })
        .from(messageReactions)
        .where(
          and(
            eq(messageReactions.messageId, messageId),
            eq(messageReactions.userId, currentUserId)
          )
        );
    }, 'get-message-reaction-mine'),
  ]);

  const myEmojiSet = new Set(myEmojis.map((r) => r.emoji));
  return countsByEmoji
    .map((r) => ({
      emoji: r.emoji,
      count: Number(r.count ?? 0),
      reactedByMe: myEmojiSet.has(r.emoji),
    }))
    .filter((r) => r.count > 0);
}

export const POST = withErrorHandling(
  async (
    request: NextRequest,
    context: { params: Promise<{ id: string; messageId: string }> }
  ) => {
    const user = await authenticate(request);

    // Rate-limit reaction toggles (30 per minute per user)
    const rl = await checkRateLimitAsync(
      user.userId,
      RATE_LIMIT_CONFIGS.REACTION_TOGGLE
    );
    if (!rl.allowed) return rateLimitError(rl.retryAfter);

    const { id: chatId, messageId } = await context.params;

    const body = await request.json();
    const { emoji } = ChatMessageReactionCreateSchema.parse(body);

    if (!ALLOWED_REACTION_EMOJI_SET.has(emoji)) {
      throw new BusinessLogicError(
        'Unsupported reaction emoji',
        'UNSUPPORTED_REACTION_EMOJI'
      );
    }

    await requireChatAccess(user, chatId);
    await requireMessageInChat(chatId, messageId);

    const [existing] = await asSystem(async (db) => {
      return await db
        .select({ id: messageReactions.id })
        .from(messageReactions)
        .where(
          and(
            eq(messageReactions.messageId, messageId),
            eq(messageReactions.userId, user.userId),
            eq(messageReactions.emoji, emoji)
          )
        )
        .limit(1);
    }, 'check-existing-message-reaction');

    if (!existing) {
      await asUser(user, async (db) => {
        await db.insert(messageReactions).values({
          id: await generateSnowflakeId(),
          chatId,
          messageId,
          userId: user.userId,
          emoji,
        });
      });

      await broadcastChatMessageReaction(chatId, {
        messageId,
        chatId,
        emoji,
        userId: user.userId,
        action: 'added',
      });
    }

    const reactions = await getReactionSummary(messageId, user.userId);
    return successResponse({ messageId, reactions });
  }
);

export const DELETE = withErrorHandling(
  async (
    request: NextRequest,
    context: { params: Promise<{ id: string; messageId: string }> }
  ) => {
    const user = await authenticate(request);

    // Rate-limit reaction toggles (30 per minute per user)
    const rl = await checkRateLimitAsync(
      user.userId,
      RATE_LIMIT_CONFIGS.REACTION_TOGGLE
    );
    if (!rl.allowed) return rateLimitError(rl.retryAfter);

    const { id: chatId, messageId } = await context.params;

    const { searchParams } = new URL(request.url);
    const emoji = searchParams.get('emoji');
    if (!emoji) {
      throw new BusinessLogicError('emoji is required', 'EMOJI_REQUIRED');
    }
    if (!ALLOWED_REACTION_EMOJI_SET.has(emoji)) {
      throw new BusinessLogicError(
        'Unsupported reaction emoji',
        'UNSUPPORTED_REACTION_EMOJI'
      );
    }

    await requireChatAccess(user, chatId);
    await requireMessageInChat(chatId, messageId);

    const [existing] = await asSystem(async (db) => {
      return await db
        .select({ id: messageReactions.id })
        .from(messageReactions)
        .where(
          and(
            eq(messageReactions.messageId, messageId),
            eq(messageReactions.userId, user.userId),
            eq(messageReactions.emoji, emoji)
          )
        )
        .limit(1);
    }, 'check-existing-message-reaction-delete');

    if (existing) {
      await asUser(user, async (db) => {
        await db
          .delete(messageReactions)
          .where(eq(messageReactions.id, existing.id));
      });

      await broadcastChatMessageReaction(chatId, {
        messageId,
        chatId,
        emoji,
        userId: user.userId,
        action: 'removed',
      });
    }

    const reactions = await getReactionSummary(messageId, user.userId);
    return successResponse({ messageId, reactions });
  }
);
