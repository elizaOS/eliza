import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { AgentRuntime } from '../../runtime';
import { createMessageMemory, getMemoryText } from '../../memory';
import type { Character, Memory, UUID } from '../../types';
import { MemoryType } from '../../types';
import { v4 as uuidv4 } from 'uuid';
import { createMockAdapter } from '../test-helpers';
import type { IDatabaseAdapter } from '../../types';

describe('Memory-Runtime Integration Tests', () => {
  let runtime: AgentRuntime;
  let mockAdapter: IDatabaseAdapter;
  let testCharacter: Character;
  let agentId: UUID;
  let roomId: UUID;
  let entityId: UUID;

  beforeEach(() => {
    agentId = uuidv4() as UUID;
    roomId = uuidv4() as UUID;
    entityId = uuidv4() as UUID;

    testCharacter = {
      id: agentId,
      name: 'TestAgent',
      username: 'testagent',
      bio: [],
      messageExamples: [],
      postExamples: [],
      topics: [],
      style: { all: [], chat: [], post: [] },
      adjectives: [],
      settings: {},
    };

    mockAdapter = createMockAdapter();

    runtime = new AgentRuntime({
      character: testCharacter,
      adapter: mockAdapter,
    });
  });

  afterEach(() => {
    mock.restore();
  });

  describe('createMessageMemory with Runtime', () => {
    it('should create message memory compatible with runtime', () => {
      const memory = createMessageMemory({
        entityId,
        roomId,
        agentId,
        content: { text: 'Test message' },
      });

      expect(memory.entityId).toBe(entityId);
      expect(memory.roomId).toBe(roomId);
      expect(memory.agentId).toBe(agentId);
      expect(memory.content.text).toBe('Test message');
      expect(memory.metadata.scope).toBe('private');
    });

    it('should create shared memory when agentId is not provided', () => {
      const memory = createMessageMemory({
        entityId,
        roomId,
        content: { text: 'Shared message' },
      });

      expect(memory.metadata.scope).toBe('shared');
      expect(memory.agentId).toBeUndefined();
    });
  });

  describe('getMemoryText with Runtime', () => {
    it('should extract text from memory for runtime processing', () => {
      const memory: Memory = {
        id: uuidv4() as UUID,
        entityId,
        roomId,
        content: { text: 'Hello, runtime!' },
        createdAt: Date.now(),
        metadata: {
          type: MemoryType.MESSAGE,
          timestamp: Date.now(),
          scope: 'shared',
        },
        agentId,
      };

      const text = getMemoryText(memory);
      expect(text).toBe('Hello, runtime!');
    });

    it('should handle missing text gracefully', () => {
      const memory: Memory = {
        id: uuidv4() as UUID,
        entityId,
        roomId,
        content: {},
        createdAt: Date.now(),
        metadata: {
          type: MemoryType.MESSAGE,
          timestamp: Date.now(),
          scope: 'shared',
        },
        agentId,
      };

      const text = getMemoryText(memory, 'Default text');
      expect(text).toBe('Default text');
    });
  });

  describe('Memory Creation and Retrieval Flow', () => {
    it('should create and store memory through runtime adapter', async () => {
      const memory = createMessageMemory({
        entityId,
        roomId,
        agentId,
        content: { text: 'Integration test message' },
      });

      const storedMemoryId = await runtime.adapter.createMemory(memory, 'messages');
      expect(storedMemoryId).toBeDefined();
      expect(mockAdapter.createMemory).toHaveBeenCalled();
      expect((mockAdapter.createMemory as ReturnType<typeof mock>).mock.calls[0][0]).toEqual(
        memory
      );
      expect((mockAdapter.createMemory as ReturnType<typeof mock>).mock.calls[0][1]).toBe(
        'messages'
      );
    });

    it('should retrieve memories and extract text correctly', async () => {
      const testMemories: Memory[] = [
        {
          id: uuidv4() as UUID,
          entityId,
          roomId,
          content: { text: 'First message' },
          createdAt: Date.now(),
          metadata: {
            type: MemoryType.MESSAGE,
            timestamp: Date.now(),
            scope: 'shared',
          },
          agentId,
        },
        {
          id: uuidv4() as UUID,
          entityId,
          roomId,
          content: { text: 'Second message' },
          createdAt: Date.now(),
          metadata: {
            type: MemoryType.MESSAGE,
            timestamp: Date.now(),
            scope: 'shared',
          },
          agentId,
        },
      ];

      (mockAdapter.getMemories as ReturnType<typeof mock>).mockResolvedValue(testMemories);

      const memories = await runtime.adapter.getMemories({
        roomId,
        count: 10,
        tableName: 'messages',
      });
      expect(memories).toHaveLength(2);

      const texts = memories.map((m) => getMemoryText(m));
      expect(texts).toContain('First message');
      expect(texts).toContain('Second message');
    });

    it('should handle empty memory retrieval gracefully', async () => {
      (mockAdapter.getMemories as ReturnType<typeof mock>).mockResolvedValue([]);

      const memories = await runtime.adapter.getMemories({
        roomId,
        count: 10,
        tableName: 'messages',
      });
      expect(memories).toHaveLength(0);
      expect(memories).toEqual([]);
    });
  });
});
