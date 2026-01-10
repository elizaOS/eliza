import { describe, it, expect, beforeEach, vi } from "vitest";
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
      insert: vi.fn(() => ({
        values: vi.fn(async () => {}),
      })),
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            orderBy: vi.fn(() => ({
              limit: vi.fn(async () => []),
            })),
            limit: vi.fn(async () => []),
          })),
        })),
      })),
      update: vi.fn(() => ({
        set: vi.fn(() => ({
          where: vi.fn(async () => {}),
        })),
      })),
      delete: vi.fn(() => ({
        where: vi.fn(async () => {}),
      })),
    };

    mockRuntime = {
      agentId: 'test-agent' as UUID,
      character: { name: 'TestAgent' },
      getSetting: vi.fn(() => undefined),
      getService: vi.fn((name: string) => {
        if (name === 'memory') return mockMemoryService;
        return null;
      }),
      getMemories: vi.fn(async () => []),
      countMemories: vi.fn(async () => 0),
      getCache: vi.fn(async () => undefined),
      setCache: vi.fn(async () => {}),
      db: mockDb,
      getConnection: vi.fn(async () => ({
        query: vi.fn(async () => ({ rows: [] })),
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
      mockRuntime.getMemories = vi.fn(async () => createMessages(15));
      expect(await summarizationEvaluator.validate(mockRuntime, message)).toBe(false);

      // Reach threshold
      mockRuntime.getMemories = vi.fn(async () => createMessages(16));
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
      mockRuntime.countMemories = vi.fn(async () => 50);

      expect(await summarizationEvaluator.validate(mockRuntime, message)).toBe(false);
    });

    it('should not validate when service is not available', async () => {
      mockRuntime.getService = vi.fn(() => null);

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
      mockRuntime.countMemories = vi.fn(async () => 29);
      expect(await longTermExtractionEvaluator.validate(mockRuntime, message)).toBe(false);

      // At exactly 30 messages (threshold), should trigger
      mockRuntime.countMemories = vi.fn(async () => 30);
      expect(await longTermExtractionEvaluator.validate(mockRuntime, message)).toBe(true);

      // At exactly 40 messages (next interval), should trigger again
      mockRuntime.countMemories = vi.fn(async () => 40);
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

      mockRuntime.countMemories = vi.fn(async () => 10);
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

      mockRuntime.countMemories = vi.fn(async () => 10);
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

      mockRuntime.countMemories = vi.fn(async () => 10);
      expect(await longTermExtractionEvaluator.validate(mockRuntime, message)).toBe(false);
    });
  });
});
