/**
 * Messaging Actions
 * Actions for sending messages and managing chats.
 *
 * Supports three resolution strategies for SEND_MESSAGE:
 * 1. Explicit chat ID: "send message to chat 12345: hello"
 * 2. Group name:       "send message to 'Price Alerts': hello"
 * 3. Recipient @user:  "DM @username: hello"
 *
 * Falls back through strategies in order until one resolves.
 */

import type {
  Action,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from '@elizaos/core';
import { executeDirectMessage } from '../../../autonomous/DirectExecutors';
import {
  resolveGroupChatByName,
  resolveUserByUsername,
} from '../../../autonomous/utils/context-gatherers';
import { logger } from '../../../shared/logger';
import type { BabylonRuntime } from '../types';

// =============================================================================
// Parsing helpers
// =============================================================================

/**
 * Extract a chat ID from text.
 * Matches patterns like: "chat 12345", "chat:12345", "chat-12345", "chatId: 12345"
 *
 * Guards against false positives from compound names like "General Chat:"
 * by checking that "chat" is not preceded by a capitalized word (name component).
 */
function parseChatId(text: string): string | null {
  const match = text.match(/\bchat(?:\s*id)?[:\s-]+([a-zA-Z0-9_-]{5,})/i);
  if (!match?.[1]) return null;
  // Reject if "chat" is preceded by a capitalized word (part of a name like "General Chat")
  const prefix = text.substring(
    Math.max(0, (match.index ?? 0) - 20),
    match.index ?? 0
  );
  if (/[A-Z][a-zA-Z]*\s*$/.test(prefix)) return null;
  return match[1];
}

/**
 * Extract a group/channel name enclosed in quotes from text.
 * Matches: "to 'Price Alerts'", 'to "My Group"', "group 'Alerts'"
 *
 * Also supports unquoted multi-word names terminated by a colon:
 *   "to General Chat: hello" → "General Chat"
 */
function parseGroupName(text: string): string | null {
  // Pattern 1: Quoted group name
  const quoted = text.match(/(?:to|group|channel|in)\s+["']([^"']+)["']/i);
  if (quoted?.[1]?.trim()) return quoted[1].trim();

  // Pattern 2: Unquoted group name — "to <Name>: <message>"
  // Captures one or more capitalized words before a colon
  const unquoted = text.match(
    /(?:to|group|channel|in)\s+((?:[A-Z][a-zA-Z]*\s*){1,5}):/i
  );
  if (unquoted?.[1]?.trim()) return unquoted[1].trim();

  return null;
}

/**
 * Extract a @username mention from text.
 * Matches: "DM @alice", "message @bob", "send to @charlie"
 */
function parseRecipientUsername(text: string): string | null {
  const match = text.match(/(?:dm|message|send\s+to|to)\s+@([a-zA-Z0-9_]+)/i);
  return match?.[1] ?? null;
}

/**
 * Extract the message body from the input text.
 * Tries multiple patterns to find the actual content to send.
 */
function parseMessageContent(text: string): string {
  // Pattern 1: Content after colon in quotes — 'chat 123: "hello there"'
  const quotedMatch = text.match(/:\s*["'](.+?)["']\s*$/);
  if (quotedMatch?.[1]) return quotedMatch[1];

  // Pattern 2: Content after colon — 'chat 123: hello there'
  const colonMatch = text.match(/:\s*["']?(.+?)["']?\s*$/);
  if (colonMatch?.[1]) return colonMatch[1];

  // Pattern 3: Content after "message" or "saying" keyword
  const keywordMatch = text.match(
    /(?:message|saying|with text)\s+["']?(.+?)["']?\s*$/i
  );
  if (keywordMatch?.[1]) return keywordMatch[1];

  // Fallback: return everything after the first recognizable target
  const afterTarget = text.replace(
    /^.*?(?:chat[:\s-]+\S+|["'][^"']+["']|@\w+)\s*/i,
    ''
  );
  return afterTarget.trim() || text;
}

// =============================================================================
// SEND_MESSAGE Action
// =============================================================================

/**
 * Action: Send Message
 * Allows agent to send a message via DM or to a group chat.
 *
 * Resolution order:
 * 1. Explicit chatId in text
 * 2. Group name lookup (agent must be a member)
 * 3. Recipient @username (creates DM if needed)
 * 4. A2A client fallback for pre-parsed chatId
 */
export const sendMessageAction: Action = {
  name: 'SEND_MESSAGE',
  description:
    'Send a message in a chat by chat ID, group name, or recipient @username',
  similes: ['send message', 'message', 'dm', 'send dm', 'chat', 'alert'],
  examples: [
    [
      {
        name: '{{user1}}',
        content: { text: 'Send message to chat chat-123: "Hello there!"' },
      },
      {
        name: '{{agent}}',
        content: { text: 'Sending message...', action: 'SEND_MESSAGE' },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: {
          text: "Send message to 'ScanMachine Price Alerts': OPENAGI dropped below 22.5",
        },
      },
      {
        name: '{{agent}}',
        content: {
          text: 'Sending to group...',
          action: 'SEND_MESSAGE',
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: { text: 'DM @alice: Hey, check out TSLAI!' },
      },
      {
        name: '{{agent}}',
        content: { text: 'Sending DM...', action: 'SEND_MESSAGE' },
      },
    ],
  ],

  validate: async (_runtime: IAgentRuntime, message: Memory) => {
    const content = message.content.text?.toLowerCase() || '';
    return (
      (content.includes('send') &&
        (content.includes('message') || content.includes('dm'))) ||
      (content.includes('dm') && content.includes('@')) ||
      (content.includes('alert') && content.includes('send'))
    );
  },

  handler: (async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
    _options?: unknown,
    callback?: HandlerCallback
  ): Promise<void> => {
    const babylonRuntime = runtime as BabylonRuntime;
    const content = _message.content.text || '';
    const agentUserId = babylonRuntime.a2aClient?.agentId;
    const messageBody = parseMessageContent(content);

    if (!messageBody || messageBody.length < 2) {
      callback?.({
        text: 'Could not parse message content. Please include the message you want to send.',
        action: 'SEND_MESSAGE',
      });
      return;
    }

    // Strategy 1: Explicit chat ID
    const chatId = parseChatId(content);
    if (chatId) {
      logger.info(
        `[SEND_MESSAGE] Resolved via chatId: ${chatId}`,
        undefined,
        'MessagingAction'
      );

      if (agentUserId) {
        const result = await executeDirectMessage({
          agentUserId,
          chatId,
          content: messageBody,
        });

        callback?.({
          text: result.success
            ? `Message sent to chat ${chatId}. Message ID: ${result.messageId}`
            : `Failed to send message: ${result.error}`,
          action: 'SEND_MESSAGE',
        });
        return;
      }

      // Fallback to A2A client if no agentUserId (should not happen in practice)
      if (babylonRuntime.a2aClient?.isConnected()) {
        const result = (await babylonRuntime.a2aClient.sendMessage(
          chatId,
          messageBody
        )) as { success?: boolean; messageId?: string; message?: string };

        callback?.({
          text:
            result.success === false
              ? `Failed to send message: ${result.message || 'Unknown error'}`
              : `Message sent! ID: ${result.messageId || 'unknown'}`,
          action: 'SEND_MESSAGE',
        });
        return;
      }
    }

    // Strategy 2: Group name resolution
    if (agentUserId) {
      const groupName = parseGroupName(content);
      if (groupName) {
        const resolvedChatId = await resolveGroupChatByName(
          agentUserId,
          groupName
        );
        if (resolvedChatId) {
          logger.info(
            `[SEND_MESSAGE] Resolved group "${groupName}" to chat ${resolvedChatId}`,
            undefined,
            'MessagingAction'
          );

          const result = await executeDirectMessage({
            agentUserId,
            chatId: resolvedChatId,
            content: messageBody,
          });

          callback?.({
            text: result.success
              ? `Message sent to "${groupName}". Message ID: ${result.messageId}`
              : `Failed to send to "${groupName}": ${result.error}`,
            action: 'SEND_MESSAGE',
          });
          return;
        }

        // Group not found — report clearly
        callback?.({
          text: `Could not find a group chat named "${groupName}" that you are a member of.`,
          action: 'SEND_MESSAGE',
        });
        return;
      }

      // Strategy 3: Recipient @username
      // resolveUserByUsername only resolves the ID — authorization (owner-DM block,
      // recipient existence) is enforced downstream in executeDirectMessage.
      const username = parseRecipientUsername(content);
      if (username) {
        const recipientId = await resolveUserByUsername(username);
        if (recipientId) {
          logger.info(
            `[SEND_MESSAGE] Resolved @${username} to user ${recipientId}`,
            undefined,
            'MessagingAction'
          );

          const result = await executeDirectMessage({
            agentUserId,
            recipientId,
            content: messageBody,
          });

          callback?.({
            text: result.success
              ? `DM sent to @${username}. Message ID: ${result.messageId}`
              : `Failed to DM @${username}: ${result.error}`,
            action: 'SEND_MESSAGE',
          });
          return;
        }

        callback?.({
          text: `Could not find user @${username}.`,
          action: 'SEND_MESSAGE',
        });
        return;
      }
    }

    // No resolution strategy matched
    callback?.({
      text: "Could not determine where to send the message. Specify a chat ID (chat 12345: ...), group name (to 'My Group': ...), or recipient (@username: ...).",
      action: 'SEND_MESSAGE',
    });
  }) as unknown as Action['handler'],
};

// =============================================================================
// CREATE_GROUP Action
// =============================================================================

/**
 * Action: Create Group Chat
 * Allows agent to create a new group chat
 */
export const createGroupAction: Action = {
  name: 'CREATE_GROUP',
  description: 'Create a new group chat',
  similes: ['create group', 'new group', 'start group chat'],
  examples: [
    [
      {
        name: '{{user1}}',
        content: {
          text: 'Create group "Market Analysts" with members user1, user2',
        },
      },
      {
        name: '{{agent}}',
        content: { text: 'Creating group chat...', action: 'CREATE_GROUP' },
      },
    ],
  ],

  validate: async (_runtime: IAgentRuntime, message: Memory) => {
    const content = message.content.text?.toLowerCase() || '';
    return content.includes('create') && content.includes('group');
  },

  handler: (async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: unknown,
    callback?: HandlerCallback
  ): Promise<void> => {
    const babylonRuntime = runtime as BabylonRuntime;

    if (!babylonRuntime.a2aClient?.isConnected()) {
      callback?.({
        text: 'A2A client not connected. Cannot create group.',
        action: 'CREATE_GROUP',
      });
      return;
    }

    const content = message.content.text || '';
    const nameMatch =
      content.match(/(?:group|named?)\s+["'](.+?)["']/) ||
      content.match(/group\s+([A-Za-z0-9\s]+)(?:\s+with)?/);
    const membersMatch = content.match(/(?:with|members?)\s+(.+)$/);

    if (!nameMatch) {
      callback?.({
        text: 'Could not parse group name. Please specify a name for the group.',
        action: 'CREATE_GROUP',
      });
      return;
    }

    const groupName = nameMatch[1]?.trim() || 'Unnamed Group';
    const memberIds: string[] = [];
    if (membersMatch) {
      const memberStr = membersMatch[1];
      if (memberStr) {
        const matches = memberStr.match(/[a-zA-Z0-9-]+/g);
        if (matches) memberIds.push(...matches);
      }
    }

    const result = (await babylonRuntime.a2aClient.createGroup(
      groupName,
      memberIds
    )) as { success?: boolean; chatId?: string; message?: string };

    if (callback) {
      if (result.success === false) {
        callback({
          text: `Failed to create group: ${result.message || 'Unknown error'}`,
          action: 'CREATE_GROUP',
        });
      } else {
        callback({
          text: `Successfully created group "${groupName}"! Chat ID: ${result.chatId || 'unknown'}`,
          action: 'CREATE_GROUP',
        });
      }
    }
  }) as unknown as Action['handler'],
};
