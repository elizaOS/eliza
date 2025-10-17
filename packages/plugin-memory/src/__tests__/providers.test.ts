import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { shortTermMemoryProvider } from '../providers/short-term-memory';
import { longTermMemoryProvider } from '../providers/long-term-memory';
import { MemoryService } from '../services/memory-service';
import { LongTermMemoryCategory } from '../types/index';
import type { IAgentRuntime, Memory, UUID, State } from '@elizaos/core';

describe('Providers', () => {
  let mockRuntime: IAgentRuntime;
  let mockMemoryService: MemoryService;
  let mockState: State;

  beforeEach(() => {
    mockMemoryService = new MemoryService();

    // Create mock database
    const mockDb = {
      insert: mock(() => ({
        values: mock(async () => {}),
      })),
      select: mock(() => ({
        from: mock(() => ({
          where: mock(() => ({
            orderBy: mock(() => ({
              limit: mock(async () => []),
            })),
            limit: mock(async () => []),
          })),
        })),
      })),
      update: mock(() => ({
        set: mock(() => ({
          where: mock(async () => {}),
        })),
      })),
      delete: mock(() => ({
        where: mock(async () => {}),
      })),
    };

    mockRuntime = {
      agentId: 'test-agent' as UUID,
      character: { name: 'TestAgent' },
      getSetting: mock(() => undefined),
      getService: mock((name: string) => {
        if (name === 'memory') return mockMemoryService;
        return null;
      }),
      db: mockDb,
      getConnection: mock(async () => ({
        query: mock(async () => ({ rows: [] })),
      })),
    } as unknown as IAgentRuntime;

    mockState = {} as State;

    mockMemoryService.initialize(mockRuntime);
  });

  describe('shortTermMemoryProvider', () => {
    it('should have correct metadata', () => {
      expect(shortTermMemoryProvider.name).toBe('SHORT_TERM_MEMORY');
      expect(shortTermMemoryProvider.description).toContain('summaries');
      expect(shortTermMemoryProvider.position).toBe(95);
    });

    it('should return empty when no summaries exist', async () => {
      const message: Memory = {
        id: 'msg-1' as UUID,
        entityId: 'user-1' as UUID,
        roomId: 'room-1' as UUID,
        content: { text: 'Hello' },
        createdAt: Date.now(),
      };

      const result = await shortTermMemoryProvider.get(mockRuntime, message, mockState);

      expect(result.data?.summaries).toEqual([]);
      expect(result.text).toBe('');
    });

    it('should format session summaries', async () => {
      const message: Memory = {
        id: 'msg-1' as UUID,
        entityId: 'user-1' as UUID,
        roomId: 'room-1' as UUID,
        content: { text: 'Hello' },
        createdAt: Date.now(),
      };

      // Mock database to return summaries
      const mockSummaryData = [
        {
          id: 'summary-1',
          agentId: mockRuntime.agentId,
          roomId: message.roomId,
          summary: 'Discussed TypeScript features',
          messageCount: 25,
          lastMessageOffset: 25,
          startTime: new Date(Date.now() - 3600000),
          endTime: new Date(),
          topics: ['TypeScript', 'Features'],
          metadata: {},
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ];

      (mockRuntime as any).db = {
        select: mock(() => ({
          from: mock(() => ({
            where: mock(() => ({
              orderBy: mock(() => ({
                limit: mock(async () => mockSummaryData),
              })),
            })),
          })),
        })),
      };

      const result = await shortTermMemoryProvider.get(mockRuntime, message, mockState);

      expect(result.data?.summaries).toHaveLength(1);
      expect(result.text).toContain('Previous Conversation Context');
      expect(result.text).toContain('Discussed TypeScript features');
      expect(result.text).toContain('25 messages');
    });

    it('should return empty when service is not available', async () => {
      mockRuntime.getService = mock(() => null);

      const message: Memory = {
        id: 'msg-1' as UUID,
        entityId: 'user-1' as UUID,
        roomId: 'room-1' as UUID,
        content: { text: 'Hello' },
        createdAt: Date.now(),
      };

      const result = await shortTermMemoryProvider.get(mockRuntime, message, mockState);

      expect(result.data?.summaries).toEqual([]);
      expect(result.text).toBe('');
    });
  });

  describe('longTermMemoryProvider', () => {
    it('should have correct metadata', () => {
      expect(longTermMemoryProvider.name).toBe('LONG_TERM_MEMORY');
      expect(longTermMemoryProvider.description).toContain('Persistent facts');
      expect(longTermMemoryProvider.position).toBe(50);
    });

    it('should return empty for agent messages', async () => {
      const message: Memory = {
        id: 'msg-1' as UUID,
        entityId: mockRuntime.agentId,
        roomId: 'room-1' as UUID,
        content: { text: 'Hello' },
        createdAt: Date.now(),
      };

      const result = await longTermMemoryProvider.get(mockRuntime, message, mockState);

      expect(result.data?.memories).toEqual([]);
      expect(result.text).toBe('');
    });

    it('should return empty when no memories exist', async () => {
      const message: Memory = {
        id: 'msg-1' as UUID,
        entityId: 'user-1' as UUID,
        roomId: 'room-1' as UUID,
        content: { text: 'Hello' },
        createdAt: Date.now(),
      };

      const result = await longTermMemoryProvider.get(mockRuntime, message, mockState);

      expect(result.data?.memories).toEqual([]);
      expect(result.text).toBe('');
    });

    it('should format long-term memories by category', async () => {
      const message: Memory = {
        id: 'msg-1' as UUID,
        entityId: 'user-1' as UUID,
        roomId: 'room-1' as UUID,
        content: { text: 'Hello' },
        createdAt: Date.now(),
      };

      // Mock database to return memories
      const mockMemoryData = [
        {
          id: 'mem-1',
          agentId: mockRuntime.agentId,
          entityId: message.entityId,
          category: LongTermMemoryCategory.IDENTITY,
          content: 'User is a software engineer',
          metadata: {},
          confidence: 0.95,
          source: 'conversation',
          createdAt: new Date(),
          updatedAt: new Date(),
          lastAccessedAt: null,
          accessCount: 0,
          embedding: null,
        },
        {
          id: 'mem-2',
          agentId: mockRuntime.agentId,
          entityId: message.entityId,
          category: LongTermMemoryCategory.PREFERENCES,
          content: 'Prefers TypeScript',
          metadata: {},
          confidence: 0.85,
          source: 'conversation',
          createdAt: new Date(),
          updatedAt: new Date(),
          lastAccessedAt: null,
          accessCount: 0,
          embedding: null,
        },
      ];

      (mockRuntime as any).db = {
        select: mock(() => ({
          from: mock(() => ({
            where: mock(() => ({
              orderBy: mock(() => ({
                limit: mock(async () => mockMemoryData),
              })),
            })),
          })),
        })),
      };

      const result = await longTermMemoryProvider.get(mockRuntime, message, mockState);

      expect(result.data?.memories).toHaveLength(2);
      expect(result.text).toContain('What I Know About You');
      expect(result.text).toContain('Identity');
      expect(result.text).toContain('software engineer');
      expect(result.text).toContain('Preferences');
      expect(result.text).toContain('TypeScript');
      expect(result.values?.memoryCategories).toContain('identity: 1');
      expect(result.values?.memoryCategories).toContain('preferences: 1');
    });

    it('should return empty when service is not available', async () => {
      mockRuntime.getService = mock(() => null);

      const message: Memory = {
        id: 'msg-1' as UUID,
        entityId: 'user-1' as UUID,
        roomId: 'room-1' as UUID,
        content: { text: 'Hello' },
        createdAt: Date.now(),
      };

      const result = await longTermMemoryProvider.get(mockRuntime, message, mockState);

      expect(result.data?.memories).toEqual([]);
      expect(result.text).toBe('');
    });
  });
});
