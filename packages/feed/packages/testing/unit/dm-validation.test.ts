/**
 * DM Validation Unit Tests
 *
 * Tests for DM validation logic and business rules
 */

import { describe, expect, test } from 'bun:test';
import {
  getOtherDmParticipantId,
  isUserInDmChatId,
} from '../../../apps/web/src/app/api/chats/_lib/dm-chat-id';

describe('DM Chat ID Generation', () => {
  function generateDMChatId(userId1: string, userId2: string): string {
    const sortedIds = [userId1, userId2].sort();
    return `dm-${sortedIds.join('-')}`;
  }

  test('should generate consistent IDs regardless of order', () => {
    const user1 = 'user-abc-123';
    const user2 = 'user-xyz-789';

    const id1 = generateDMChatId(user1, user2);
    const id2 = generateDMChatId(user2, user1);

    expect(id1).toBe(id2);
  });

  test('should include dm- prefix', () => {
    const chatId = generateDMChatId('user-1', 'user-2');
    expect(chatId).toMatch(/^dm-/);
  });

  test('should handle UUID format users', () => {
    const uuid1 = '550e8400-e29b-41d4-a716-446655440000';
    const uuid2 = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

    const chatId = generateDMChatId(uuid1, uuid2);
    expect(chatId).toContain(uuid1);
    expect(chatId).toContain(uuid2);
  });

  test('should handle Privy DID format users', () => {
    const did1 = 'did:privy:cm6sqq4og01qw9l70rbmyjn20';
    const did2 = 'did:privy:babylon-support-demo';

    const chatId = generateDMChatId(did1, did2);
    expect(chatId.length).toBeGreaterThan(3);
  });
});

describe('DM Chat ID Parsing', () => {
  test('extracts the other participant when current user appears first', () => {
    const currentUserId = '123456789012345678';
    const actorId = 'kash-patrol';

    expect(
      getOtherDmParticipantId(`dm-${currentUserId}-${actorId}`, currentUserId)
    ).toBe(actorId);
  });

  test('extracts the other participant when current user appears last', () => {
    const currentUserId = '123456789012345678';
    const actorId = 'kash-patrol';

    expect(
      getOtherDmParticipantId(`dm-${actorId}-${currentUserId}`, currentUserId)
    ).toBe(actorId);
  });

  test('handles hyphenated identifiers without splitting them incorrectly', () => {
    const currentUserId = '550e8400-e29b-41d4-a716-446655440000';
    const otherUserId = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
    const chatId = `dm-${currentUserId}-${otherUserId}`;

    expect(getOtherDmParticipantId(chatId, currentUserId)).toBe(otherUserId);
    expect(isUserInDmChatId(chatId, currentUserId)).toBe(true);
  });

  test('rejects DM chat IDs that do not include the current user', () => {
    expect(isUserInDmChatId('dm-user-a-user-b', 'user-c')).toBe(false);
    expect(getOtherDmParticipantId('dm-user-a-user-b', 'user-c')).toBeNull();
  });
});

describe('DM Validation Rules', () => {
  function validateDMCreation(
    currentUserId: string,
    targetUserId: string
  ): {
    valid: boolean;
    error?: string;
  } {
    // Rule 1: Cannot DM yourself
    if (currentUserId === targetUserId) {
      return { valid: false, error: 'Cannot DM yourself' };
    }

    // Rule 2: User IDs must be non-empty
    if (!currentUserId || !targetUserId) {
      return { valid: false, error: 'User ID required' };
    }

    // Rule 3: User IDs must be strings
    if (typeof currentUserId !== 'string' || typeof targetUserId !== 'string') {
      return { valid: false, error: 'User ID must be a string' };
    }

    return { valid: true };
  }

  test('should reject self-DM attempts', () => {
    const result = validateDMCreation('user-123', 'user-123');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('yourself');
  });

  test('should reject empty user IDs', () => {
    const result1 = validateDMCreation('', 'user-123');
    const result2 = validateDMCreation('user-123', '');

    expect(result1.valid).toBe(false);
    expect(result2.valid).toBe(false);
  });

  test('should accept valid DM creation', () => {
    const result = validateDMCreation('user-1', 'user-2');
    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });
});

describe('User Type Validation', () => {
  interface User {
    id: string;
    isActor: boolean;
    displayName: string | null;
  }

  function canReceiveDM(user: User | null): boolean {
    if (!user) return false;
    if (user.isActor) return false;
    return true;
  }

  test('should reject NPCs/actors', () => {
    const npcUser: User = {
      id: 'actor-123',
      isActor: true,
      displayName: 'NPC Trader',
    };

    expect(canReceiveDM(npcUser)).toBe(false);
  });

  test('should accept real users', () => {
    const realUser: User = {
      id: 'user-123',
      isActor: false,
      displayName: 'Real Player',
    };

    expect(canReceiveDM(realUser)).toBe(true);
  });

  test('should reject null users', () => {
    expect(canReceiveDM(null)).toBe(false);
  });
});

describe('Message Quality for DMs', () => {
  interface QualityResult {
    passed: boolean;
    score: number;
    errors: string[];
  }

  function validateMessageQuality(
    content: string,
    _contextType: 'dm' | 'groupchat'
  ): QualityResult {
    const errors: string[] = [];
    const trimmed = content.trim();

    // Min length: 10 chars
    if (trimmed.length < 10) {
      errors.push('Message too short (min 10 characters)');
    }

    // Max length: 500 chars
    if (trimmed.length > 500) {
      errors.push('Message too long (max 500 characters)');
    }

    // Min word count: 3 words
    const words = trimmed.split(/\s+/).filter((w) => w.length > 0);
    if (words.length < 3) {
      errors.push('Message must contain at least 3 words');
    }

    const passed = errors.length === 0;
    const score = passed ? 1.0 : 0.0;

    return { passed, score, errors };
  }

  test('should enforce minimum length for DMs', () => {
    const result = validateMessageQuality('Hi', 'dm');
    expect(result.passed).toBe(false);
    expect(result.errors).toContain('Message too short (min 10 characters)');
  });

  test('should enforce minimum word count for DMs', () => {
    const result = validateMessageQuality('Hello there', 'dm');
    expect(result.passed).toBe(false);
    expect(result.errors).toContain('Message must contain at least 3 words');
  });

  test('should accept valid DM messages', () => {
    const result = validateMessageQuality(
      'Hello, how are you doing today?',
      'dm'
    );
    expect(result.passed).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.score).toBe(1.0);
  });

  test('should enforce maximum length', () => {
    const longMessage = 'x'.repeat(501);
    const result = validateMessageQuality(longMessage, 'dm');
    expect(result.passed).toBe(false);
    expect(result.errors.some((e) => e.includes('too long'))).toBe(true);
  });
});

describe('Chat Participant Validation', () => {
  interface ChatParticipant {
    chatId: string;
    userId: string;
  }

  function isUserInDM(
    participants: ChatParticipant[],
    userId: string
  ): boolean {
    return participants.some((p) => p.userId === userId);
  }

  test('should detect user membership', () => {
    const participants: ChatParticipant[] = [
      { chatId: 'dm-1', userId: 'user-a' },
      { chatId: 'dm-1', userId: 'user-b' },
    ];

    expect(isUserInDM(participants, 'user-a')).toBe(true);
    expect(isUserInDM(participants, 'user-b')).toBe(true);
    expect(isUserInDM(participants, 'user-c')).toBe(false);
  });

  test('should handle empty participant list', () => {
    expect(isUserInDM([], 'user-a')).toBe(false);
  });
});

describe('DM Chat Type Detection', () => {
  interface Chat {
    id: string;
    isGroup: boolean;
    gameId: string | null;
  }

  function detectChatType(chat: Chat): 'game' | 'group' | 'dm' {
    if (chat.isGroup && chat.gameId === 'continuous') {
      return 'game';
    }
    if (!chat.isGroup) {
      return 'dm';
    }
    return 'group';
  }

  test('should detect DM chats', () => {
    const dmChat: Chat = {
      id: 'dm-user-1-user-2',
      isGroup: false,
      gameId: null,
    };

    expect(detectChatType(dmChat)).toBe('dm');
  });

  test('should detect game chats', () => {
    const gameChat: Chat = {
      id: 'game-chat-123',
      isGroup: true,
      gameId: 'continuous',
    };

    expect(detectChatType(gameChat)).toBe('game');
  });

  test('should detect group chats', () => {
    const groupChat: Chat = {
      id: 'group-chat-123',
      isGroup: true,
      gameId: null,
    };

    expect(detectChatType(groupChat)).toBe('group');
  });
});
