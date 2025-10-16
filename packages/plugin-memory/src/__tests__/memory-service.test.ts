import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { MemoryService } from '../services/memory-service';
import { LongTermMemoryCategory } from '../types/index';
import type { IAgentRuntime, UUID } from '@elizaos/core';

describe('MemoryService', () => {
  let service: MemoryService;
  let mockRuntime: IAgentRuntime;

  beforeEach(() => {
    service = new MemoryService();

    // Create mock runtime
    mockRuntime = {
      agentId: 'test-agent-id' as UUID,
      getSetting: mock(() => undefined),
      getConnection: mock(async () => ({
        query: mock(async () => ({ rows: [] })),
      })),
    } as unknown as IAgentRuntime;
  });

  describe('initialization', () => {
    it('should initialize with default config', async () => {
      await service.initialize(mockRuntime);

      const config = service.getConfig();
      expect(config.shortTermSummarizationThreshold).toBe(50);
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

      // Increment to threshold
      for (let i = 0; i < 49; i++) {
        service.incrementMessageCount(roomId);
        expect(service.shouldSummarize(roomId)).toBe(false);
      }

      service.incrementMessageCount(roomId);
      expect(service.shouldSummarize(roomId)).toBe(true);
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

      // Verify database connection was called
      expect(mockRuntime.getConnection).toHaveBeenCalled();
    });

    it('should retrieve long-term memories', async () => {
      const entityId = 'user-1' as UUID;

      // Mock database response
      mockRuntime.getConnection = mock(async () => ({
        query: mock(async () => ({
          rows: [
            {
              id: 'mem-1',
              agent_id: mockRuntime.agentId,
              entity_id: entityId,
              category: LongTermMemoryCategory.PREFERENCES,
              content: 'User prefers TypeScript',
              metadata: {},
              confidence: 0.9,
              source: 'manual',
              created_at: Date.now(),
              updated_at: Date.now(),
              access_count: 0,
            },
          ],
        })),
      }));

      const memories = await service.getLongTermMemories(entityId);

      expect(memories).toHaveLength(1);
      expect(memories[0].content).toBe('User prefers TypeScript');
      expect(memories[0].category).toBe(LongTermMemoryCategory.PREFERENCES);
    });

    it('should filter by category', async () => {
      const entityId = 'user-1' as UUID;

      await service.getLongTermMemories(entityId, LongTermMemoryCategory.EXPERTISE, 5);

      expect(mockRuntime.getConnection).toHaveBeenCalled();
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
        startTime: new Date(Date.now() - 3600000),
        endTime: new Date(),
        topics: ['TypeScript', 'Features'],
      });

      expect(summary.id).toBeDefined();
      expect(summary.summary).toBe('Discussion about TypeScript features');
      expect(summary.messageCount).toBe(25);
      expect(summary.topics).toEqual(['TypeScript', 'Features']);
      expect(summary.createdAt).toBeDefined();
    });

    it('should retrieve session summaries', async () => {
      const roomId = 'room-1' as UUID;

      mockRuntime.getConnection = mock(async () => ({
        query: mock(async () => ({
          rows: [
            {
              id: 'summary-1',
              agent_id: mockRuntime.agentId,
              room_id: roomId,
              summary: 'Test summary',
              message_count: 25,
              start_time: Date.now() - 3600000,
              end_time: Date.now(),
              topics: ['test'],
              metadata: {},
              created_at: Date.now(),
            },
          ],
        })),
      }));

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

      mockRuntime.getConnection = mock(async () => ({
        query: mock(async () => ({
          rows: [
            {
              id: 'mem-1',
              agent_id: mockRuntime.agentId,
              entity_id: entityId,
              category: LongTermMemoryCategory.IDENTITY,
              content: 'User is a software engineer',
              metadata: {},
              confidence: 0.95,
              created_at: Date.now(),
              updated_at: Date.now(),
              access_count: 0,
            },
            {
              id: 'mem-2',
              agent_id: mockRuntime.agentId,
              entity_id: entityId,
              category: LongTermMemoryCategory.PREFERENCES,
              content: 'Prefers concise responses',
              metadata: {},
              confidence: 0.85,
              created_at: Date.now(),
              updated_at: Date.now(),
              access_count: 0,
            },
          ],
        })),
      }));

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
