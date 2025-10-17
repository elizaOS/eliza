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
      getConnection: mock(async () => ({
        query: mock(async () => ({ rows: [] })),
      })),
    } as unknown as IAgentRuntime;
  });

  describe('summarizationEvaluator', () => {
    it('should have correct metadata', () => {
      expect(summarizationEvaluator.name).toBe('MEMORY_SUMMARIZATION');
      expect(summarizationEvaluator.description).toContain('Summarizes conversations');
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

      // Not reached threshold (default is 5)
      mockRuntime.countMemories = mock(async () => 4);
      expect(await summarizationEvaluator.validate(mockRuntime, message)).toBe(false);

      // Reach threshold
      mockRuntime.countMemories = mock(async () => 5);
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

    it('should validate every 5 messages from user (default interval)', async () => {
      await mockMemoryService.initialize(mockRuntime);

      const message: Memory = {
        id: 'msg-1' as UUID,
        entityId: 'user-1' as UUID,
        roomId: 'room-1' as UUID,
        content: { text: 'I am a developer' },
        createdAt: Date.now(),
      };

      // Mock countMemories to return appropriate counts
      // At exactly 5 messages, should trigger
      mockRuntime.countMemories = mock(async () => 5);
      expect(await longTermExtractionEvaluator.validate(mockRuntime, message)).toBe(true);

      // At exactly 10 messages, should trigger again
      mockRuntime.countMemories = mock(async () => 10);
      expect(await longTermExtractionEvaluator.validate(mockRuntime, message)).toBe(true);

      // At 4 messages, should not trigger yet
      mockRuntime.countMemories = mock(async () => 4);
      expect(await longTermExtractionEvaluator.validate(mockRuntime, message)).toBe(false);
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
