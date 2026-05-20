/**
 * Coordinator Recent Messages Provider
 *
 * Provides conversation history for the coordinator.
 * Only shows messages that target the coordinator (no @mentions)
 * and coordinator's own responses.
 */

import {
  and,
  db,
  desc,
  eq,
  messages as messagesTable,
  or,
  sql,
} from '@feed/db';
import { COORDINATOR_SENDER_ID } from '@feed/shared';
import type {
  IAgentRuntime,
  Memory,
  Provider,
  ProviderResult,
  State,
} from '@elizaos/core';

/**
 * Format timestamp to relative time string
 */
function formatRelativeTime(date: Date): string {
  const now = Date.now();
  const diffMs = now - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  return `${diffDays}d ago`;
}

/**
 * Format time as HH:MM
 */
function formatTime(date: Date): string {
  const hours = date.getHours().toString().padStart(2, '0');
  const minutes = date.getMinutes().toString().padStart(2, '0');
  return `${hours}:${minutes}`;
}

/**
 * Coordinator Recent Messages Provider
 *
 * Fetches messages between the user and coordinator in team chat.
 * Only includes:
 * - User messages that target the coordinator (targetIds contains 'coordinator')
 * - Coordinator's own responses (senderId = 'coordinator')
 */
export const coordinatorRecentMessagesProvider: Provider = {
  name: 'RECENT_MESSAGES',
  description: 'Recent conversation history with the user',

  get: async (
    _runtime: IAgentRuntime,
    _message: Memory,
    state: State
  ): Promise<ProviderResult> => {
    const teamChatId = state?.values?.teamChatId as string | undefined;
    const ownerId = state?.values?.ownerId as string | undefined;

    if (!teamChatId || !ownerId) {
      return {
        data: { recentMessages: [], messageCount: 0 },
        values: {
          recentMessages: 'No team chat context available.',
          messageCount: 0,
          hasHistory: false,
        },
        text: 'No team chat context available.',
      };
    }

    // Query messages relevant to coordinator:
    // 1. User messages that target coordinator (targetIds contains 'coordinator')
    // 2. Coordinator's own responses (senderId = 'coordinator')
    // Fail-fast: let DB errors propagate to caller
    const recentMsgs = await db
      .select()
      .from(messagesTable)
      .where(
        and(
          eq(messagesTable.chatId, teamChatId),
          or(
            // Coordinator's own messages
            eq(messagesTable.senderId, COORDINATOR_SENDER_ID),
            // User messages targeting coordinator (use @> for GIN index efficiency)
            and(
              eq(messagesTable.senderId, ownerId),
              sql`${messagesTable.targetIds} @> ARRAY[${COORDINATOR_SENDER_ID}]`
            )
          )
        )
      )
      .orderBy(desc(messagesTable.createdAt))
      .limit(15);

    if (recentMsgs.length === 0) {
      return {
        data: { recentMessages: [], messageCount: 0 },
        values: {
          recentMessages: 'No previous conversation history with this user.',
          messageCount: 0,
          hasHistory: false,
        },
        text: 'No previous conversation history with this user.',
      };
    }

    // Format messages (oldest first for conversation flow)
    // Use a shallow copy to avoid mutating recentMsgs (which stays newest-first)
    const formattedMessages = [...recentMsgs]
      .reverse()
      .map((msg) => {
        const speaker = msg.senderId === ownerId ? 'User' : 'You';
        const time = formatTime(msg.createdAt);
        const relativeTime = formatRelativeTime(msg.createdAt);
        return `${time} (${relativeTime}) ${speaker}: ${msg.content}`;
      })
      .join('\n');

    return {
      data: {
        recentMessages: recentMsgs,
        messageCount: recentMsgs.length,
      },
      values: {
        recentMessages: formattedMessages,
        messageCount: recentMsgs.length,
        hasHistory: true,
      },
      text: formattedMessages,
    };
  },
};
