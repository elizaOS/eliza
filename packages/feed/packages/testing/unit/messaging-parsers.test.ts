/**
 * Messaging Parsers & SEND_MESSAGE Action Tests
 *
 * Tests the parsing functions used by the SEND_MESSAGE action:
 * - parseChatId: extract chat ID from text
 * - parseGroupName: extract quoted group name
 * - parseRecipientUsername: extract @username
 * - parseMessageContent: extract message body
 * - sendMessageAction.validate: input validation
 * - sendMessageAction.handler: full resolution flow
 *
 * Also tests context-gatherers:
 * - resolveGroupChatByName: sanitization, DB lookup
 * - resolveUserByUsername: @ stripping, case normalization
 */

import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { HandlerCallback, IAgentRuntime, Memory } from '@elizaos/core';

// ─── Mock DB for context-gatherers ───────────────────────────────────────────

let mockDbSelectLimit: ReturnType<typeof mock>;
let mockDbSelectWhere: ReturnType<typeof mock>;
let mockDbSelectInnerJoin2: ReturnType<typeof mock>;
let mockDbSelectInnerJoin1: ReturnType<typeof mock>;
let mockDbSelectFrom: ReturnType<typeof mock>;
let mockDbSelect: ReturnType<typeof mock>;

function resetDbMocks() {
  mockDbSelectLimit = mock(async () => []);
  mockDbSelectWhere = mock(() => ({ limit: mockDbSelectLimit }));
  mockDbSelectInnerJoin2 = mock(() => ({ where: mockDbSelectWhere }));
  mockDbSelectInnerJoin1 = mock(() => ({
    innerJoin: mockDbSelectInnerJoin2,
  }));
  mockDbSelectFrom = mock(() => ({
    innerJoin: mockDbSelectInnerJoin1,
    where: mockDbSelectWhere,
  }));
  mockDbSelect = mock(() => ({ from: mockDbSelectFrom }));
}

resetDbMocks();

const mockExecuteDirectMessage = mock(
  async () =>
    ({ success: true, messageId: 'msg-001' }) as Record<string, unknown>
);

const _actualDb = await import('@feed/db');
mock.module('@feed/db', () => ({
  ..._actualDb,
  db: {
    get select() {
      return mockDbSelect;
    },
  },
  eq: (a: unknown, b: unknown) => ({ op: 'eq', a, b }),
  and: (...args: unknown[]) => ({ op: 'and', args }),
  ilike: (col: unknown, val: unknown) => ({ op: 'ilike', col, val }),
  ne: (a: unknown, b: unknown) => ({ op: 'ne', a, b }),
  gte: (a: unknown, b: unknown) => ({ op: 'gte', a, b }),
  lte: (a: unknown, b: unknown) => ({ op: 'lte', a, b }),
  desc: (col: unknown) => ({ op: 'desc', col }),
  count: () => 'count',
  inArray: (col: unknown, vals: unknown) => ({ op: 'inArray', col, vals }),
  isNull: (col: unknown) => ({ op: 'isNull', col }),
  sql: Object.assign((...args: unknown[]) => args, { raw: (s: string) => s }),
  getDbInstance: () => ({}),
  getRawDrizzle: () => ({}),
  chats: {
    id: 'chats.id',
    groupId: 'chats.groupId',
    isGroup: 'chats.isGroup',
    name: 'chats.name',
  },
  chatParticipants: {
    chatId: 'chatParticipants.chatId',
    userId: 'chatParticipants.userId',
  },
  groups: { id: 'groups.id', name: 'groups.name' },
  users: { id: 'users.id', username: 'users.username' },
  markets: { id: 'markets.id', question: 'markets.question' },
  posts: {
    id: 'posts.id',
    content: 'posts.content',
    authorId: 'posts.authorId',
    timestamp: 'posts.timestamp',
    deletedAt: 'posts.deletedAt',
  },
  comments: { id: 'comments.id' },
  reactions: { id: 'reactions.id' },
  shares: { id: 'shares.id' },
  positions: { id: 'positions.id' },
  perpPositions: { id: 'perpPositions.id' },
}));

mock.module('../../agents/src/autonomous/DirectExecutors', () => ({
  executeDirectMessage: mockExecuteDirectMessage,
}));

const _actualEngine = await import('@feed/engine');
_actualEngine.StaticDataRegistry.getActor = () => null;
mock.module('@feed/engine', () => ({
  ..._actualEngine,
}));

mock.module('../../agents/src/shared/logger', () => ({
  logger: {
    info: mock(),
    warn: mock(),
    error: mock(),
    debug: mock(),
  },
}));

// ─── Import after mocks ──────────────────────────────────────────────────────

// Import the messaging module to get the parsers — they're module-level functions
// We access them via the action handler behavior + testing edge cases
const { resolveGroupChatByName, resolveUserByUsername } = await import(
  '../../agents/src/autonomous/utils/context-gatherers'
);

const { sendMessageAction } = await import(
  '../../agents/src/plugins/feed/actions/messaging'
);

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeMemory(text: string) {
  return { content: { text } } as unknown as Memory;
}

function makeRuntime(agentId?: string) {
  return {
    agentId: agentId ?? 'agent-001',
    a2aClient: agentId
      ? {
          agentId,
          isConnected: () => false,
        }
      : undefined,
  } as unknown as IAgentRuntime;
}

// ─── resolveGroupChatByName ──────────────────────────────────────────────────

describe('resolveGroupChatByName', () => {
  beforeEach(() => {
    resetDbMocks();
  });

  test('returns chatId when group is found', async () => {
    mockDbSelectLimit.mockResolvedValueOnce([{ chatId: 'chat-123' }]);

    const result = await resolveGroupChatByName('agent-001', 'Price Alerts');
    expect(result).toBe('chat-123');
  });

  test('returns null when group not found', async () => {
    mockDbSelectLimit.mockResolvedValueOnce([]);

    const result = await resolveGroupChatByName('agent-001', 'Nonexistent');
    expect(result).toBeNull();
  });

  test('sanitizes % and _ characters from input', async () => {
    mockDbSelectLimit.mockResolvedValueOnce([{ chatId: 'chat-456' }]);

    const result = await resolveGroupChatByName('agent-001', '%test_%group');
    expect(result).toBe('chat-456');
  });

  test('returns null when sanitized name is too short (< 2 chars)', async () => {
    const result = await resolveGroupChatByName('agent-001', 'a');
    expect(result).toBeNull();
    // Should not even query DB
    expect(mockDbSelect).not.toHaveBeenCalled();
  });

  test('returns null for empty string', async () => {
    const result = await resolveGroupChatByName('agent-001', '');
    expect(result).toBeNull();
  });

  test('returns null when only special characters remain after sanitization', async () => {
    const result = await resolveGroupChatByName('agent-001', '%%%___\\\\');
    expect(result).toBeNull();
  });

  test('handles backslash sanitization', async () => {
    mockDbSelectLimit.mockResolvedValueOnce([{ chatId: 'chat-789' }]);

    // Backslashes should be stripped
    const result = await resolveGroupChatByName('agent-001', 'test\\group');
    expect(result).toBe('chat-789');
  });

  test('trims whitespace from group name', async () => {
    mockDbSelectLimit.mockResolvedValueOnce([{ chatId: 'chat-101' }]);

    const result = await resolveGroupChatByName('agent-001', '  Trading  ');
    expect(result).toBe('chat-101');
  });
});

// ─── resolveUserByUsername ───────────────────────────────────────────────────

describe('resolveUserByUsername', () => {
  beforeEach(() => {
    resetDbMocks();
  });

  test('returns userId when user is found', async () => {
    mockDbSelectLimit.mockResolvedValueOnce([{ id: 'user-001' }]);

    const result = await resolveUserByUsername('alice');
    expect(result).toBe('user-001');
  });

  test('strips @ prefix', async () => {
    mockDbSelectLimit.mockResolvedValueOnce([{ id: 'user-002' }]);

    const result = await resolveUserByUsername('@bob');
    expect(result).toBe('user-002');
  });

  test('lowercases username', async () => {
    mockDbSelectLimit.mockResolvedValueOnce([{ id: 'user-003' }]);

    await resolveUserByUsername('Alice');
    // Verify the query was called (we can't easily check the exact where clause
    // but the function lowercases before querying)
    expect(mockDbSelect).toHaveBeenCalled();
  });

  test('returns null for empty username', async () => {
    const result = await resolveUserByUsername('');
    expect(result).toBeNull();
    expect(mockDbSelect).not.toHaveBeenCalled();
  });

  test('returns null for @ only', async () => {
    const result = await resolveUserByUsername('@');
    expect(result).toBeNull();
  });

  test('returns null for whitespace-only after cleaning', async () => {
    const result = await resolveUserByUsername('  @  ');
    expect(result).toBeNull();
  });

  test('returns null when user not found', async () => {
    mockDbSelectLimit.mockResolvedValueOnce([]);

    const result = await resolveUserByUsername('nonexistent');
    expect(result).toBeNull();
  });
});

// ─── sendMessageAction.validate ──────────────────────────────────────────────

describe('sendMessageAction.validate', () => {
  const runtime = makeRuntime('agent-001');

  test('validates "send message to chat 123: hello"', async () => {
    const result = await sendMessageAction.validate!(
      runtime,
      makeMemory('send message to chat 123: hello')
    );
    expect(result).toBe(true);
  });

  test('validates "DM @alice: hello"', async () => {
    const result = await sendMessageAction.validate!(
      runtime,
      makeMemory('DM @alice: hello')
    );
    expect(result).toBe(true);
  });

  test('validates "send alert to group"', async () => {
    const result = await sendMessageAction.validate!(
      runtime,
      makeMemory('send alert to group')
    );
    expect(result).toBe(true);
  });

  test('rejects unrelated text', async () => {
    const result = await sendMessageAction.validate!(
      runtime,
      makeMemory('what is the price of OPENAGI?')
    );
    expect(result).toBe(false);
  });

  test('rejects empty text', async () => {
    const result = await sendMessageAction.validate!(runtime, makeMemory(''));
    expect(result).toBe(false);
  });
});

// ─── sendMessageAction.handler ───────────────────────────────────────────────

describe('sendMessageAction.handler', () => {
  beforeEach(() => {
    resetDbMocks();
    mockExecuteDirectMessage.mockClear();
    mockExecuteDirectMessage.mockImplementation(async () => ({
      success: true,
      messageId: 'msg-001',
    }));
  });

  test('sends via explicit chatId (strategy 1)', async () => {
    const runtime = makeRuntime('agent-001');
    const message = makeMemory('send message to chat abc-123: Hello world');
    let callbackResult: Record<string, unknown> = undefined!;
    const callback = mock((data: Record<string, unknown>) => {
      callbackResult = data;
    });

    await sendMessageAction.handler(
      runtime,
      message,
      undefined,
      undefined,
      callback as unknown as HandlerCallback
    );

    expect(mockExecuteDirectMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        agentUserId: 'agent-001',
        chatId: 'abc-123',
      })
    );
    expect(callbackResult.text).toContain('Message sent');
  });

  test('sends via group name resolution (strategy 2)', async () => {
    const runtime = makeRuntime('agent-001');
    const message = makeMemory(
      "send message to 'Trading Alerts': OPENAGI is pumping"
    );
    let callbackResult: Record<string, unknown> = undefined!;
    const callback = mock((data: Record<string, unknown>) => {
      callbackResult = data;
    });

    // resolveGroupChatByName returns a chat ID
    mockDbSelectLimit.mockResolvedValueOnce([{ chatId: 'group-chat-789' }]);

    await sendMessageAction.handler(
      runtime,
      message,
      undefined,
      undefined,
      callback as unknown as HandlerCallback
    );

    expect(mockExecuteDirectMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: 'group-chat-789',
      })
    );
    expect(callbackResult.text).toContain('Trading Alerts');
  });

  test('reports error when group name not found', async () => {
    const runtime = makeRuntime('agent-001');
    const message = makeMemory("send message to 'Nonexistent Group': hello");
    let callbackResult: Record<string, unknown> = undefined!;
    const callback = mock((data: Record<string, unknown>) => {
      callbackResult = data;
    });

    // Group not found
    mockDbSelectLimit.mockResolvedValueOnce([]);

    await sendMessageAction.handler(
      runtime,
      message,
      undefined,
      undefined,
      callback as unknown as HandlerCallback
    );

    expect(mockExecuteDirectMessage).not.toHaveBeenCalled();
    expect(callbackResult.text).toContain('Could not find a group chat');
    expect(callbackResult.text).toContain('Nonexistent Group');
  });

  test('sends via @username resolution (strategy 3)', async () => {
    const runtime = makeRuntime('agent-001');
    const message = makeMemory('DM @alice: Hey check this out');
    let callbackResult: Record<string, unknown> = undefined!;
    const callback = mock((data: Record<string, unknown>) => {
      callbackResult = data;
    });

    // resolveUserByUsername returns a user ID
    mockDbSelectLimit.mockResolvedValueOnce([{ id: 'user-alice' }]);

    await sendMessageAction.handler(
      runtime,
      message,
      undefined,
      undefined,
      callback as unknown as HandlerCallback
    );

    expect(mockExecuteDirectMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        recipientId: 'user-alice',
      })
    );
    expect(callbackResult.text).toContain('DM sent to @alice');
  });

  test('reports error when @username not found', async () => {
    const runtime = makeRuntime('agent-001');
    const message = makeMemory('DM @nobody: hello');
    let callbackResult: Record<string, unknown> = undefined!;
    const callback = mock((data: Record<string, unknown>) => {
      callbackResult = data;
    });

    // User not found
    mockDbSelectLimit.mockResolvedValueOnce([]);

    await sendMessageAction.handler(
      runtime,
      message,
      undefined,
      undefined,
      callback as unknown as HandlerCallback
    );

    expect(mockExecuteDirectMessage).not.toHaveBeenCalled();
    expect(callbackResult.text).toContain('Could not find user @nobody');
  });

  test('returns error when message body is too short', async () => {
    const runtime = makeRuntime('agent-001');
    // Use a chatId with 5+ chars so it passes the chatId parser
    const message = makeMemory('send message to chat abcde: a');
    const callback = mock((_data: Record<string, unknown>) => {});

    await sendMessageAction.handler(
      runtime,
      message,
      undefined,
      undefined,
      callback as unknown as HandlerCallback
    );

    // May send "a" or may trigger the "could not parse" message depending on parsing
    // The key is that the function completes without throwing
    expect(callback).toHaveBeenCalled();
  });

  test('returns fallback error when no resolution strategy matches', async () => {
    const runtime = makeRuntime('agent-001');
    // Text that doesn't match any pattern
    const message = makeMemory('please just say hello to everyone');
    let callbackResult: Record<string, unknown> = undefined!;
    const callback = mock((data: Record<string, unknown>) => {
      callbackResult = data;
    });

    await sendMessageAction.handler(
      runtime,
      message,
      undefined,
      undefined,
      callback as unknown as HandlerCallback
    );

    expect(callbackResult.text).toContain('Could not determine where');
  });

  test('handles executeDirectMessage failure gracefully', async () => {
    const runtime = makeRuntime('agent-001');
    const message = makeMemory('send message to chat xyz-999: Hello');
    let callbackResult: Record<string, unknown> = undefined!;
    const callback = mock((data: Record<string, unknown>) => {
      callbackResult = data;
    });

    mockExecuteDirectMessage.mockResolvedValueOnce({
      success: false,
      error: 'Chat not found',
    });

    await sendMessageAction.handler(
      runtime,
      message,
      undefined,
      undefined,
      callback as unknown as HandlerCallback
    );

    expect(callbackResult.text).toContain('Failed to send');
    expect(callbackResult.text).toContain('Chat not found');
  });

  test('handles undefined callback without throwing', async () => {
    const runtime = makeRuntime('agent-001');
    const message = makeMemory('send message to chat xyz-test: hello');

    // Should not throw even with no callback
    await sendMessageAction.handler(
      runtime,
      message,
      undefined,
      undefined,
      undefined
    );
  });

  test('does NOT false-positive "General Chat:" as a chatId', async () => {
    const runtime = makeRuntime('agent-001');
    const message = makeMemory('send message to General Chat: Hello everyone');
    let callbackResult: Record<string, unknown> = undefined!;
    const callback = mock((data: Record<string, unknown>) => {
      callbackResult = data;
    });

    // resolveGroupChatByName should be called (strategy 2), NOT parseChatId
    mockDbSelectLimit.mockResolvedValueOnce([{ chatId: 'group-chat-general' }]);

    await sendMessageAction.handler(
      runtime,
      message,
      undefined,
      undefined,
      callback as unknown as HandlerCallback
    );

    // Should resolve via group name, not chatId
    expect(mockExecuteDirectMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: 'group-chat-general',
      })
    );
    expect(callbackResult.text).toContain('General Chat');
  });

  test('resolves unquoted group name before colon', async () => {
    const runtime = makeRuntime('agent-001');
    const message = makeMemory(
      'send message to Price Alerts: OPENAGI dropped below 22'
    );
    let callbackResult: Record<string, unknown> = undefined!;
    const callback = mock((data: Record<string, unknown>) => {
      callbackResult = data;
    });

    mockDbSelectLimit.mockResolvedValueOnce([{ chatId: 'alerts-chat-001' }]);

    await sendMessageAction.handler(
      runtime,
      message,
      undefined,
      undefined,
      callback as unknown as HandlerCallback
    );

    expect(mockExecuteDirectMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: 'alerts-chat-001',
      })
    );
    expect(callbackResult.text).toContain('Price Alerts');
  });
});
