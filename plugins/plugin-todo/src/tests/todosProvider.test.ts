import { describe, it, expect } from 'vitest';
import { todosProvider } from '../providers/todos';
import type { IAgentRuntime, Memory, State, UUID } from '@elizaos/core';

describe('todosProvider', () => {
  let mockRuntime: IAgentRuntime;
  let mockState: State;

  const setupMocks = () => {
    mockRuntime = {
      agentId: 'test-agent' as UUID,
      worldId: 'world-1' as UUID,
      getRoom: () => Promise.resolve({ worldId: 'world-1' }),
      db: null, // Will cause data service to handle gracefully
    } as any;

    mockState = {
      values: {},
      text: '',
      data: {
        room: { id: 'room-1' as UUID, name: 'Test Room', worldId: 'world-1' as UUID },
      },
    };
  };

  it('should have correct provider properties', () => {
    expect(todosProvider.name).toBe('TODOS');
    expect(todosProvider.description).toBeDefined();
    expect(todosProvider.get).toBeInstanceOf(Function);
  });

  it('should handle no database gracefully', async () => {
    setupMocks();
    const message: Memory = { entityId: 'user-1' as UUID, roomId: 'room-1' as UUID } as any;
    const result = await todosProvider.get(mockRuntime, message, mockState);

    expect(result.text).toBeDefined();
    expect(typeof result.text).toBe('string');
    // Should contain error message or fallback text
    expect(result.text!.length).toBeGreaterThan(0);
  });

  it('should return proper structure', async () => {
    setupMocks();
    const message: Memory = { entityId: 'user-1' as UUID, roomId: 'room-1' as UUID } as any;
    const result = await todosProvider.get(mockRuntime, message, mockState);

    expect(result).toHaveProperty('text');
    expect(typeof result.text).toBe('string');
  });

  it('should handle missing entityId gracefully', async () => {
    setupMocks();
    const message: Memory = { roomId: 'room-1' as UUID } as any;
    const result = await todosProvider.get(mockRuntime, message, mockState);

    expect(result.text).toBeDefined();
    expect(typeof result.text).toBe('string');
  });
});