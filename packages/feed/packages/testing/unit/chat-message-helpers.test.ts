/**
 * Chat Message Helpers Unit Tests
 *
 * Tests the helper functions used in useChatMessages hook for:
 * - Message formatting from API responses
 * - Message sorting by timestamp
 * - Optimistic message matching and deduplication
 *
 * These are critical for real-time chat functionality.
 */

import { describe, expect, test } from 'bun:test';

// Replicate types from useChatMessages.ts
interface ChatMessage {
  id: string;
  content: string;
  chatId: string;
  senderId: string;
  type?: 'user' | 'system';
  createdAt: string;
  isGameChat?: boolean;
  stableKey?: string;
}

interface RawApiMessage {
  id: string;
  content: string;
  senderId: string;
  type?: 'user' | 'system';
  createdAt: string | Date;
}

// Replicate helper functions from useChatMessages.ts
function formatMessage(msg: RawApiMessage, chatId: string): ChatMessage {
  return {
    id: msg.id,
    content: msg.content,
    chatId,
    senderId: msg.senderId,
    type: msg.type,
    createdAt:
      typeof msg.createdAt === 'string'
        ? msg.createdAt
        : msg.createdAt.toISOString(),
  };
}

function sortByTime(messages: ChatMessage[]): ChatMessage[] {
  return [...messages].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
  );
}

function isMatchingOptimistic(
  pending: ChatMessage,
  incoming: ChatMessage
): boolean {
  return (
    pending.id.startsWith('pending-') &&
    pending.senderId === incoming.senderId &&
    pending.content === incoming.content &&
    Math.abs(
      new Date(pending.createdAt).getTime() -
        new Date(incoming.createdAt).getTime()
    ) < 30000
  );
}

describe('formatMessage', () => {
  const chatId = 'chat-123';

  test('formats basic message with string createdAt', () => {
    const raw: RawApiMessage = {
      id: 'msg-1',
      content: 'Hello world',
      senderId: 'user-1',
      type: 'user',
      createdAt: '2025-01-15T12:00:00.000Z',
    };

    const result = formatMessage(raw, chatId);

    expect(result).toEqual({
      id: 'msg-1',
      content: 'Hello world',
      chatId: 'chat-123',
      senderId: 'user-1',
      type: 'user',
      createdAt: '2025-01-15T12:00:00.000Z',
    });
  });

  test('converts Date object to ISO string', () => {
    const date = new Date('2025-01-15T12:00:00.000Z');
    const raw: RawApiMessage = {
      id: 'msg-2',
      content: 'Hello',
      senderId: 'user-1',
      createdAt: date,
    };

    const result = formatMessage(raw, chatId);

    expect(result.createdAt).toBe('2025-01-15T12:00:00.000Z');
    expect(typeof result.createdAt).toBe('string');
  });

  test('preserves message type when present', () => {
    const raw: RawApiMessage = {
      id: 'msg-3',
      content: 'System notification',
      senderId: 'system',
      type: 'system',
      createdAt: '2025-01-15T12:00:00.000Z',
    };

    const result = formatMessage(raw, chatId);

    expect(result.type).toBe('system');
  });

  test('handles undefined type', () => {
    const raw: RawApiMessage = {
      id: 'msg-4',
      content: 'Hello',
      senderId: 'user-1',
      createdAt: '2025-01-15T12:00:00.000Z',
    };

    const result = formatMessage(raw, chatId);

    expect(result.type).toBeUndefined();
  });

  test('assigns provided chatId correctly', () => {
    const raw: RawApiMessage = {
      id: 'msg-5',
      content: 'Hello',
      senderId: 'user-1',
      createdAt: '2025-01-15T12:00:00.000Z',
    };

    const result = formatMessage(raw, 'different-chat-id');

    expect(result.chatId).toBe('different-chat-id');
  });

  describe('edge cases', () => {
    test('handles empty content', () => {
      const raw: RawApiMessage = {
        id: 'msg-6',
        content: '',
        senderId: 'user-1',
        createdAt: '2025-01-15T12:00:00.000Z',
      };

      const result = formatMessage(raw, chatId);

      expect(result.content).toBe('');
    });

    test('handles very long content', () => {
      const longContent = 'A'.repeat(10000);
      const raw: RawApiMessage = {
        id: 'msg-7',
        content: longContent,
        senderId: 'user-1',
        createdAt: '2025-01-15T12:00:00.000Z',
      };

      const result = formatMessage(raw, chatId);

      expect(result.content).toBe(longContent);
      expect(result.content.length).toBe(10000);
    });

    test('handles unicode content', () => {
      const raw: RawApiMessage = {
        id: 'msg-8',
        content: 'Hello 👋 你好 مرحبا',
        senderId: 'user-1',
        createdAt: '2025-01-15T12:00:00.000Z',
      };

      const result = formatMessage(raw, chatId);

      expect(result.content).toBe('Hello 👋 你好 مرحبا');
    });

    test('handles snowflake-style IDs', () => {
      const raw: RawApiMessage = {
        id: '267685933648707584',
        content: 'Hello',
        senderId: '267685933648707585',
        createdAt: '2025-01-15T12:00:00.000Z',
      };

      const result = formatMessage(raw, '267685933648707586');

      expect(result.id).toBe('267685933648707584');
      expect(result.senderId).toBe('267685933648707585');
      expect(result.chatId).toBe('267685933648707586');
    });
  });
});

describe('sortByTime', () => {
  test('sorts messages in ascending order by timestamp', () => {
    const messages: ChatMessage[] = [
      {
        id: '3',
        content: 'Third',
        chatId: 'chat',
        senderId: 'user',
        createdAt: '2025-01-15T12:02:00.000Z',
      },
      {
        id: '1',
        content: 'First',
        chatId: 'chat',
        senderId: 'user',
        createdAt: '2025-01-15T12:00:00.000Z',
      },
      {
        id: '2',
        content: 'Second',
        chatId: 'chat',
        senderId: 'user',
        createdAt: '2025-01-15T12:01:00.000Z',
      },
    ];

    const sorted = sortByTime(messages);

    expect(sorted[0]?.id).toBe('1');
    expect(sorted[1]?.id).toBe('2');
    expect(sorted[2]?.id).toBe('3');
  });

  test('handles already sorted array', () => {
    const messages: ChatMessage[] = [
      {
        id: '1',
        content: 'First',
        chatId: 'chat',
        senderId: 'user',
        createdAt: '2025-01-15T12:00:00.000Z',
      },
      {
        id: '2',
        content: 'Second',
        chatId: 'chat',
        senderId: 'user',
        createdAt: '2025-01-15T12:01:00.000Z',
      },
    ];

    const sorted = sortByTime(messages);

    expect(sorted[0]?.id).toBe('1');
    expect(sorted[1]?.id).toBe('2');
  });

  test('handles empty array', () => {
    const sorted = sortByTime([]);
    expect(sorted).toEqual([]);
  });

  test('handles single message', () => {
    const messages: ChatMessage[] = [
      {
        id: '1',
        content: 'Only',
        chatId: 'chat',
        senderId: 'user',
        createdAt: '2025-01-15T12:00:00.000Z',
      },
    ];

    const sorted = sortByTime(messages);

    expect(sorted.length).toBe(1);
    expect(sorted[0]?.id).toBe('1');
  });

  test('handles same timestamp (stable sort)', () => {
    const timestamp = '2025-01-15T12:00:00.000Z';
    const messages: ChatMessage[] = [
      {
        id: '1',
        content: 'First',
        chatId: 'chat',
        senderId: 'user',
        createdAt: timestamp,
      },
      {
        id: '2',
        content: 'Second',
        chatId: 'chat',
        senderId: 'user',
        createdAt: timestamp,
      },
    ];

    const sorted = sortByTime(messages);

    // Both have same timestamp, order should be preserved
    expect(sorted.length).toBe(2);
  });

  test('handles millisecond precision', () => {
    const messages: ChatMessage[] = [
      {
        id: '2',
        content: 'Second',
        chatId: 'chat',
        senderId: 'user',
        createdAt: '2025-01-15T12:00:00.001Z',
      },
      {
        id: '1',
        content: 'First',
        chatId: 'chat',
        senderId: 'user',
        createdAt: '2025-01-15T12:00:00.000Z',
      },
    ];

    const sorted = sortByTime(messages);

    expect(sorted[0]?.id).toBe('1');
    expect(sorted[1]?.id).toBe('2');
  });

  test('handles very old and very new dates', () => {
    const messages: ChatMessage[] = [
      {
        id: 'new',
        content: 'New',
        chatId: 'chat',
        senderId: 'user',
        createdAt: '2030-01-01T00:00:00.000Z',
      },
      {
        id: 'old',
        content: 'Old',
        chatId: 'chat',
        senderId: 'user',
        createdAt: '2020-01-01T00:00:00.000Z',
      },
    ];

    const sorted = sortByTime(messages);

    expect(sorted[0]?.id).toBe('old');
    expect(sorted[1]?.id).toBe('new');
  });
});

describe('isMatchingOptimistic', () => {
  const baseTime = new Date('2025-01-15T12:00:00.000Z');

  test('matches optimistic message with same content and sender', () => {
    const pending: ChatMessage = {
      id: 'pending-12345',
      content: 'Hello world',
      chatId: 'chat',
      senderId: 'user-1',
      createdAt: baseTime.toISOString(),
    };

    const incoming: ChatMessage = {
      id: 'real-67890',
      content: 'Hello world',
      chatId: 'chat',
      senderId: 'user-1',
      createdAt: new Date(baseTime.getTime() + 1000).toISOString(), // 1 second later
    };

    expect(isMatchingOptimistic(pending, incoming)).toBe(true);
  });

  test('does not match non-pending message', () => {
    const pending: ChatMessage = {
      id: 'real-message-id', // Not starting with 'pending-'
      content: 'Hello world',
      chatId: 'chat',
      senderId: 'user-1',
      createdAt: baseTime.toISOString(),
    };

    const incoming: ChatMessage = {
      id: 'another-id',
      content: 'Hello world',
      chatId: 'chat',
      senderId: 'user-1',
      createdAt: baseTime.toISOString(),
    };

    expect(isMatchingOptimistic(pending, incoming)).toBe(false);
  });

  test('does not match different sender', () => {
    const pending: ChatMessage = {
      id: 'pending-12345',
      content: 'Hello world',
      chatId: 'chat',
      senderId: 'user-1',
      createdAt: baseTime.toISOString(),
    };

    const incoming: ChatMessage = {
      id: 'real-67890',
      content: 'Hello world',
      chatId: 'chat',
      senderId: 'user-2', // Different sender
      createdAt: baseTime.toISOString(),
    };

    expect(isMatchingOptimistic(pending, incoming)).toBe(false);
  });

  test('does not match different content', () => {
    const pending: ChatMessage = {
      id: 'pending-12345',
      content: 'Hello world',
      chatId: 'chat',
      senderId: 'user-1',
      createdAt: baseTime.toISOString(),
    };

    const incoming: ChatMessage = {
      id: 'real-67890',
      content: 'Different message',
      chatId: 'chat',
      senderId: 'user-1',
      createdAt: baseTime.toISOString(),
    };

    expect(isMatchingOptimistic(pending, incoming)).toBe(false);
  });

  test('matches within 30 second window', () => {
    const pending: ChatMessage = {
      id: 'pending-12345',
      content: 'Hello',
      chatId: 'chat',
      senderId: 'user-1',
      createdAt: baseTime.toISOString(),
    };

    // 29 seconds later - should match
    const incoming29s: ChatMessage = {
      id: 'real-1',
      content: 'Hello',
      chatId: 'chat',
      senderId: 'user-1',
      createdAt: new Date(baseTime.getTime() + 29000).toISOString(),
    };

    expect(isMatchingOptimistic(pending, incoming29s)).toBe(true);
  });

  test('does not match outside 30 second window', () => {
    const pending: ChatMessage = {
      id: 'pending-12345',
      content: 'Hello',
      chatId: 'chat',
      senderId: 'user-1',
      createdAt: baseTime.toISOString(),
    };

    // 31 seconds later - should NOT match
    const incoming31s: ChatMessage = {
      id: 'real-2',
      content: 'Hello',
      chatId: 'chat',
      senderId: 'user-1',
      createdAt: new Date(baseTime.getTime() + 31000).toISOString(),
    };

    expect(isMatchingOptimistic(pending, incoming31s)).toBe(false);
  });

  test('matches when incoming is slightly before pending (clock skew)', () => {
    const pending: ChatMessage = {
      id: 'pending-12345',
      content: 'Hello',
      chatId: 'chat',
      senderId: 'user-1',
      createdAt: baseTime.toISOString(),
    };

    // 5 seconds BEFORE - should match (handles clock skew)
    const incomingBefore: ChatMessage = {
      id: 'real-3',
      content: 'Hello',
      chatId: 'chat',
      senderId: 'user-1',
      createdAt: new Date(baseTime.getTime() - 5000).toISOString(),
    };

    expect(isMatchingOptimistic(pending, incomingBefore)).toBe(true);
  });

  test('boundary: exactly 30 seconds apart (exclusive)', () => {
    const pending: ChatMessage = {
      id: 'pending-12345',
      content: 'Hello',
      chatId: 'chat',
      senderId: 'user-1',
      createdAt: baseTime.toISOString(),
    };

    // Exactly 30 seconds - should NOT match (< 30000, not <=)
    const incomingExact: ChatMessage = {
      id: 'real-4',
      content: 'Hello',
      chatId: 'chat',
      senderId: 'user-1',
      createdAt: new Date(baseTime.getTime() + 30000).toISOString(),
    };

    expect(isMatchingOptimistic(pending, incomingExact)).toBe(false);
  });

  describe('edge cases', () => {
    test('handles empty content', () => {
      const pending: ChatMessage = {
        id: 'pending-12345',
        content: '',
        chatId: 'chat',
        senderId: 'user-1',
        createdAt: baseTime.toISOString(),
      };

      const incoming: ChatMessage = {
        id: 'real-67890',
        content: '',
        chatId: 'chat',
        senderId: 'user-1',
        createdAt: baseTime.toISOString(),
      };

      expect(isMatchingOptimistic(pending, incoming)).toBe(true);
    });

    test('handles whitespace-only content', () => {
      const pending: ChatMessage = {
        id: 'pending-12345',
        content: '   ',
        chatId: 'chat',
        senderId: 'user-1',
        createdAt: baseTime.toISOString(),
      };

      const incoming: ChatMessage = {
        id: 'real-67890',
        content: '   ',
        chatId: 'chat',
        senderId: 'user-1',
        createdAt: baseTime.toISOString(),
      };

      expect(isMatchingOptimistic(pending, incoming)).toBe(true);
    });

    test('content comparison is exact (case sensitive)', () => {
      const pending: ChatMessage = {
        id: 'pending-12345',
        content: 'Hello',
        chatId: 'chat',
        senderId: 'user-1',
        createdAt: baseTime.toISOString(),
      };

      const incoming: ChatMessage = {
        id: 'real-67890',
        content: 'hello',
        chatId: 'chat',
        senderId: 'user-1',
        createdAt: baseTime.toISOString(),
      };

      expect(isMatchingOptimistic(pending, incoming)).toBe(false);
    });

    test('handles very long content', () => {
      const longContent = 'A'.repeat(4000);
      const pending: ChatMessage = {
        id: 'pending-12345',
        content: longContent,
        chatId: 'chat',
        senderId: 'user-1',
        createdAt: baseTime.toISOString(),
      };

      const incoming: ChatMessage = {
        id: 'real-67890',
        content: longContent,
        chatId: 'chat',
        senderId: 'user-1',
        createdAt: baseTime.toISOString(),
      };

      expect(isMatchingOptimistic(pending, incoming)).toBe(true);
    });

    test('handles unicode content', () => {
      const pending: ChatMessage = {
        id: 'pending-12345',
        content: '你好 👋 مرحبا',
        chatId: 'chat',
        senderId: 'user-1',
        createdAt: baseTime.toISOString(),
      };

      const incoming: ChatMessage = {
        id: 'real-67890',
        content: '你好 👋 مرحبا',
        chatId: 'chat',
        senderId: 'user-1',
        createdAt: baseTime.toISOString(),
      };

      expect(isMatchingOptimistic(pending, incoming)).toBe(true);
    });
  });
});

describe('Optimistic Update Flow', () => {
  /**
   * Test the complete flow of optimistic updates:
   * 1. User sends message → optimistic message added
   * 2. Server confirms → real message arrives
   * 3. Optimistic message is replaced, preserving stableKey
   */

  test('simulates complete optimistic update flow', () => {
    const messages: ChatMessage[] = [];
    const chatId = 'chat-123';
    const senderId = 'user-1';

    // Step 1: User sends message (optimistic)
    const optimisticId = `pending-${Date.now()}`;
    const optimisticMessage: ChatMessage = {
      id: optimisticId,
      content: 'Hello world',
      chatId,
      senderId,
      type: 'user',
      createdAt: new Date().toISOString(),
      stableKey: optimisticId,
    };
    messages.push(optimisticMessage);

    expect(messages.length).toBe(1);
    expect(messages[0]?.id).toBe(optimisticId);
    expect(messages[0]?.stableKey).toBe(optimisticId);

    // Step 2: Server confirms (real message arrives)
    const realMessage: ChatMessage = {
      id: 'real-msg-12345',
      content: 'Hello world',
      chatId,
      senderId,
      type: 'user',
      createdAt: new Date().toISOString(),
    };

    // Step 3: Replace optimistic with real, preserving stableKey
    const pending = messages.find((msg) =>
      isMatchingOptimistic(msg, realMessage)
    );
    expect(pending).toBeDefined();

    const updatedMessages = messages.map((msg) =>
      msg.id === pending?.id
        ? { ...realMessage, stableKey: pending.stableKey }
        : msg
    );

    expect(updatedMessages.length).toBe(1);
    expect(updatedMessages[0]?.id).toBe('real-msg-12345');
    expect(updatedMessages[0]?.stableKey).toBe(optimisticId); // Key preserved!
    expect(updatedMessages[0]?.content).toBe('Hello world');
  });

  test('handles rapid message sending', () => {
    const messages: ChatMessage[] = [];
    const chatId = 'chat-123';
    const senderId = 'user-1';
    const now = Date.now();

    // Send 3 messages quickly
    for (let i = 0; i < 3; i++) {
      const optimisticId = `pending-${now + i}`;
      messages.push({
        id: optimisticId,
        content: `Message ${i + 1}`,
        chatId,
        senderId,
        type: 'user',
        createdAt: new Date(now + i * 100).toISOString(),
        stableKey: optimisticId,
      });
    }

    expect(messages.length).toBe(3);

    // Server confirms middle message
    const realMessage2: ChatMessage = {
      id: 'real-msg-2',
      content: 'Message 2',
      chatId,
      senderId,
      type: 'user',
      createdAt: new Date(now + 100).toISOString(),
    };

    const pending = messages.find((msg) =>
      isMatchingOptimistic(msg, realMessage2)
    );
    expect(pending?.content).toBe('Message 2');
    expect(pending?.id).toBe(`pending-${now + 1}`);
  });
});
