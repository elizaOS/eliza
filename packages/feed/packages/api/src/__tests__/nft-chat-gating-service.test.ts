/**
 * Unit Tests: NFT Chat Gating Service
 *
 * Tests the NFT chat gating functionality including:
 * - Configuration parsing from environment variables
 * - Access control logic (isNftChatGatedChat, canAccessNftChatGate)
 * - Authorization enforcement (requireNftChatAccess)
 * - Membership management (ensureNftChatMembership, revokeNftChatMembershipIfNeeded)
 *
 * Run with: bun test packages/api/src/__tests__/nft-chat-gating-service.test.ts
 */

import { beforeEach, describe, expect, it, mock } from 'bun:test';

// Mock tables
const chatsTable = { id: 'id', isGroup: 'isGroup', groupId: 'groupId' };
const usersTable = { id: 'id', walletAddress: 'walletAddress' };
const groupMembersTable = {
  id: 'id',
  groupId: 'groupId',
  userId: 'userId',
  isActive: 'isActive',
};
const chatParticipantsTable = {
  id: 'id',
  chatId: 'chatId',
  userId: 'userId',
  isActive: 'isActive',
};

// Mock functions
const mockHasOnchainNftAccess = mock();
const mockDbSelect = mock();
const mockDbInsert = mock();
const mockDbUpdate = mock();
const mockDbTransaction = mock();
const mockGenerateSnowflakeId = mock();
const mockLogger = {
  info: mock(),
  warn: mock(),
  error: mock(),
};

// Mock dependencies - use paths relative to the module being tested
mock.module('../services/nft-indexer-service', () => ({
  hasOnchainNftAccess: mockHasOnchainNftAccess,
  NftIndexerUnavailableError: class NftIndexerUnavailableError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'NftIndexerUnavailableError';
    }
  },
}));

mock.module('@babylon/db', () => ({
  db: {
    select: mockDbSelect,
    insert: mockDbInsert,
    update: mockDbUpdate,
    transaction: mockDbTransaction,
  },
  eq: (field: unknown, value: unknown) => ({ type: 'eq', field, value }),
  and: (...conditions: unknown[]) => ({ type: 'and', conditions }),
  chats: chatsTable,
  users: usersTable,
  groupMembers: groupMembersTable,
  chatParticipants: chatParticipantsTable,
}));

mock.module('drizzle-orm', () => ({
  sql: (strings: TemplateStringsArray) => ({ type: 'sql', value: strings[0] }),
}));

mock.module('@babylon/shared', () => ({
  generateSnowflakeId: mockGenerateSnowflakeId,
  logger: mockLogger,
  ValidationError: class ValidationError extends Error {
    constructor(
      message: string,
      public fields: string[],
      public errors: Array<{ field: string; message: string }>
    ) {
      super(message);
      this.name = 'ValidationError';
    }
  },
}));

mock.module('../errors', () => ({
  AuthorizationError: class AuthorizationError extends Error {
    constructor(
      message: string,
      public resource: string,
      public action: string,
      public context?: Record<string, unknown>
    ) {
      super(message);
      this.name = 'AuthorizationError';
    }
  },
  NotFoundError: class NotFoundError extends Error {
    constructor(
      public resourceType: string,
      public resourceId: string
    ) {
      super(`${resourceType} not found: ${resourceId}`);
      this.name = 'NotFoundError';
    }
  },
}));

// Import after mocks are set up
import {
  canAccessNftChatGate,
  ensureNftChatMembership,
  getNftChatGatingConfig,
  isNftChatGatedChat,
  requireNftChatAccess,
  revokeNftChatMembershipIfNeeded,
} from '../services/nft-chat-gating-service';

describe('NFT Chat Gating Service', () => {
  beforeEach(() => {
    // Reset all mocks
    mockHasOnchainNftAccess.mockReset();
    mockDbSelect.mockReset();
    mockDbInsert.mockReset();
    mockDbUpdate.mockReset();
    mockDbTransaction.mockReset();
    mockGenerateSnowflakeId.mockReset();
    mockLogger.info.mockReset();
    mockLogger.warn.mockReset();
    mockLogger.error.mockReset();

    // Reset environment variables
    delete process.env.NFT_GATING_ENABLED;
    delete process.env.NFT_CHAT_GATING_ENABLED;
    delete process.env.NFT_CHAT_GATING_CHAT_ID;
  });

  describe('getNftChatGatingConfig', () => {
    it('should return disabled config when env vars are not set', () => {
      const config = getNftChatGatingConfig();
      expect(config.enabled).toBe(false);
      expect(config.chatId).toBeNull();
    });

    it('should return enabled config when NFT_CHAT_GATING_ENABLED=true', () => {
      process.env.NFT_CHAT_GATING_ENABLED = 'true';
      process.env.NFT_CHAT_GATING_CHAT_ID = 'chat-123';

      const config = getNftChatGatingConfig();
      expect(config.enabled).toBe(true);
      expect(config.chatId).toBe('chat-123');
    });

    it('ignores the removed global NFT gate flag', () => {
      process.env.NFT_GATING_ENABLED = 'true';
      process.env.NFT_CHAT_GATING_CHAT_ID = 'chat-123';

      const config = getNftChatGatingConfig();
      expect(config.enabled).toBe(false);
      expect(config.chatId).toBe('chat-123');
    });

    it('should parse various truthy values for enabled flag', () => {
      const truthyValues = ['true', 'TRUE', '1', 'yes', 'YES', 'on', 'ON'];

      for (const value of truthyValues) {
        process.env.NFT_CHAT_GATING_ENABLED = value;
        const config = getNftChatGatingConfig();
        expect(config.enabled).toBe(true);
      }
    });

    it('should return false for non-truthy enabled values', () => {
      const falsyValues = ['false', '0', 'no', 'off', 'random', ''];

      for (const value of falsyValues) {
        process.env.NFT_CHAT_GATING_ENABLED = value;
        const config = getNftChatGatingConfig();
        expect(config.enabled).toBe(false);
      }
    });

    it('should trim whitespace from chat ID', () => {
      process.env.NFT_CHAT_GATING_ENABLED = 'true';
      process.env.NFT_CHAT_GATING_CHAT_ID = '  chat-123  ';

      const config = getNftChatGatingConfig();
      expect(config.chatId).toBe('chat-123');
    });

    it('should return null chatId for empty or whitespace-only value', () => {
      process.env.NFT_CHAT_GATING_ENABLED = 'true';
      process.env.NFT_CHAT_GATING_CHAT_ID = '   ';

      const config = getNftChatGatingConfig();
      expect(config.chatId).toBeNull();
    });
  });

  describe('isNftChatGatedChat', () => {
    it('should return false when gating is disabled', () => {
      process.env.NFT_CHAT_GATING_ENABLED = 'false';
      process.env.NFT_CHAT_GATING_CHAT_ID = 'chat-123';

      expect(isNftChatGatedChat('chat-123')).toBe(false);
    });

    it('should return false when chatId does not match gated chat', () => {
      process.env.NFT_CHAT_GATING_ENABLED = 'true';
      process.env.NFT_CHAT_GATING_CHAT_ID = 'chat-123';

      expect(isNftChatGatedChat('chat-456')).toBe(false);
    });

    it('should return true when chatId matches gated chat and gating is enabled', () => {
      process.env.NFT_CHAT_GATING_ENABLED = 'true';
      process.env.NFT_CHAT_GATING_CHAT_ID = 'chat-123';

      expect(isNftChatGatedChat('chat-123')).toBe(true);
    });

    it('should return false when gated chatId is not configured', () => {
      process.env.NFT_CHAT_GATING_ENABLED = 'true';

      expect(isNftChatGatedChat('chat-123')).toBe(false);
    });
  });

  describe('canAccessNftChatGate', () => {
    beforeEach(() => {
      process.env.NFT_CHAT_GATING_ENABLED = 'true';
      process.env.NFT_CHAT_GATING_CHAT_ID = 'gated-chat';
    });

    it('should return true for non-gated chats', async () => {
      const result = await canAccessNftChatGate('user-123', 'regular-chat');
      expect(result).toBe(true);
      expect(mockHasOnchainNftAccess).not.toHaveBeenCalled();
    });

    it('should check NFT access for gated chat', async () => {
      mockHasOnchainNftAccess.mockResolvedValue(true);
      mockDbSelect.mockImplementation(() => ({
        from: (table: unknown) => {
          if (table === usersTable) {
            return {
              where: () => ({
                limit: () => Promise.resolve([{ walletAddress: '0xabc' }]),
              }),
            };
          }
          throw new Error('Unexpected select table');
        },
      }));

      const result = await canAccessNftChatGate('regular-user', 'gated-chat');
      expect(result).toBe(true);
      expect(mockHasOnchainNftAccess).toHaveBeenCalledWith('0xabc', {
        cacheScope: 'premium_chat',
        positiveTtlMs: 10000,
        negativeTtlMs: 10000,
      });
    });

    it('should return false when user does not hold an NFT', async () => {
      mockHasOnchainNftAccess.mockResolvedValue(false);
      mockDbSelect.mockImplementation(() => ({
        from: (table: unknown) => {
          if (table === usersTable) {
            return {
              where: () => ({
                limit: () => Promise.resolve([{ walletAddress: '0xabc' }]),
              }),
            };
          }
          throw new Error('Unexpected select table');
        },
      }));

      const result = await canAccessNftChatGate('regular-user', 'gated-chat');
      expect(result).toBe(false);
    });
  });

  describe('requireNftChatAccess', () => {
    beforeEach(() => {
      process.env.NFT_CHAT_GATING_ENABLED = 'true';
      process.env.NFT_CHAT_GATING_CHAT_ID = 'gated-chat';
    });

    it('should not throw for non-gated chats', async () => {
      const user = { userId: 'user-123' };
      await expect(
        requireNftChatAccess(user, 'regular-chat')
      ).resolves.toBeUndefined();
    });

    it('should throw for agents on gated chats', async () => {
      mockDbSelect.mockImplementation(() => ({
        from: (table: unknown) => {
          if (table === usersTable) {
            return {
              where: () => ({
                limit: () => Promise.resolve([]),
              }),
            };
          }
          throw new Error('Unexpected select table');
        },
      }));

      const user = { userId: 'agent-123', isAgent: true };
      await expect(requireNftChatAccess(user, 'gated-chat')).rejects.toThrow(
        'NFT chat access required'
      );
    });

    it('should not throw when user has access', async () => {
      mockHasOnchainNftAccess.mockResolvedValue(true);
      mockDbSelect.mockImplementation(() => ({
        from: (table: unknown) => {
          if (table === usersTable) {
            return {
              where: () => ({
                limit: () => Promise.resolve([{ walletAddress: '0xabc' }]),
              }),
            };
          }
          throw new Error('Unexpected select table');
        },
      }));

      const user = { userId: 'user-123', dbUserId: 'db-user-123' };
      await expect(
        requireNftChatAccess(user, 'gated-chat')
      ).resolves.toBeUndefined();
    });

    it('should throw AuthorizationError when user lacks access', async () => {
      mockHasOnchainNftAccess.mockResolvedValue(false);
      mockDbSelect.mockImplementation(() => ({
        from: (table: unknown) => {
          if (table === usersTable) {
            return {
              where: () => ({
                limit: () => Promise.resolve([{ walletAddress: '0xabc' }]),
              }),
            };
          }
          throw new Error('Unexpected select table');
        },
      }));

      const user = { userId: 'user-123' };
      await expect(requireNftChatAccess(user, 'gated-chat')).rejects.toThrow(
        'NFT chat access required'
      );
    });

    it('should prefer dbUserId over userId for access check', async () => {
      mockHasOnchainNftAccess.mockResolvedValue(true);
      mockDbSelect.mockImplementation(() => ({
        from: (table: unknown) => {
          if (table === usersTable) {
            return {
              where: () => ({
                limit: () => Promise.resolve([{ walletAddress: '0xabc' }]),
              }),
            };
          }
          throw new Error('Unexpected select table');
        },
      }));

      const user = { userId: 'privy-id', dbUserId: 'db-user-123' };
      await requireNftChatAccess(user, 'gated-chat');

      // Should call with dbUserId, not userId
      expect(mockHasOnchainNftAccess).toHaveBeenCalledWith('0xabc', {
        cacheScope: 'premium_chat',
        positiveTtlMs: 10000,
        negativeTtlMs: 10000,
      });
    });

    it('should fallback to userId when dbUserId is not available', async () => {
      mockHasOnchainNftAccess.mockResolvedValue(true);
      mockDbSelect.mockImplementation(() => ({
        from: (table: unknown) => {
          if (table === usersTable) {
            return {
              where: () => ({
                limit: () => Promise.resolve([{ walletAddress: '0xabc' }]),
              }),
            };
          }
          throw new Error('Unexpected select table');
        },
      }));

      const user = { userId: 'user-123' };
      await requireNftChatAccess(user, 'gated-chat');

      expect(mockHasOnchainNftAccess).toHaveBeenCalledWith('0xabc', {
        cacheScope: 'premium_chat',
        positiveTtlMs: 10000,
        negativeTtlMs: 10000,
      });
    });
  });

  describe('ensureNftChatMembership', () => {
    beforeEach(() => {
      process.env.NFT_CHAT_GATING_ENABLED = 'true';
      process.env.NFT_CHAT_GATING_CHAT_ID = 'gated-chat';
    });

    it('should throw ValidationError when gating is disabled', async () => {
      process.env.NFT_CHAT_GATING_ENABLED = 'false';

      await expect(ensureNftChatMembership('user-123')).rejects.toThrow(
        'NFT chat gating is disabled'
      );
    });

    it('should throw ValidationError when chatId is not configured', async () => {
      delete process.env.NFT_CHAT_GATING_CHAT_ID;

      await expect(ensureNftChatMembership('user-123')).rejects.toThrow(
        'NFT chat gating chat id not configured'
      );
    });

    it('should throw AuthorizationError when user lacks NFT access', async () => {
      mockHasOnchainNftAccess.mockResolvedValue(false);
      mockDbSelect.mockImplementation(() => ({
        from: (table: unknown) => {
          if (table === usersTable) {
            return {
              where: () => ({
                limit: () => Promise.resolve([{ walletAddress: '0xabc' }]),
              }),
            };
          }
          throw new Error('Unexpected select table');
        },
      }));

      await expect(ensureNftChatMembership('user-123')).rejects.toThrow(
        'NFT chat access required'
      );
    });

    it('should not allow admins without holding an NFT', async () => {
      mockHasOnchainNftAccess.mockResolvedValue(false);

      mockDbSelect.mockImplementation(() => ({
        from: (table: unknown) => {
          if (table === usersTable) {
            return {
              where: () => ({
                limit: () => Promise.resolve([]),
              }),
            };
          }
          throw new Error('Unexpected select table');
        },
      }));

      await expect(ensureNftChatMembership('admin-user')).rejects.toThrow(
        'NFT chat access required'
      );
    });

    it('should throw NotFoundError when chat does not exist', async () => {
      mockHasOnchainNftAccess.mockResolvedValue(true);

      // Mock db.select returning empty
      mockDbSelect.mockImplementation(() => ({
        from: (table: unknown) => {
          if (table === usersTable) {
            return {
              where: () => ({
                limit: () => Promise.resolve([{ walletAddress: '0xabc' }]),
              }),
            };
          }
          if (table === chatsTable) {
            return {
              where: () => ({
                limit: () => Promise.resolve([]),
              }),
            };
          }
          throw new Error('Unexpected select table');
        },
      }));

      await expect(ensureNftChatMembership('user-123')).rejects.toThrow(
        'Chat not found'
      );
    });

    it('should throw ValidationError when chat is not a group chat', async () => {
      mockHasOnchainNftAccess.mockResolvedValue(true);

      // Mock db.select returning non-group chat
      mockDbSelect.mockImplementation(() => ({
        from: (table: unknown) => {
          if (table === usersTable) {
            return {
              where: () => ({
                limit: () => Promise.resolve([{ walletAddress: '0xabc' }]),
              }),
            };
          }
          if (table === chatsTable) {
            return {
              where: () => ({
                limit: () =>
                  Promise.resolve([
                    { id: 'gated-chat', isGroup: false, groupId: null },
                  ]),
              }),
            };
          }
          throw new Error('Unexpected select table');
        },
      }));

      await expect(ensureNftChatMembership('user-123')).rejects.toThrow(
        'NFT gated chat is not a group chat'
      );
    });

    it('should create membership records for eligible user', async () => {
      mockHasOnchainNftAccess.mockResolvedValue(true);

      mockDbSelect.mockImplementation(() => ({
        from: (table: unknown) => {
          if (table === usersTable) {
            return {
              where: () => ({
                limit: () => Promise.resolve([{ walletAddress: '0xabc' }]),
              }),
            };
          }
          if (table === chatsTable) {
            return {
              where: () => ({
                limit: () =>
                  Promise.resolve([
                    { id: 'gated-chat', isGroup: true, groupId: 'group-123' },
                  ]),
              }),
            };
          }
          throw new Error('Unexpected select table');
        },
      }));

      let insertCalls = 0;
      mockDbTransaction.mockImplementation(async (callback: Function) => {
        const tx = {
          insert: () => {
            insertCalls++;
            return {
              values: () => ({
                onConflictDoUpdate: () => Promise.resolve(),
              }),
            };
          },
        };
        await callback(tx);
      });

      mockGenerateSnowflakeId.mockResolvedValue('new-id-123');

      const result = await ensureNftChatMembership('user-123');

      expect(result).toEqual({ success: true, chatId: 'gated-chat' });
      // Should insert into both groupMembers and chatParticipants
      expect(insertCalls).toBe(2);
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Ensured NFT gated chat membership',
        { userId: 'user-123', chatId: 'gated-chat' },
        'NFTChatGatingService'
      );
    });
  });

  describe('revokeNftChatMembershipIfNeeded', () => {
    beforeEach(() => {
      process.env.NFT_CHAT_GATING_ENABLED = 'true';
      process.env.NFT_CHAT_GATING_CHAT_ID = 'gated-chat';
    });

    it('should do nothing for non-gated chats', async () => {
      await revokeNftChatMembershipIfNeeded(
        'user-123',
        'regular-chat',
        'test reason'
      );
    });

    it('should not revoke if user still has NFT access', async () => {
      mockHasOnchainNftAccess.mockResolvedValue(true);
      mockDbSelect.mockImplementation(() => ({
        from: (table: unknown) => {
          if (table === usersTable) {
            return {
              where: () => ({
                limit: () => Promise.resolve([{ walletAddress: '0xabc' }]),
              }),
            };
          }
          throw new Error('Unexpected select table');
        },
      }));

      await revokeNftChatMembershipIfNeeded(
        'user-123',
        'gated-chat',
        'test reason'
      );

      expect(mockDbTransaction).not.toHaveBeenCalled();
    });

    it('should revoke membership when user loses NFT access', async () => {
      mockHasOnchainNftAccess.mockResolvedValue(false);

      // Mock db.select for chat lookup
      mockDbSelect.mockImplementation(() => ({
        from: (table: unknown) => {
          if (table === usersTable) {
            return {
              where: () => ({
                limit: () => Promise.resolve([{ walletAddress: '0xabc' }]),
              }),
            };
          }
          if (table === chatsTable) {
            return {
              where: () => ({
                limit: () => Promise.resolve([{ groupId: 'group-123' }]),
              }),
            };
          }
          throw new Error('Unexpected select table');
        },
      }));

      let updateCalls = 0;
      mockDbTransaction.mockImplementation(async (callback: Function) => {
        const tx = {
          update: () => {
            updateCalls++;
            return {
              set: () => ({
                where: () => Promise.resolve(),
              }),
            };
          },
        };
        await callback(tx);
      });

      await revokeNftChatMembershipIfNeeded(
        'user-123',
        'gated-chat',
        'Lost NFT access'
      );

      // Should update both chatParticipants and groupMembers
      expect(updateCalls).toBe(2);
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Revoked NFT gated chat membership',
        {
          userId: 'user-123',
          chatId: 'gated-chat',
          groupId: 'group-123',
          reason: 'Lost NFT access',
        },
        'NFTChatGatingService'
      );
    });

    it('should only update chatParticipants when chat has no groupId', async () => {
      mockHasOnchainNftAccess.mockResolvedValue(false);

      // Mock db.select returning chat without groupId
      mockDbSelect.mockImplementation(() => ({
        from: (table: unknown) => {
          if (table === usersTable) {
            return {
              where: () => ({
                limit: () => Promise.resolve([{ walletAddress: '0xabc' }]),
              }),
            };
          }
          if (table === chatsTable) {
            return {
              where: () => ({
                limit: () => Promise.resolve([{ groupId: null }]),
              }),
            };
          }
          throw new Error('Unexpected select table');
        },
      }));

      let updateCalls = 0;
      mockDbTransaction.mockImplementation(async (callback: Function) => {
        const tx = {
          update: () => {
            updateCalls++;
            return {
              set: () => ({
                where: () => Promise.resolve(),
              }),
            };
          },
        };
        await callback(tx);
      });

      await revokeNftChatMembershipIfNeeded(
        'user-123',
        'gated-chat',
        'Lost NFT access'
      );

      // Should only update chatParticipants (not groupMembers)
      expect(updateCalls).toBe(1);
    });
  });
});

describe('NFT Chat Gating - Integration Scenarios', () => {
  beforeEach(() => {
    mockHasOnchainNftAccess.mockReset();
    delete process.env.NFT_CHAT_GATING_ENABLED;
    delete process.env.NFT_CHAT_GATING_CHAT_ID;
  });

  describe('Complete Access Flow', () => {
    it('should handle the full access check flow for eligible user', async () => {
      process.env.NFT_CHAT_GATING_ENABLED = 'true';
      process.env.NFT_CHAT_GATING_CHAT_ID = 'fd-alpha-chat';

      mockHasOnchainNftAccess.mockResolvedValue(true);
      mockDbSelect.mockImplementation(() => ({
        from: (table: unknown) => {
          if (table === usersTable) {
            return {
              where: () => ({
                limit: () => Promise.resolve([{ walletAddress: '0xabc' }]),
              }),
            };
          }
          throw new Error('Unexpected select table');
        },
      }));

      // Step 1: Check if chat is gated
      const isGated = isNftChatGatedChat('fd-alpha-chat');
      expect(isGated).toBe(true);

      // Step 2: Check access
      const canAccess = await canAccessNftChatGate('user-123', 'fd-alpha-chat');
      expect(canAccess).toBe(true);

      // Step 3: Require access (should not throw)
      await expect(
        requireNftChatAccess(
          { userId: 'user-123', dbUserId: 'user-123' },
          'fd-alpha-chat'
        )
      ).resolves.toBeUndefined();
    });

    it('should handle the full access check flow for ineligible user', async () => {
      process.env.NFT_CHAT_GATING_ENABLED = 'true';
      process.env.NFT_CHAT_GATING_CHAT_ID = 'fd-alpha-chat';

      mockHasOnchainNftAccess.mockResolvedValue(false);
      mockDbSelect.mockImplementation(() => ({
        from: (table: unknown) => {
          if (table === usersTable) {
            return {
              where: () => ({
                limit: () => Promise.resolve([{ walletAddress: '0xabc' }]),
              }),
            };
          }
          throw new Error('Unexpected select table');
        },
      }));

      // Step 1: Check if chat is gated
      const isGated = isNftChatGatedChat('fd-alpha-chat');
      expect(isGated).toBe(true);

      // Step 2: Check access
      const canAccess = await canAccessNftChatGate('user-123', 'fd-alpha-chat');
      expect(canAccess).toBe(false);

      // Step 3: Require access (should throw)
      await expect(
        requireNftChatAccess({ userId: 'user-123' }, 'fd-alpha-chat')
      ).rejects.toThrow('NFT chat access required');
    });

    it('should bypass gating for regular chats', async () => {
      process.env.NFT_CHAT_GATING_ENABLED = 'true';
      process.env.NFT_CHAT_GATING_CHAT_ID = 'fd-alpha-chat';

      // Even without NFT access, regular chats should be accessible
      mockHasOnchainNftAccess.mockResolvedValue(false);

      // Step 1: Check if chat is gated
      const isGated = isNftChatGatedChat('regular-chat');
      expect(isGated).toBe(false);

      // Step 2: Check access (should return true without checking NFT)
      const canAccess = await canAccessNftChatGate('user-123', 'regular-chat');
      expect(canAccess).toBe(true);
      expect(mockHasOnchainNftAccess).not.toHaveBeenCalled();

      // Step 3: Require access (should not throw)
      await expect(
        requireNftChatAccess({ userId: 'user-123' }, 'regular-chat')
      ).resolves.toBeUndefined();
    });
  });

  describe('Feature Flag Scenarios', () => {
    it('should disable all gating when feature flag is off', async () => {
      process.env.NFT_CHAT_GATING_ENABLED = 'false';
      process.env.NFT_CHAT_GATING_CHAT_ID = 'fd-alpha-chat';

      // Even for the configured chat ID, gating should be disabled
      expect(isNftChatGatedChat('fd-alpha-chat')).toBe(false);

      const canAccess = await canAccessNftChatGate('user-123', 'fd-alpha-chat');
      expect(canAccess).toBe(true);
      expect(mockHasOnchainNftAccess).not.toHaveBeenCalled();
    });

    it('should handle missing chat ID gracefully', async () => {
      process.env.NFT_CHAT_GATING_ENABLED = 'true';
      // NFT_CHAT_GATING_CHAT_ID not set

      expect(isNftChatGatedChat('any-chat')).toBe(false);

      const canAccess = await canAccessNftChatGate('user-123', 'any-chat');
      expect(canAccess).toBe(true);
    });
  });

  describe('Agent Bypass Scenarios', () => {
    it('should not allow agents to access gated chats', async () => {
      process.env.NFT_CHAT_GATING_ENABLED = 'true';
      process.env.NFT_CHAT_GATING_CHAT_ID = 'fd-alpha-chat';

      mockDbSelect.mockImplementation(() => ({
        from: (table: unknown) => {
          if (table === usersTable) {
            return {
              where: () => ({
                limit: () => Promise.resolve([]),
              }),
            };
          }
          throw new Error('Unexpected select table');
        },
      }));

      const user = { userId: 'agent-123', isAgent: true };
      await expect(requireNftChatAccess(user, 'fd-alpha-chat')).rejects.toThrow(
        'NFT chat access required'
      );
    });
  });
});
