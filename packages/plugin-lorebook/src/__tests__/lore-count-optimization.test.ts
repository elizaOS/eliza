import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { LoreService } from '../services/lore-service';
import type { IAgentRuntime, LoreEntry } from '@elizaos/core';
import { loreProvider } from '../providers/lore-provider';
import type { Memory } from '@elizaos/core';

/**
 * Test suite for lore count optimization
 * Verifies that the system efficiently skips processing when no lore exists
 */
describe('LoreService Count Optimization', () => {
  let mockRuntime: Partial<IAgentRuntime>;
  let mockDb: any;
  let loreService: LoreService;

  beforeEach(() => {
    // Mock database
    mockDb = {
      select: mock().mockReturnThis(),
      from: mock().mockReturnThis(),
      where: mock().mockReturnThis(),
      orderBy: mock().mockReturnThis(),
      limit: mock().mockReturnThis(),
      innerJoin: mock().mockReturnThis(),
      insert: mock().mockReturnThis(),
      values: mock().mockReturnThis(),
      transaction: mock((callback: (tx: any) => Promise<void>) => callback(mockDb)),
    };

    // Mock runtime
    mockRuntime = {
      agentId: 'test-agent-id' as any,
      character: {
        name: 'Test Character',
        lore: [],
      },
      db: mockDb,
      logger: {
        info: mock(),
        warn: mock(),
        error: mock(),
        debug: mock(),
      },
      getModel: mock().mockReturnValue(null),
      useModel: mock(),
      getService: mock(),
      getSetting: mock(),
    } as any;

    loreService = new LoreService(mockRuntime as IAgentRuntime);
  });

  describe('getLoreCount', () => {
    it('should return 0 when no lore entries exist', async () => {
      // Mock database to return count of 0
      mockDb.select.mockReturnValue({
        from: mock().mockReturnValue({
          where: mock().mockResolvedValue([{ count: 0 }]),
        }),
      });

      const count = await loreService.getLoreCount();
      expect(count).toBe(0);
    });

    it('should return correct count when lore entries exist', async () => {
      // Mock database to return count of 5
      mockDb.select.mockReturnValue({
        from: mock().mockReturnValue({
          where: mock().mockResolvedValue([{ count: 5 }]),
        }),
      });

      const count = await loreService.getLoreCount();
      expect(count).toBe(5);
    });

    it('should use cached count on subsequent calls', async () => {
      // Mock database to return count of 3
      const mockQuery = mock().mockResolvedValue([{ count: 3 }]);
      mockDb.select.mockReturnValue({
        from: mock().mockReturnValue({
          where: mockQuery,
        }),
      });

      // First call - should hit database
      const count1 = await loreService.getLoreCount();
      expect(count1).toBe(3);
      expect(mockQuery).toHaveBeenCalledTimes(1);

      // Second call - should use cache
      const count2 = await loreService.getLoreCount();
      expect(count2).toBe(3);
      expect(mockQuery).toHaveBeenCalledTimes(1); // Still only called once
    });

    it('should refresh cache after storing new lore entry', async () => {
      // Initial count: 0
      let currentCount = 0;
      const mockQuery = mock().mockImplementation(() => {
        return Promise.resolve([{ count: currentCount }]);
      });

      mockDb.select.mockReturnValue({
        from: mock().mockReturnValue({
          where: mockQuery,
        }),
      });

      // Setup mock for embedding model
      mockRuntime.getModel = mock().mockReturnValue({ modelType: 'TEXT_EMBEDDING' });
      mockRuntime.useModel = mock().mockResolvedValue(new Array(768).fill(0.1));

      // Initial count should be 0
      const initialCount = await loreService.getLoreCount();
      expect(initialCount).toBe(0);

      // Store a new entry
      currentCount = 1;
      const loreEntry: LoreEntry = {
        loreKey: 'test-lore',
        vectorText: 'test vector text',
        content: 'test content',
        metadata: {},
      };

      await loreService.storeLoreEntry(loreEntry);

      // Count should be refreshed
      const newCount = await loreService.getLoreCount();
      expect(newCount).toBe(1);
    });
  });

  describe('Lore Provider Optimization', () => {
    it('should skip search when lore count is 0', async () => {
      const mockLoreService = {
        getLoreCount: mock().mockResolvedValue(0),
        searchLore: mock(),
      };

      const testRuntime = {
        ...mockRuntime,
        getService: mock().mockReturnValue(mockLoreService),
        logger: {
          info: mock(),
          warn: mock(),
          error: mock(),
          debug: mock(),
        },
      } as any;

      const mockMessage: Memory = {
        id: 'test-message-id' as any,
        roomId: 'test-room-id' as any,
        entityId: 'test-user-id' as any,
        agentId: 'test-agent-id' as any,
        content: {
          text: 'Tell me about relationships',
        },
        createdAt: Date.now(),
      };

      const result = await loreProvider.get(testRuntime, mockMessage, {} as any);

      // Should call getLoreCount
      expect(mockLoreService.getLoreCount).toHaveBeenCalled();

      // Should NOT call searchLore (optimization working)
      expect(mockLoreService.searchLore).not.toHaveBeenCalled();

      // Should return empty result
      expect(result.text).toBe('');
      expect(result.values?.hasLore).toBe(false);
      expect(result.values?.loreCount).toBe(0);
      expect(result.data?.loreEntries).toEqual([]);
    });

    it('should proceed with search when lore count > 0', async () => {
      const mockSearchResults = [
        {
          id: 'lore-1' as any,
          agentId: 'test-agent-id' as any,
          loreKey: 'test-lore',
          vectorText: 'test vector',
          content: 'test content',
          metadata: {},
          similarity: 0.9,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ];

      const mockLoreService = {
        getLoreCount: mock().mockResolvedValue(5),
        searchLore: mock().mockResolvedValue(mockSearchResults),
      };

      const testRuntime = {
        ...mockRuntime,
        getService: mock().mockReturnValue(mockLoreService),
        logger: {
          info: mock(),
          warn: mock(),
          error: mock(),
          debug: mock(),
        },
      } as any;

      const mockMessage: Memory = {
        id: 'test-message-id' as any,
        roomId: 'test-room-id' as any,
        entityId: 'test-user-id' as any,
        agentId: 'test-agent-id' as any,
        content: {
          text: 'Tell me about relationships',
        },
        createdAt: Date.now(),
      };

      const result = await loreProvider.get(testRuntime, mockMessage, {} as any);

      // Should call getLoreCount
      expect(mockLoreService.getLoreCount).toHaveBeenCalled();

      // Should call searchLore (count > 0)
      expect(mockLoreService.searchLore).toHaveBeenCalled();

      // Should return populated result
      expect(result.text).not.toBe('');
      expect(result.values?.hasLore).toBe(true);
      expect(result.values?.loreCount).toBe(1);
      expect(result.data?.loreEntries).toHaveLength(1);
    });
  });

  describe('Cache invalidation', () => {
    it('should refresh cache after deleting lore entry', async () => {
      let currentCount = 3;
      const mockQuery = mock().mockImplementation(() => {
        return Promise.resolve([{ count: currentCount }]);
      });

      mockDb.select.mockReturnValue({
        from: mock().mockReturnValue({
          where: mockQuery,
        }),
      });

      mockDb.delete = mock().mockReturnThis();

      const initialCount = await loreService.getLoreCount();
      expect(initialCount).toBe(3);

      // Delete an entry
      currentCount = 2;
      await loreService.deleteLoreEntry('test-lore-id' as any);

      // Count should be refreshed
      const newCount = await loreService.getLoreCount();
      expect(newCount).toBe(2);
    });

    it('should refresh cache after deleting all lore', async () => {
      let currentCount = 5;
      const mockQuery = mock().mockImplementation(() => {
        return Promise.resolve([{ count: currentCount }]);
      });

      mockDb.select.mockReturnValue({
        from: mock().mockReturnValue({
          where: mockQuery,
        }),
      });

      mockDb.delete = mock().mockReturnThis();

      const initialCount = await loreService.getLoreCount();
      expect(initialCount).toBe(5);

      // Mock the select for lore IDs
      mockDb.select.mockReturnValueOnce({
        from: mock().mockReturnValue({
          where: mock().mockResolvedValue([
            { id: 'id1' },
            { id: 'id2' },
            { id: 'id3' },
            { id: 'id4' },
            { id: 'id5' },
          ]),
        }),
      });

      // Delete all
      currentCount = 0;
      await loreService.deleteAllLore();

      // Count should be refreshed
      const newCount = await loreService.getLoreCount();
      expect(newCount).toBe(0);
    });
  });
});
