import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { rememberAction } from '../actions/remember';
import { MemoryService } from '../services/memory-service';
import type { IAgentRuntime, Memory, UUID } from '@elizaos/core';

describe('rememberAction', () => {
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
      getConnection: mock(async () => ({
        query: mock(async () => ({ rows: [] })),
      })),
    } as unknown as IAgentRuntime;

    mockMemoryService.initialize(mockRuntime);
  });

  describe('metadata', () => {
    it('should have correct metadata', () => {
      expect(rememberAction.name).toBe('REMEMBER');
      expect(rememberAction.description).toContain('long-term memory');
      expect(rememberAction.similes).toBeDefined();
      expect(Array.isArray(rememberAction.similes)).toBe(true);
      expect(rememberAction.similes?.includes('REMEMBER_THIS')).toBe(true);
      expect(rememberAction.similes?.includes('KEEP_IN_MIND')).toBe(true);
    });
  });

  describe('validation', () => {
    it('should validate messages with "remember"', async () => {
      const message: Memory = {
        id: 'msg-1' as UUID,
        entityId: 'user-1' as UUID,
        roomId: 'room-1' as UUID,
        content: { text: 'Remember that I prefer TypeScript' },
        createdAt: Date.now(),
      };

      expect(await rememberAction.validate(mockRuntime, message)).toBe(true);
    });

    it('should validate messages with "keep in mind"', async () => {
      const message: Memory = {
        id: 'msg-1' as UUID,
        entityId: 'user-1' as UUID,
        roomId: 'room-1' as UUID,
        content: { text: 'Keep in mind that I am a developer' },
        createdAt: Date.now(),
      };

      expect(await rememberAction.validate(mockRuntime, message)).toBe(true);
    });

    it('should validate messages with "don\'t forget"', async () => {
      const message: Memory = {
        id: 'msg-1' as UUID,
        entityId: 'user-1' as UUID,
        roomId: 'room-1' as UUID,
        content: { text: "Don't forget I use Python" },
        createdAt: Date.now(),
      };

      expect(await rememberAction.validate(mockRuntime, message)).toBe(true);
    });

    it('should not validate messages without memory keywords', async () => {
      const message: Memory = {
        id: 'msg-1' as UUID,
        entityId: 'user-1' as UUID,
        roomId: 'room-1' as UUID,
        content: { text: 'Hello, how are you?' },
        createdAt: Date.now(),
      };

      expect(await rememberAction.validate(mockRuntime, message)).toBe(false);
    });

    it('should validate with case insensitive matching', async () => {
      const message: Memory = {
        id: 'msg-1' as UUID,
        entityId: 'user-1' as UUID,
        roomId: 'room-1' as UUID,
        content: { text: 'REMEMBER THIS FACT' },
        createdAt: Date.now(),
      };

      expect(await rememberAction.validate(mockRuntime, message)).toBe(true);
    });
  });

  describe('examples', () => {
    it('should have valid examples', () => {
      expect(rememberAction.examples).toBeDefined();
      expect(rememberAction.examples!.length).toBeGreaterThan(0);

      // Check first example
      const firstExample = rememberAction.examples![0];
      expect(firstExample).toHaveLength(2);
      expect(firstExample[0].content.text).toContain('Remember');
      expect(firstExample[1].content.action).toBe('REMEMBER');
    });
  });

  describe('error handling', () => {
    it('should return error when service is not available', async () => {
      mockRuntime.getService = mock(() => null);

      const message: Memory = {
        id: 'msg-1' as UUID,
        entityId: 'user-1' as UUID,
        roomId: 'room-1' as UUID,
        content: { text: 'Remember this' },
        createdAt: Date.now(),
      };

      const result = await rememberAction.handler(mockRuntime, message);

      if (!result) {
        throw new Error('Result should be defined');
      }
      expect(result.success).toBe(false);
      expect(result.data?.error).toBe('Memory service not available');
    });
  });
});
