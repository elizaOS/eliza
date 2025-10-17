import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { MemoryService } from '../services/memory-service';
import { LongTermMemoryCategory } from '../types/index';
import type { IAgentRuntime, UUID } from '@elizaos/core';

describe('MemoryService', () => {
  let service: MemoryService;
  let mockRuntime: IAgentRuntime;

  beforeEach(() => {
    service = new MemoryService();

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

    // Create mock runtime
    mockRuntime = {
      agentId: 'test-agent-id' as UUID,
      getSetting: mock(() => undefined),
      countMemories: mock(async () => 0),
      db: mockDb,
      getConnection: mock(async () => ({
        query: mock(async () => ({ rows: [] })),
      })),
    } as unknown as IAgentRuntime;
  });

  describe('initialization', () => {
    it('should initialize with default config', async () => {
      await service.initialize(mockRuntime);

      const config = service.getConfig();
      expect(config.shortTermSummarizationThreshold).toBe(5);
      expect(config.shortTermRetainRecent).toBe(10);
      expect(config.longTermExtractionEnabled).toBe(true);
      expect(config.longTermConfidenceThreshold).toBe(0.7);
    });

    it('should load config from runtime settings', async () => {
      mockRuntime.getSetting = mock((key: string) => {
        const settings: Record<string, string> = {
          MEMORY_SUMMARIZATION_THRESHOLD: '30',
          MEMORY_RETAIN_RECENT: '5',
          MEMORY_LONG_TERM_ENABLED: 'false',
          MEMORY_CONFIDENCE_THRESHOLD: '0.8',
        };
        return settings[key];
      });

      await service.initialize(mockRuntime);

      const config = service.getConfig();
      expect(config.shortTermSummarizationThreshold).toBe(30);
      expect(config.shortTermRetainRecent).toBe(5);
      expect(config.longTermExtractionEnabled).toBe(false);
      expect(config.longTermConfidenceThreshold).toBe(0.8);
    });
  });

  describe('message counting', () => {
    it('should track message count for rooms', () => {
      const roomId = 'room-1' as UUID;

      expect(service.incrementMessageCount(roomId)).toBe(1);
      expect(service.incrementMessageCount(roomId)).toBe(2);
      expect(service.incrementMessageCount(roomId)).toBe(3);
    });

    it('should reset message count', () => {
      const roomId = 'room-1' as UUID;

      service.incrementMessageCount(roomId);
      service.incrementMessageCount(roomId);
      service.resetMessageCount(roomId);

      expect(service.incrementMessageCount(roomId)).toBe(1);
    });

    it('should determine when summarization is needed', async () => {
      await service.initialize(mockRuntime);
      const roomId = 'room-1' as UUID;

      // Mock countMemories to return below threshold
      mockRuntime.countMemories = mock(async () => 4);
      expect(await service.shouldSummarize(roomId)).toBe(false);

      // Mock countMemories to return at threshold (default is 5)
      mockRuntime.countMemories = mock(async () => 5);
      expect(await service.shouldSummarize(roomId)).toBe(true);

      // Mock countMemories to return above threshold
      mockRuntime.countMemories = mock(async () => 10);
      expect(await service.shouldSummarize(roomId)).toBe(true);
    });
  });

  describe('configuration', () => {
    it('should update configuration', async () => {
      await service.initialize(mockRuntime);

      service.updateConfig({
        shortTermSummarizationThreshold: 100,
        longTermExtractionEnabled: false,
      });

      const config = service.getConfig();
      expect(config.shortTermSummarizationThreshold).toBe(100);
      expect(config.longTermExtractionEnabled).toBe(false);
      expect(config.shortTermRetainRecent).toBe(10); // unchanged
    });
  });

  describe('long-term memory storage', () => {
    beforeEach(async () => {
      await service.initialize(mockRuntime);
    });

    it('should store long-term memory', async () => {
      const memory = await service.storeLongTermMemory({
        agentId: mockRuntime.agentId,
        entityId: 'user-1' as UUID,
        category: LongTermMemoryCategory.PREFERENCES,
        content: 'User prefers TypeScript',
        confidence: 0.9,
        source: 'manual',
      });

      expect(memory.id).toBeDefined();
      expect(memory.category).toBe(LongTermMemoryCategory.PREFERENCES);
      expect(memory.content).toBe('User prefers TypeScript');
      expect(memory.confidence).toBe(0.9);
      expect(memory.createdAt).toBeDefined();
      expect(memory.updatedAt).toBeDefined();
    });

    it('should retrieve long-term memories', async () => {
      const entityId = 'user-1' as UUID;

      // Mock database to return memories
      const mockMemoryData = [
        {
          id: 'mem-1',
          agentId: mockRuntime.agentId,
          entityId: entityId,
          category: LongTermMemoryCategory.PREFERENCES,
          content: 'User prefers TypeScript',
          metadata: {},
          embedding: null,
          confidence: 0.9,
          source: 'manual',
          createdAt: new Date(),
          updatedAt: new Date(),
          lastAccessedAt: null,
          accessCount: 0,
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

      const memories = await service.getLongTermMemories(entityId);

      expect(memories).toHaveLength(1);
      expect(memories[0].content).toBe('User prefers TypeScript');
      expect(memories[0].category).toBe(LongTermMemoryCategory.PREFERENCES);
    });

    it('should filter by category', async () => {
      const entityId = 'user-1' as UUID;

      const memories = await service.getLongTermMemories(
        entityId,
        LongTermMemoryCategory.EXPERTISE,
        5
      );

      // Should return empty array when no memories match
      expect(memories).toEqual([]);
    });
  });

  describe('session summaries', () => {
    beforeEach(async () => {
      await service.initialize(mockRuntime);
    });

    it('should store session summary', async () => {
      const summary = await service.storeSessionSummary({
        agentId: mockRuntime.agentId,
        roomId: 'room-1' as UUID,
        summary: 'Discussion about TypeScript features',
        messageCount: 25,
        lastMessageOffset: 25,
        startTime: new Date(Date.now() - 3600000),
        endTime: new Date(),
        topics: ['TypeScript', 'Features'],
      });

      expect(summary.id).toBeDefined();
      expect(summary.summary).toBe('Discussion about TypeScript features');
      expect(summary.messageCount).toBe(25);
      expect(summary.lastMessageOffset).toBe(25);
      expect(summary.topics).toEqual(['TypeScript', 'Features']);
      expect(summary.createdAt).toBeDefined();
      expect(summary.updatedAt).toBeDefined();
    });

    it('should retrieve session summaries', async () => {
      const roomId = 'room-1' as UUID;

      const mockSummaryData = [
        {
          id: 'summary-1',
          agentId: mockRuntime.agentId,
          roomId: roomId,
          entityId: null,
          summary: 'Test summary',
          messageCount: 25,
          lastMessageOffset: 25,
          startTime: new Date(Date.now() - 3600000),
          endTime: new Date(),
          topics: ['test'],
          metadata: {},
          embedding: null,
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

      const summaries = await service.getSessionSummaries(roomId);

      expect(summaries).toHaveLength(1);
      expect(summaries[0].summary).toBe('Test summary');
    });
  });

  describe('formatted memories', () => {
    beforeEach(async () => {
      await service.initialize(mockRuntime);
    });

    it('should format long-term memories by category', async () => {
      const entityId = 'user-1' as UUID;

      const mockMemoryData = [
        {
          id: 'mem-1',
          agentId: mockRuntime.agentId,
          entityId: entityId,
          category: LongTermMemoryCategory.IDENTITY,
          content: 'User is a software engineer',
          metadata: {},
          embedding: null,
          confidence: 0.95,
          source: 'conversation',
          createdAt: new Date(),
          updatedAt: new Date(),
          lastAccessedAt: null,
          accessCount: 0,
        },
        {
          id: 'mem-2',
          agentId: mockRuntime.agentId,
          entityId: entityId,
          category: LongTermMemoryCategory.PREFERENCES,
          content: 'Prefers concise responses',
          metadata: {},
          embedding: null,
          confidence: 0.85,
          source: 'conversation',
          createdAt: new Date(),
          updatedAt: new Date(),
          lastAccessedAt: null,
          accessCount: 0,
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

      const formatted = await service.getFormattedLongTermMemories(entityId);

      expect(formatted).toContain('Identity');
      expect(formatted).toContain('User is a software engineer');
      expect(formatted).toContain('Preferences');
      expect(formatted).toContain('Prefers concise responses');
    });

    it('should return empty string when no memories', async () => {
      const entityId = 'user-1' as UUID;

      mockRuntime.getConnection = mock(async () => ({
        query: mock(async () => ({ rows: [] })),
      }));

      const formatted = await service.getFormattedLongTermMemories(entityId);

      expect(formatted).toBe('');
    });
  });
});
