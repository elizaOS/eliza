/**
 * DM Service
 *
 * Helper functions for creating and managing direct message chats.
 * Used by agent trade notifications and other system DMs.
 */

import {
  aliasedTable,
  and,
  chatParticipants,
  chats,
  db,
  dmAcceptances,
  eq,
  messages,
  type Transaction,
  users,
} from '@feed/db';
import { generateSnowflakeId, logger } from '@feed/shared';

/**
 * Get or create a DM chat between two users.
 *
 * NOTE: This function should NOT be used for agent-owner communication.
 * Agents should communicate with their owners through the Agents (team chat).
 *
 * @param userA - First user ID
 * @param userB - Second user ID
 * @returns The chat ID
 * @throws Error if trying to create DM between agent and owner
 */
export async function getOrCreateDMChat(
  userA: string,
  userB: string
): Promise<string> {
  // Check if either user is an agent trying to DM their owner
  // Agents should use Agents chat instead
  const [userAInfo, userBInfo] = await Promise.all([
    db
      .select({ isAgent: users.isAgent, managedBy: users.managedBy })
      .from(users)
      .where(eq(users.id, userA))
      .limit(1),
    db
      .select({ isAgent: users.isAgent, managedBy: users.managedBy })
      .from(users)
      .where(eq(users.id, userB))
      .limit(1),
  ]);

  const userAData = userAInfo[0];
  const userBData = userBInfo[0];

  // Block agent-owner DMs (both directions)
  if (userAData?.isAgent && userAData?.managedBy === userB) {
    throw new Error(
      'Agent-owner DMs are not allowed - use Agents chat instead'
    );
  }
  if (userBData?.isAgent && userBData?.managedBy === userA) {
    throw new Error(
      'Agent-owner DMs are not allowed - use Agents chat instead'
    );
  }

  // Find existing DM chat using a single query with self-join
  const otherParticipants = aliasedTable(chatParticipants, 'cp2');

  const existingChat = await db
    .select({ chatId: chatParticipants.chatId })
    .from(chatParticipants)
    .innerJoin(chats, eq(chatParticipants.chatId, chats.id))
    .innerJoin(
      otherParticipants,
      eq(chatParticipants.chatId, otherParticipants.chatId)
    )
    .where(
      and(
        eq(chatParticipants.userId, userA),
        eq(chatParticipants.isActive, true),
        eq(chats.isGroup, false),
        eq(otherParticipants.userId, userB),
        eq(otherParticipants.isActive, true)
      )
    )
    .limit(1);

  if (existingChat.length > 0 && existingChat[0]) {
    return existingChat[0].chatId;
  }

  // Create new DM chat
  const chatId = await generateSnowflakeId();
  const now = new Date();

  try {
    await db.transaction(async (tx: Transaction) => {
      await tx.insert(chats).values({
        id: chatId,
        isGroup: false,
        createdAt: now,
        updatedAt: now,
      });

      // Add both participants
      await tx.insert(chatParticipants).values([
        {
          id: await generateSnowflakeId(),
          chatId,
          userId: userA,
          joinedAt: now,
          isActive: true,
        },
        {
          id: await generateSnowflakeId(),
          chatId,
          userId: userB,
          joinedAt: now,
          isActive: true,
        },
      ]);

      // Create DMAcceptance record with 'accepted' status
      // System DMs bypass the acceptance flow
      await tx.insert(dmAcceptances).values({
        id: await generateSnowflakeId(),
        chatId,
        userId: userB,
        otherUserId: userA,
        status: 'accepted',
        createdAt: now,
        acceptedAt: now,
      });
    });

    logger.info('Created new DM chat', { chatId, userA, userB }, 'DMService');

    return chatId;
  } catch (error) {
    // Handle race condition - if chat was created by another process
    // Use Postgres error code 23505 (unique_violation) for reliable detection
    const isUniqueViolation =
      error instanceof Error &&
      'code' in error &&
      (error as Error & { code?: string }).code === '23505';
    if (isUniqueViolation) {
      logger.warn(
        'Race condition detected, retrying chat lookup',
        { userA, userB },
        'DMService'
      );

      // Retry lookup
      const retryOtherParticipants = aliasedTable(
        chatParticipants,
        'cp2_retry'
      );
      const retryMatch = await db
        .select({ chatId: chatParticipants.chatId })
        .from(chatParticipants)
        .innerJoin(chats, eq(chatParticipants.chatId, chats.id))
        .innerJoin(
          retryOtherParticipants,
          eq(chatParticipants.chatId, retryOtherParticipants.chatId)
        )
        .where(
          and(
            eq(chatParticipants.userId, userA),
            eq(chatParticipants.isActive, true),
            eq(chats.isGroup, false),
            eq(retryOtherParticipants.userId, userB),
            eq(retryOtherParticipants.isActive, true)
          )
        )
        .limit(1);

      if (retryMatch.length > 0 && retryMatch[0]) {
        return retryMatch[0].chatId;
      }
    }
    throw error;
  }
}

/**
 * Send a message to a chat.
 *
 * @param chatId - The chat ID
 * @param senderId - The sender's user ID
 * @param content - The message content
 * @returns The message ID
 */
export async function sendMessageToChat(
  chatId: string,
  senderId: string,
  content: string
): Promise<string> {
  const messageId = await generateSnowflakeId();
  const now = new Date();

  await db.insert(messages).values({
    id: messageId,
    chatId,
    senderId,
    content,
    createdAt: now,
  });

  logger.debug(
    'Sent message to chat',
    { messageId, chatId, senderId },
    'DMService'
  );

  return messageId;
}
