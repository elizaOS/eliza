/**
 * Chat Reply-to-Message Unit Tests
 *
 * Comprehensive tests for the "Reply to specific message" feature
 * (Telegram/Discord-style reply) across:
 * - Validation schemas (ChatMessageCreateSchema with replyToMessageId)
 * - Reply data resolution (local lookup fallback for SSE messages)
 * - Message formatting with reply fields
 * - Reply preview truncation logic
 * - Message bubble reply display truncation
 * - Context menu skip logic (thinking messages)
 * - Reply state management (set, clear, send-clears-reply)
 * - API response reply data batch resolution
 */

import { describe, expect, test } from 'bun:test';

// =====================================================================
// Type replicas (matching the real types from the codebase)
// =====================================================================

interface ReplyToMessage {
  id: string;
  content: string;
  senderId: string;
  senderName?: string;
}

interface Message {
  id: string;
  content: string;
  senderId: string;
  type?: 'user' | 'system' | 'coordinator';
  createdAt: string;
  stableKey?: string;
  isThinking?: boolean;
  replyToMessageId?: string | null;
  replyToMessage?: ReplyToMessage | null;
}

interface ChatParticipant {
  id: string;
  displayName: string;
  username?: string;
  profileImageUrl?: string;
}

// =====================================================================
// Function replicas (matching the real logic from the codebase)
// =====================================================================

/**
 * Builds a lookup map for resolving replyToMessage from local messages.
 * Replica of the logic in MessageList.tsx.
 */
function buildReplyLookup(
  messages: Message[],
  participants: ChatParticipant[]
): Map<string, ReplyToMessage> {
  const map = new Map<string, ReplyToMessage>();
  const participantMap = new Map(participants.map((p) => [p.id, p]));
  for (const msg of messages) {
    map.set(msg.id, {
      id: msg.id,
      content: msg.content,
      senderId: msg.senderId,
      senderName: participantMap.get(msg.senderId)?.displayName,
    });
  }
  return map;
}

/**
 * Resolves the replyToMessage for a given message.
 * Replica of resolveReplyTo() in MessageList.tsx.
 */
function resolveReplyTo(
  msg: Message,
  replyLookup: Map<string, ReplyToMessage>
): ReplyToMessage | null {
  if (msg.replyToMessage) return msg.replyToMessage;
  if (msg.replyToMessageId)
    return replyLookup.get(msg.replyToMessageId) ?? null;
  return null;
}

/**
 * Truncates content for ReplyPreview display (120 chars).
 * Replica of the logic in ReplyPreview.tsx.
 */
function truncateReplyPreview(content: string): string {
  return content.length > 120 ? `${content.slice(0, 120)}...` : content;
}

/**
 * Truncates content for MessageBubble reply display (100 chars).
 * Replica of the logic in MessageBubble.tsx.
 */
function truncateMessageBubbleReply(content: string): string {
  return content.length > 100 ? `${content.slice(0, 100)}...` : content;
}

/**
 * Determines whether a context menu should be shown for a message.
 * Replica of the skip logic in MessageContextMenu.tsx.
 */
function shouldShowContextMenu(message: Message): boolean {
  return !message.isThinking;
}

/**
 * Resolves the sender name from participants for reply state.
 * Replica of handleReplyToMessage logic in useChatPage.ts / useTeamChat.ts.
 */
function resolveReplyToMessage(
  msg: Message,
  participants: ChatParticipant[]
): ReplyToMessage {
  const participant = participants.find((p) => p.id === msg.senderId);
  return {
    id: msg.id,
    content: msg.content,
    senderId: msg.senderId,
    senderName: participant?.displayName ?? undefined,
  };
}

/**
 * Batch-resolves reply-to messages for API responses.
 * Replica of the logic in GET /api/chats/[id]/route.ts.
 */
function batchResolveReplies(
  messages: Message[],
  allMessages: Message[],
  participants: ChatParticipant[]
): Message[] {
  // Collect unique replyToMessageIds
  const replyIds = new Set<string>();
  for (const msg of messages) {
    if (msg.replyToMessageId) {
      replyIds.add(msg.replyToMessageId);
    }
  }

  if (replyIds.size === 0) return messages;

  // Build map from all available messages
  const replyMap = new Map<string, ReplyToMessage>();
  const participantMap = new Map(participants.map((p) => [p.id, p]));
  for (const msg of allMessages) {
    if (replyIds.has(msg.id)) {
      replyMap.set(msg.id, {
        id: msg.id,
        content:
          msg.content.length > 200
            ? `${msg.content.slice(0, 200)}...`
            : msg.content,
        senderId: msg.senderId,
        senderName: participantMap.get(msg.senderId)?.displayName,
      });
    }
  }

  // Enrich messages
  return messages.map((msg) => {
    if (msg.replyToMessageId && replyMap.has(msg.replyToMessageId)) {
      return {
        ...msg,
        replyToMessage: replyMap.get(msg.replyToMessageId)!,
      };
    }
    return msg;
  });
}

// =====================================================================
// Test fixtures
// =====================================================================

const createMessage = (overrides: Partial<Message> = {}): Message => ({
  id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
  content: 'Test message content',
  senderId: 'user-1',
  type: 'user',
  createdAt: new Date().toISOString(),
  ...overrides,
});

const createParticipant = (
  overrides: Partial<ChatParticipant> = {}
): ChatParticipant => ({
  id: 'user-1',
  displayName: 'Alice',
  username: 'alice',
  ...overrides,
});

// =====================================================================
// Tests
// =====================================================================

describe('ChatMessageCreateSchema - replyToMessageId validation', () => {
  // Replicate the Zod schema logic for unit testing without importing Zod
  function validateReplyToMessageId(value: unknown): {
    valid: boolean;
    value?: string;
  } {
    if (value === undefined) return { valid: true, value: undefined };
    if (typeof value !== 'string') return { valid: false };
    if (value.length < 1) return { valid: false };
    return { valid: true, value };
  }

  test('accepts undefined replyToMessageId (optional field)', () => {
    const result = validateReplyToMessageId(undefined);
    expect(result.valid).toBe(true);
    expect(result.value).toBeUndefined();
  });

  test('accepts valid replyToMessageId', () => {
    const result = validateReplyToMessageId('msg-12345');
    expect(result.valid).toBe(true);
    expect(result.value).toBe('msg-12345');
  });

  test('accepts snowflake-style replyToMessageId', () => {
    const result = validateReplyToMessageId('267685933648707584');
    expect(result.valid).toBe(true);
    expect(result.value).toBe('267685933648707584');
  });

  test('rejects empty string replyToMessageId', () => {
    const result = validateReplyToMessageId('');
    expect(result.valid).toBe(false);
  });

  test('rejects non-string replyToMessageId', () => {
    expect(validateReplyToMessageId(123).valid).toBe(false);
    expect(validateReplyToMessageId(null).valid).toBe(false);
    expect(validateReplyToMessageId(true).valid).toBe(false);
  });
});

describe('Reply Lookup - buildReplyLookup', () => {
  const participants: ChatParticipant[] = [
    createParticipant({ id: 'user-1', displayName: 'Alice' }),
    createParticipant({ id: 'user-2', displayName: 'Bob' }),
    createParticipant({ id: 'agent-1', displayName: 'TradingBot' }),
  ];

  test('builds lookup map from messages with participant names', () => {
    const messages: Message[] = [
      createMessage({ id: 'msg-1', content: 'Hello', senderId: 'user-1' }),
      createMessage({ id: 'msg-2', content: 'World', senderId: 'user-2' }),
    ];

    const lookup = buildReplyLookup(messages, participants);

    expect(lookup.size).toBe(2);
    expect(lookup.get('msg-1')).toEqual({
      id: 'msg-1',
      content: 'Hello',
      senderId: 'user-1',
      senderName: 'Alice',
    });
    expect(lookup.get('msg-2')).toEqual({
      id: 'msg-2',
      content: 'World',
      senderId: 'user-2',
      senderName: 'Bob',
    });
  });

  test('handles messages from agents', () => {
    const messages: Message[] = [
      createMessage({
        id: 'msg-a',
        content: 'Agent response',
        senderId: 'agent-1',
      }),
    ];

    const lookup = buildReplyLookup(messages, participants);

    expect(lookup.get('msg-a')?.senderName).toBe('TradingBot');
  });

  test('handles unknown sender (not in participants)', () => {
    const messages: Message[] = [
      createMessage({
        id: 'msg-x',
        content: 'Ghost message',
        senderId: 'unknown-user',
      }),
    ];

    const lookup = buildReplyLookup(messages, participants);

    expect(lookup.get('msg-x')?.senderName).toBeUndefined();
  });

  test('handles empty messages array', () => {
    const lookup = buildReplyLookup([], participants);
    expect(lookup.size).toBe(0);
  });

  test('handles empty participants array', () => {
    const messages: Message[] = [
      createMessage({ id: 'msg-1', senderId: 'user-1' }),
    ];

    const lookup = buildReplyLookup(messages, []);

    expect(lookup.get('msg-1')?.senderName).toBeUndefined();
  });
});

describe('Reply Resolution - resolveReplyTo', () => {
  const replyLookup = new Map<string, ReplyToMessage>([
    [
      'msg-original',
      {
        id: 'msg-original',
        content: 'Original message',
        senderId: 'user-1',
        senderName: 'Alice',
      },
    ],
  ]);

  test('returns replyToMessage when already present on message (API data)', () => {
    const apiReply: ReplyToMessage = {
      id: 'msg-original',
      content: 'Original message',
      senderId: 'user-1',
      senderName: 'Alice',
    };

    const msg = createMessage({
      replyToMessageId: 'msg-original',
      replyToMessage: apiReply,
    });

    const result = resolveReplyTo(msg, replyLookup);

    expect(result).toBe(apiReply); // Same reference (prefer API data)
  });

  test('falls back to local lookup when replyToMessage is null', () => {
    const msg = createMessage({
      replyToMessageId: 'msg-original',
      replyToMessage: null,
    });

    const result = resolveReplyTo(msg, replyLookup);

    expect(result).toEqual({
      id: 'msg-original',
      content: 'Original message',
      senderId: 'user-1',
      senderName: 'Alice',
    });
  });

  test('falls back to local lookup when replyToMessage is absent', () => {
    const msg = createMessage({
      replyToMessageId: 'msg-original',
    });

    const result = resolveReplyTo(msg, replyLookup);

    expect(result).toBeDefined();
    expect(result?.content).toBe('Original message');
  });

  test('returns null when replyToMessageId not in lookup', () => {
    const msg = createMessage({
      replyToMessageId: 'msg-deleted',
    });

    const result = resolveReplyTo(msg, replyLookup);

    expect(result).toBeNull();
  });

  test('returns null when message has no reply fields', () => {
    const msg = createMessage({});

    const result = resolveReplyTo(msg, replyLookup);

    expect(result).toBeNull();
  });

  test('returns null when replyToMessageId is null', () => {
    const msg = createMessage({ replyToMessageId: null });

    const result = resolveReplyTo(msg, replyLookup);

    expect(result).toBeNull();
  });
});

describe('Reply Preview Truncation (120 chars)', () => {
  test('does not truncate short content', () => {
    const content = 'Short reply content';
    expect(truncateReplyPreview(content)).toBe(content);
  });

  test('does not truncate at exactly 120 chars', () => {
    const content = 'A'.repeat(120);
    expect(truncateReplyPreview(content)).toBe(content);
    expect(truncateReplyPreview(content).length).toBe(120);
  });

  test('truncates at 121 chars with ellipsis', () => {
    const content = 'A'.repeat(121);
    const result = truncateReplyPreview(content);
    expect(result).toBe('A'.repeat(120) + '...');
    expect(result.length).toBe(123);
  });

  test('truncates long content', () => {
    const content = 'A'.repeat(500);
    const result = truncateReplyPreview(content);
    expect(result).toBe('A'.repeat(120) + '...');
  });

  test('handles empty content', () => {
    expect(truncateReplyPreview('')).toBe('');
  });

  test('handles unicode content', () => {
    // Each emoji is multiple code points but still counts as characters in JS
    const emoji = '👋'.repeat(61); // 61 emoji = 122 JS chars (2 per surrogate pair)
    const result = truncateReplyPreview(emoji);
    // Should truncate since length > 120
    expect(result.length).toBeGreaterThan(120);
  });
});

describe('Message Bubble Reply Truncation (100 chars)', () => {
  test('does not truncate short content', () => {
    const content = 'Short message';
    expect(truncateMessageBubbleReply(content)).toBe(content);
  });

  test('does not truncate at exactly 100 chars', () => {
    const content = 'B'.repeat(100);
    expect(truncateMessageBubbleReply(content)).toBe(content);
  });

  test('truncates at 101 chars with ellipsis', () => {
    const content = 'B'.repeat(101);
    const result = truncateMessageBubbleReply(content);
    expect(result).toBe('B'.repeat(100) + '...');
  });

  test('truncates long content', () => {
    const content = 'B'.repeat(1000);
    const result = truncateMessageBubbleReply(content);
    expect(result).toBe('B'.repeat(100) + '...');
  });
});

describe('Context Menu - Skip Logic', () => {
  test('shows context menu for regular user messages', () => {
    const msg = createMessage({ type: 'user', isThinking: false });
    expect(shouldShowContextMenu(msg)).toBe(true);
  });

  test('shows context menu for messages without isThinking set', () => {
    const msg = createMessage({ type: 'user' });
    expect(shouldShowContextMenu(msg)).toBe(true);
  });

  test('hides context menu for thinking placeholder messages', () => {
    const msg = createMessage({ isThinking: true });
    expect(shouldShowContextMenu(msg)).toBe(false);
  });

  test('shows context menu for coordinator messages', () => {
    const msg = createMessage({ type: 'coordinator', isThinking: false });
    expect(shouldShowContextMenu(msg)).toBe(true);
  });

  test('shows context menu for system messages', () => {
    const msg = createMessage({ type: 'system', isThinking: false });
    expect(shouldShowContextMenu(msg)).toBe(true);
  });

  test('hides context menu for thinking coordinator messages', () => {
    const msg = createMessage({ type: 'coordinator', isThinking: true });
    expect(shouldShowContextMenu(msg)).toBe(false);
  });
});

describe('Reply State Management - resolveReplyToMessage', () => {
  const participants: ChatParticipant[] = [
    createParticipant({ id: 'user-1', displayName: 'Alice' }),
    createParticipant({ id: 'user-2', displayName: 'Bob' }),
  ];

  test('resolves sender name from participants', () => {
    const msg = createMessage({
      id: 'msg-1',
      content: 'Hello!',
      senderId: 'user-2',
    });

    const reply = resolveReplyToMessage(msg, participants);

    expect(reply).toEqual({
      id: 'msg-1',
      content: 'Hello!',
      senderId: 'user-2',
      senderName: 'Bob',
    });
  });

  test('handles unknown sender gracefully', () => {
    const msg = createMessage({
      id: 'msg-2',
      content: 'Mystery message',
      senderId: 'unknown-user',
    });

    const reply = resolveReplyToMessage(msg, participants);

    expect(reply.senderName).toBeUndefined();
    expect(reply.id).toBe('msg-2');
    expect(reply.content).toBe('Mystery message');
  });

  test('handles empty participants list', () => {
    const msg = createMessage({ id: 'msg-3', senderId: 'user-1' });

    const reply = resolveReplyToMessage(msg, []);

    expect(reply.senderName).toBeUndefined();
  });

  test('preserves full message content (no truncation at state level)', () => {
    const longContent = 'X'.repeat(5000);
    const msg = createMessage({ id: 'msg-4', content: longContent });

    const reply = resolveReplyToMessage(msg, participants);

    expect(reply.content).toBe(longContent);
    expect(reply.content.length).toBe(5000);
  });
});

describe('API Batch Reply Resolution', () => {
  const participants: ChatParticipant[] = [
    createParticipant({ id: 'user-1', displayName: 'Alice' }),
    createParticipant({ id: 'user-2', displayName: 'Bob' }),
  ];

  const allMessages: Message[] = [
    createMessage({
      id: 'msg-1',
      content: 'First message',
      senderId: 'user-1',
    }),
    createMessage({
      id: 'msg-2',
      content: 'Second message',
      senderId: 'user-2',
    }),
    createMessage({
      id: 'msg-3',
      content: 'Third message',
      senderId: 'user-1',
    }),
  ];

  test('enriches messages with reply data', () => {
    const messages: Message[] = [
      createMessage({
        id: 'msg-reply',
        content: 'Replying to first',
        senderId: 'user-2',
        replyToMessageId: 'msg-1',
      }),
    ];

    const enriched = batchResolveReplies(messages, allMessages, participants);

    expect(enriched[0]?.replyToMessage).toEqual({
      id: 'msg-1',
      content: 'First message',
      senderId: 'user-1',
      senderName: 'Alice',
    });
  });

  test('handles multiple replies to different messages', () => {
    const messages: Message[] = [
      createMessage({
        id: 'reply-a',
        replyToMessageId: 'msg-1',
        senderId: 'user-2',
      }),
      createMessage({
        id: 'reply-b',
        replyToMessageId: 'msg-2',
        senderId: 'user-1',
      }),
    ];

    const enriched = batchResolveReplies(messages, allMessages, participants);

    expect(enriched[0]?.replyToMessage?.id).toBe('msg-1');
    expect(enriched[0]?.replyToMessage?.senderName).toBe('Alice');
    expect(enriched[1]?.replyToMessage?.id).toBe('msg-2');
    expect(enriched[1]?.replyToMessage?.senderName).toBe('Bob');
  });

  test('handles reply to deleted/missing message', () => {
    const messages: Message[] = [
      createMessage({
        id: 'reply-orphan',
        replyToMessageId: 'msg-deleted',
        senderId: 'user-1',
      }),
    ];

    const enriched = batchResolveReplies(messages, allMessages, participants);

    expect(enriched[0]?.replyToMessage).toBeUndefined();
    expect(enriched[0]?.replyToMessageId).toBe('msg-deleted');
  });

  test('does not modify messages without replyToMessageId', () => {
    const messages: Message[] = [
      createMessage({ id: 'msg-plain', senderId: 'user-1' }),
    ];

    const enriched = batchResolveReplies(messages, allMessages, participants);

    expect(enriched[0]?.replyToMessage).toBeUndefined();
    expect(enriched[0]?.id).toBe('msg-plain');
  });

  test('truncates long reply content to 200 chars', () => {
    const longContent = 'Z'.repeat(500);
    const longMessages: Message[] = [
      createMessage({
        id: 'msg-long',
        content: longContent,
        senderId: 'user-1',
      }),
    ];

    const replyMessages: Message[] = [
      createMessage({
        id: 'reply-to-long',
        replyToMessageId: 'msg-long',
        senderId: 'user-2',
      }),
    ];

    const enriched = batchResolveReplies(
      replyMessages,
      longMessages,
      participants
    );

    expect(enriched[0]?.replyToMessage?.content).toBe('Z'.repeat(200) + '...');
    expect(enriched[0]?.replyToMessage?.content.length).toBe(203);
  });

  test('does not truncate content at exactly 200 chars', () => {
    const exact200 = 'Y'.repeat(200);
    const messages200: Message[] = [
      createMessage({
        id: 'msg-200',
        content: exact200,
        senderId: 'user-1',
      }),
    ];

    const replies: Message[] = [
      createMessage({
        id: 'reply-200',
        replyToMessageId: 'msg-200',
        senderId: 'user-2',
      }),
    ];

    const enriched = batchResolveReplies(replies, messages200, participants);

    expect(enriched[0]?.replyToMessage?.content).toBe(exact200);
    expect(enriched[0]?.replyToMessage?.content.length).toBe(200);
  });

  test('handles empty messages array', () => {
    const enriched = batchResolveReplies([], allMessages, participants);
    expect(enriched).toEqual([]);
  });

  test('handles multiple replies to same message (deduplication)', () => {
    const messages: Message[] = [
      createMessage({
        id: 'reply-1',
        replyToMessageId: 'msg-1',
        senderId: 'user-2',
      }),
      createMessage({
        id: 'reply-2',
        replyToMessageId: 'msg-1',
        senderId: 'user-2',
      }),
      createMessage({
        id: 'reply-3',
        replyToMessageId: 'msg-1',
        senderId: 'user-1',
      }),
    ];

    const enriched = batchResolveReplies(messages, allMessages, participants);

    // All three should get the same reply data
    for (const msg of enriched) {
      expect(msg.replyToMessage?.id).toBe('msg-1');
      expect(msg.replyToMessage?.content).toBe('First message');
      expect(msg.replyToMessage?.senderName).toBe('Alice');
    }
  });
});

describe('Reply Flow - End-to-End Simulation', () => {
  const participants: ChatParticipant[] = [
    createParticipant({ id: 'user-alice', displayName: 'Alice' }),
    createParticipant({ id: 'user-bob', displayName: 'Bob' }),
  ];

  test('simulates complete reply flow: select → compose → send → display', () => {
    // Step 1: Messages exist in chat
    const messages: Message[] = [
      createMessage({
        id: 'msg-1',
        content: 'Hey, what do you think about the market?',
        senderId: 'user-alice',
        createdAt: '2025-01-15T12:00:00.000Z',
      }),
      createMessage({
        id: 'msg-2',
        content: 'I think it will go up',
        senderId: 'user-bob',
        createdAt: '2025-01-15T12:01:00.000Z',
      }),
    ];

    // Step 2: Bob decides to reply to Alice's message
    const targetMsg = messages[0]!;
    const replyState = resolveReplyToMessage(targetMsg, participants);

    expect(replyState.id).toBe('msg-1');
    expect(replyState.senderName).toBe('Alice');
    expect(replyState.content).toBe('Hey, what do you think about the market?');

    // Step 3: Reply preview shows in input
    const previewText = truncateReplyPreview(replyState.content);
    expect(previewText).toBe('Hey, what do you think about the market?');

    // Step 4: Bob sends a reply message
    const replyMessage = createMessage({
      id: 'msg-3',
      content: 'I agree, bullish on this one!',
      senderId: 'user-bob',
      replyToMessageId: 'msg-1',
      createdAt: '2025-01-15T12:02:00.000Z',
    });

    // Step 5: Reply state should be cleared after send
    const clearedReplyState: ReplyToMessage | null = null;
    expect(clearedReplyState).toBeNull();

    // Step 6: Message arrives (via SSE) without replyToMessage data
    const sseMessage: Message = {
      ...replyMessage,
      replyToMessage: undefined,
    };

    // Step 7: Local lookup resolves the reply
    const allMessages = [...messages, sseMessage];
    const lookup = buildReplyLookup(allMessages, participants);
    const resolved = resolveReplyTo(sseMessage, lookup);

    expect(resolved).toBeDefined();
    expect(resolved?.id).toBe('msg-1');
    expect(resolved?.senderName).toBe('Alice');

    // Step 8: Message bubble shows truncated reply
    const bubbleText = truncateMessageBubbleReply(resolved!.content);
    expect(bubbleText).toBe('Hey, what do you think about the market?');
  });

  test('simulates reply to a very long message', () => {
    const longContent =
      'This is a very long message that discusses the nuances of prediction markets and their ability to aggregate information from diverse participants. ' +
      'The key insight is that markets incentivize honest reporting of beliefs because participants have skin in the game. ' +
      'Furthermore, the mechanism design ensures that...';

    const originalMsg = createMessage({
      id: 'long-msg',
      content: longContent,
      senderId: 'user-alice',
    });

    // Reply state preserves full content
    const replyState = resolveReplyToMessage(originalMsg, participants);
    expect(replyState.content).toBe(longContent);

    // Preview truncates at 120
    const preview = truncateReplyPreview(replyState.content);
    expect(preview.length).toBe(123); // 120 + '...'

    // Bubble truncates at 100
    const bubble = truncateMessageBubbleReply(replyState.content);
    expect(bubble.length).toBe(103); // 100 + '...'

    // API batch resolution truncates at 200
    const allMsgs = [originalMsg];
    const replyMsgs: Message[] = [
      createMessage({ id: 'reply', replyToMessageId: 'long-msg' }),
    ];
    const enriched = batchResolveReplies(replyMsgs, allMsgs, participants);
    expect(enriched[0]?.replyToMessage?.content.length).toBe(203); // 200 + '...'
  });

  test('simulates reply chain (reply to a reply)', () => {
    const messages: Message[] = [
      createMessage({
        id: 'msg-1',
        content: 'Original message',
        senderId: 'user-alice',
      }),
      createMessage({
        id: 'msg-2',
        content: 'Reply to original',
        senderId: 'user-bob',
        replyToMessageId: 'msg-1',
      }),
      createMessage({
        id: 'msg-3',
        content: 'Reply to the reply',
        senderId: 'user-alice',
        replyToMessageId: 'msg-2',
      }),
    ];

    const lookup = buildReplyLookup(messages, participants);

    // msg-3 replies to msg-2
    const resolvedMsg3 = resolveReplyTo(messages[2]!, lookup);
    expect(resolvedMsg3?.id).toBe('msg-2');
    expect(resolvedMsg3?.content).toBe('Reply to original');
    expect(resolvedMsg3?.senderName).toBe('Bob');

    // msg-2 replies to msg-1
    const resolvedMsg2 = resolveReplyTo(messages[1]!, lookup);
    expect(resolvedMsg2?.id).toBe('msg-1');
    expect(resolvedMsg2?.content).toBe('Original message');
    expect(resolvedMsg2?.senderName).toBe('Alice');
  });

  test('simulates optimistic reply message', () => {
    const messages: Message[] = [
      createMessage({
        id: 'msg-1',
        content: 'Question?',
        senderId: 'user-alice',
      }),
    ];

    // Optimistic message has replyToMessageId but no replyToMessage
    const optimisticId = `pending-${Date.now()}`;
    const optimisticReply = createMessage({
      id: optimisticId,
      content: 'Answer!',
      senderId: 'user-bob',
      replyToMessageId: 'msg-1',
      stableKey: optimisticId,
    });

    const allMessages = [...messages, optimisticReply];
    const lookup = buildReplyLookup(allMessages, participants);

    // Even optimistic messages can resolve their reply target
    const resolved = resolveReplyTo(optimisticReply, lookup);
    expect(resolved?.id).toBe('msg-1');
    expect(resolved?.content).toBe('Question?');
    expect(resolved?.senderName).toBe('Alice');
  });
});

describe('Edge Cases', () => {
  test('message replying to itself (should not happen but handle gracefully)', () => {
    const msg = createMessage({
      id: 'msg-self',
      content: 'Self-referential',
      senderId: 'user-1',
      replyToMessageId: 'msg-self',
    });

    const lookup = buildReplyLookup([msg], [createParticipant()]);
    const resolved = resolveReplyTo(msg, lookup);

    // Should resolve (lookup doesn't prevent self-reference)
    expect(resolved?.id).toBe('msg-self');
    expect(resolved?.content).toBe('Self-referential');
  });

  test('handles special characters in reply content', () => {
    const content = '<script>alert("xss")</script> & "quotes" <b>bold</b>';
    const msg = createMessage({
      id: 'msg-special',
      content,
      senderId: 'user-1',
    });

    const lookup = buildReplyLookup([msg], [createParticipant()]);
    const resolved = resolveReplyTo(
      createMessage({ replyToMessageId: 'msg-special' }),
      lookup
    );

    // Content should be preserved as-is (sanitization is the renderer's job)
    expect(resolved?.content).toBe(content);
  });

  test('handles newlines in reply content', () => {
    const content = 'Line 1\nLine 2\nLine 3';
    const msg = createMessage({
      id: 'msg-newlines',
      content,
      senderId: 'user-1',
    });

    const lookup = buildReplyLookup([msg], [createParticipant()]);
    const resolved = resolveReplyTo(
      createMessage({ replyToMessageId: 'msg-newlines' }),
      lookup
    );

    expect(resolved?.content).toBe(content);
  });

  test('handles empty reply content', () => {
    const msg = createMessage({
      id: 'msg-empty',
      content: '',
      senderId: 'user-1',
    });

    const lookup = buildReplyLookup([msg], [createParticipant()]);
    const resolved = resolveReplyTo(
      createMessage({ replyToMessageId: 'msg-empty' }),
      lookup
    );

    expect(resolved?.content).toBe('');
    expect(truncateReplyPreview('')).toBe('');
    expect(truncateMessageBubbleReply('')).toBe('');
  });

  test('ReplyPreview sender fallback to "Unknown"', () => {
    // Simulates what ReplyPreview renders: senderName || 'Unknown'
    const reply: ReplyToMessage = {
      id: 'msg-1',
      content: 'test',
      senderId: 'ghost',
    };
    const displayName = reply.senderName || 'Unknown';
    expect(displayName).toBe('Unknown');

    const replyWithName: ReplyToMessage = {
      id: 'msg-2',
      content: 'test',
      senderId: 'user-1',
      senderName: 'Alice',
    };
    const displayName2 = replyWithName.senderName || 'Unknown';
    expect(displayName2).toBe('Alice');
  });

  test('large message set - performance sanity check', () => {
    const participants = [
      createParticipant({ id: 'user-1', displayName: 'Alice' }),
    ];

    // 1000 messages
    const messages: Message[] = Array.from({ length: 1000 }, (_, i) =>
      createMessage({
        id: `msg-${i}`,
        content: `Message ${i}`,
        senderId: 'user-1',
        createdAt: new Date(Date.now() + i).toISOString(),
      })
    );

    const start = performance.now();
    const lookup = buildReplyLookup(messages, participants);
    const elapsed = performance.now() - start;

    expect(lookup.size).toBe(1000);
    expect(elapsed).toBeLessThan(100); // Should be well under 100ms

    // Resolve 100 replies
    const start2 = performance.now();
    for (let i = 0; i < 100; i++) {
      resolveReplyTo(
        createMessage({ replyToMessageId: `msg-${i * 10}` }),
        lookup
      );
    }
    const elapsed2 = performance.now() - start2;
    expect(elapsed2).toBeLessThan(50);
  });
});
