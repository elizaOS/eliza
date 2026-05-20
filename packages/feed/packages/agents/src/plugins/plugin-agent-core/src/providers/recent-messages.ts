/**
 * Recent Messages Provider
 *
 * Provides conversation history from Feed's database.
 *
 * In team chat mode: Queries the `messages` table filtered to only
 * messages that target this specific agent (via targetIds) and the agent's responses.
 *
 * In regular DM mode: Queries the `agentMessages` table (legacy behavior).
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
 * Recent Messages Provider
 *
 * Fetches recent chat messages and formats them for LLM context.
 *
 * In team chat mode: Filters messages to only show conversation
 * between the owner and this agent (not other agents' messages).
 */
export const recentMessagesProvider: Provider = {
  name: 'RECENT_MESSAGES',
  description: 'Recent conversation history with the user',

  get: async (
    runtime: IAgentRuntime,
    _message: Memory,
    state: State
  ): Promise<ProviderResult> => {
    const agentUserId = runtime.agentId;

    // Check if we're in team chat mode
    const teamChatId = state?.values?.teamChatId as string | undefined;
    const ownerId = state?.values?.ownerId as string | undefined;
    const isTeamChatMode = !!teamChatId && !!ownerId;

    let formattedMessages: string;
    let messageCount: number;
    // DrizzleMessageRow shape from messages table; AgentMessage from Prisma
    type DrizzleMessageRow = typeof messagesTable.$inferSelect;
    type AgentMessage = { role: string; content: string; createdAt: Date };
    let rawMessages: Array<DrizzleMessageRow | AgentMessage>;

    if (isTeamChatMode) {
      // Team chat mode: Query messages that target this agent
      // 1. User messages where targetIds contains this agent's ID
      // 2. This agent's own responses
      const recentMsgs = await db
        .select()
        .from(messagesTable)
        .where(
          and(
            eq(messagesTable.chatId, teamChatId),
            or(
              // Agent's own messages
              eq(messagesTable.senderId, agentUserId),
              // User messages targeting this agent (use @> for GIN index efficiency)
              and(
                eq(messagesTable.senderId, ownerId),
                sql`${messagesTable.targetIds} @> ARRAY[${agentUserId}]`
              )
            )
          )
        )
        .orderBy(desc(messagesTable.createdAt))
        .limit(10);

      rawMessages = recentMsgs;
      messageCount = recentMsgs.length;

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
      // Use spread to create a copy before reversing to avoid mutating the original array
      formattedMessages = [...recentMsgs]
        .reverse()
        .map((msg) => {
          const speaker = msg.senderId === ownerId ? 'User' : 'You';
          const time = formatTime(msg.createdAt);
          const relativeTime = formatRelativeTime(msg.createdAt);
          return `${time} (${relativeTime}) ${speaker}: ${msg.content}`;
        })
        .join('\n');
    } else {
      // Legacy DM mode: Query agentMessages table
      const messages = await db.agentMessage.findMany({
        where: { agentUserId },
        orderBy: { createdAt: 'desc' },
        take: 10,
      });

      rawMessages = messages;
      messageCount = messages.length;

      if (messages.length === 0) {
        return {
          data: { recentMessages: [], messageCount: 0 },
          values: {
            recentMessages: 'No previous conversation history.',
            messageCount: 0,
            hasHistory: false,
          },
          text: 'No previous conversation history.',
        };
      }

      // Format messages (oldest first for conversation flow)
      // Use spread to create a copy before reversing to avoid mutating the original array
      formattedMessages = [...messages]
        .reverse()
        .map((msg) => {
          const speaker = msg.role === 'user' ? 'User' : 'Agent';
          const time = formatTime(msg.createdAt);
          const relativeTime = formatRelativeTime(msg.createdAt);
          return `${time} (${relativeTime}) ${speaker}: ${msg.content}`;
        })
        .join('\n');
    }

    return {
      data: {
        recentMessages: rawMessages,
        messageCount,
      },
      values: {
        recentMessages: formattedMessages,
        messageCount,
        hasHistory: true,
      },
      text: formattedMessages,
    };
  },
};
