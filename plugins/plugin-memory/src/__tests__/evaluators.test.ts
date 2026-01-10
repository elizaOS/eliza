import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { summarizationEvaluator } from '../evaluators/summarization';
import { longTermExtractionEvaluator } from '../evaluators/long-term-extraction';
import { MemoryService } from '../services/memory-service';
import type { IAgentRuntime, Memory, UUID } from '@elizaos/core';

describe('Evaluators', () => {
  let mockRuntime: IAgentRuntime;
  let mockMemoryService: MemoryService;

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
      getMemories: mock(async () => []),
      countMemories: mock(async () => 0),
      getCache: mock(async () => undefined),
      setCache: mock(async () => {}),
      db: mockDb,
      getConnection: mock(async () => ({
        query: mock(async () => ({ rows: [] })),
      })),
    } as unknown as IAgentRuntime;
  });

  describe('summarizationEvaluator', () => {
    it('should have correct metadata', () => {
      expect(summarizationEvaluator.name).toBe('MEMORY_SUMMARIZATION');
      expect(summarizationEvaluator.description).toContain('summarizes conversations');
      expect(summarizationEvaluator.similes).toContain('CONVERSATION_SUMMARY');
    });

    it('should validate when threshold is reached', async () => {
      await mockMemoryService.initialize(mockRuntime);

      const message: Memory = {
        id: 'msg-1' as UUID,
        entityId: 'user-1' as UUID,
        roomId: 'room-1' as UUID,
        content: { text: 'Hello' },
        createdAt: Date.now(),
      };

      // Create 15 dialogue messages (below threshold)
      const createMessages = (count: number): Memory[] => {
        const messages: Memory[] = [];
        for (let i = 0; i < count; i++) {
          messages.push({
            id: `msg-${i}` as UUID,
            entityId: i % 2 === 0 ? 'user-1' as UUID : 'agent-1' as UUID,
            roomId: 'room-1' as UUID,
            content: { text: `Message ${i}` },
            metadata: { type: i % 2 === 0 ? 'user_message' : 'agent_response_message' },
            createdAt: Date.now() + i,
          });
        }
        return messages;
      };

      // Not reached threshold (default is 16)
      mockRuntime.getMemories = mock(async () => createMessages(15));
      expect(await summarizationEvaluator.validate(mockRuntime, message)).toBe(false);

      // Reach threshold
      mockRuntime.getMemories = mock(async () => createMessages(16));
      expect(await summarizationEvaluator.validate(mockRuntime, message)).toBe(true);
    });

    it('should not validate messages without text', async () => {
      await mockMemoryService.initialize(mockRuntime);

      const message: Memory = {
        id: 'msg-1' as UUID,
        entityId: 'user-1' as UUID,
        roomId: 'room-1' as UUID,
        content: {},
        createdAt: Date.now(),
      };

      // Even with threshold reached
      mockRuntime.countMemories = mock(async () => 50);

      expect(await summarizationEvaluator.validate(mockRuntime, message)).toBe(false);
    });

    it('should not validate when service is not available', async () => {
      mockRuntime.getService = mock(() => null);

      const message: Memory = {
        id: 'msg-1' as UUID,
        entityId: 'user-1' as UUID,
        roomId: 'room-1' as UUID,
        content: { text: 'Hello' },
        createdAt: Date.now(),
      };

      expect(await summarizationEvaluator.validate(mockRuntime, message)).toBe(false);
    });
  });

  describe('longTermExtractionEvaluator', () => {
    it('should have correct metadata', () => {
      expect(longTermExtractionEvaluator.name).toBe('LONG_TERM_MEMORY_EXTRACTION');
      expect(longTermExtractionEvaluator.description).toContain('long-term facts');
      expect(longTermExtractionEvaluator.similes).toContain('MEMORY_EXTRACTION');
    });

    it('should validate every 10 messages from user (default interval)', async () => {
      await mockMemoryService.initialize(mockRuntime);

      const message: Memory = {
        id: 'msg-1' as UUID,
        entityId: 'user-1' as UUID,
        roomId: 'room-1' as UUID,
        content: { text: 'I am a developer' },
        createdAt: Date.now(),
      };

      // Mock countMemories to return appropriate counts
      // Below threshold (30), should not trigger
      mockRuntime.countMemories = mock(async () => 29);
      expect(await longTermExtractionEvaluator.validate(mockRuntime, message)).toBe(false);

      // At exactly 30 messages (threshold), should trigger
      mockRuntime.countMemories = mock(async () => 30);
      expect(await longTermExtractionEvaluator.validate(mockRuntime, message)).toBe(true);

      // At exactly 40 messages (next interval), should trigger again
      mockRuntime.countMemories = mock(async () => 40);
      expect(await longTermExtractionEvaluator.validate(mockRuntime, message)).toBe(true);
    });

    it('should not validate agent messages', async () => {
      await mockMemoryService.initialize(mockRuntime);

      const message: Memory = {
        id: 'msg-1' as UUID,
        entityId: mockRuntime.agentId,
        roomId: 'room-1' as UUID,
        content: { text: 'Hello' },
        createdAt: Date.now(),
      };

      mockRuntime.countMemories = mock(async () => 10);
      expect(await longTermExtractionEvaluator.validate(mockRuntime, message)).toBe(false);
    });

    it('should not validate when extraction is disabled', async () => {
      await mockMemoryService.initialize(mockRuntime);
      mockMemoryService.updateConfig({ longTermExtractionEnabled: false });

      const message: Memory = {
        id: 'msg-1' as UUID,
        entityId: 'user-1' as UUID,
        roomId: 'room-1' as UUID,
        content: { text: 'I am a developer' },
        createdAt: Date.now(),
      };

      mockRuntime.countMemories = mock(async () => 10);
      expect(await longTermExtractionEvaluator.validate(mockRuntime, message)).toBe(false);
    });

    it('should not validate messages without text', async () => {
      await mockMemoryService.initialize(mockRuntime);

      const message: Memory = {
        id: 'msg-1' as UUID,
        entityId: 'user-1' as UUID,
        roomId: 'room-1' as UUID,
        content: {},
        createdAt: Date.now(),
      };

      mockRuntime.countMemories = mock(async () => 10);
      expect(await longTermExtractionEvaluator.validate(mockRuntime, message)).toBe(false);
    });
  });
});
