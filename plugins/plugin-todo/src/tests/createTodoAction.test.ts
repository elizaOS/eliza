import type { HandlerCallback, IAgentRuntime, Memory, State, UUID } from '@elizaos/core';
import { describe, expect, it } from 'vitest';
import { createTodoAction } from '../actions/createTodo';

describe('createTodoAction', () => {
  let mockRuntime: IAgentRuntime;
  let mockCallback: HandlerCallback;
  let mockState: State;

  const setupMocks = () => {
    mockCallback = async () => [];

    mockRuntime = {
      agentId: 'test-agent' as UUID,
      worldId: 'test-world' as UUID,
      useModel: () => Promise.resolve('<response></response>'), // Empty response to trigger failure path
      composeState: () => Promise.resolve(mockState),
      db: null, // Will cause data service to handle gracefully
      getRoom: () => Promise.resolve({ worldId: 'test-world' }),
    } as any;

    mockState = {
      values: {},
      text: '',
      data: {
        messages: [],
        entities: [],
        room: { id: 'room-1', name: 'Test Room', worldId: 'world-1' },
      },
    };
  };

  it('should have correct action properties', () => {
    expect(createTodoAction.name).toBe('CREATE_TODO');
    expect(createTodoAction.description).toBeDefined();
    expect(createTodoAction.handler).toBeInstanceOf(Function);
    expect(createTodoAction.validate).toBeInstanceOf(Function);
    expect(createTodoAction.examples).toBeDefined();
    expect(Array.isArray(createTodoAction.examples)).toBe(true);
  });

  it('should have proper similes', () => {
    expect(createTodoAction.similes).toContain('ADD_TODO');
    expect(createTodoAction.similes).toContain('NEW_TASK');
    expect(createTodoAction.similes).toContain('ADD_TASK');
    expect(createTodoAction.similes).toContain('CREATE_TASK');
  });

  it('should validate correctly', async () => {
    setupMocks();
    const message: Memory = { 
      entityId: 'user-1' as UUID, 
      roomId: 'room-1' as UUID,
      content: { text: 'create a todo' }
    } as any;
    
    const isValid = await createTodoAction.validate(mockRuntime, message);
    expect(typeof isValid).toBe('boolean');
  });

  it('should handle missing roomId gracefully', async () => {
    setupMocks();
    const message: Memory = { 
      entityId: 'user-1' as UUID,
      content: { text: 'create a todo', source: 'test' }
    } as any;
    
    let callbackCalled = false;
    const testCallback: HandlerCallback = async () => {
      callbackCalled = true;
      return [];
    };
    
    await createTodoAction.handler(mockRuntime, message, mockState, {}, testCallback);
    expect(callbackCalled).toBe(true);
  });

  it('should handle missing entityId gracefully', async () => {
    setupMocks();
    const message: Memory = { 
      roomId: 'room-1' as UUID,
      content: { text: 'create a todo', source: 'test' }
    } as any;
    
    let callbackCalled = false;
    const testCallback: HandlerCallback = async () => {
      callbackCalled = true;
      return [];
    };
    
    await createTodoAction.handler(mockRuntime, message, mockState, {}, testCallback);
    expect(callbackCalled).toBe(true);
  });

  it('should handle empty AI response gracefully', async () => {
    setupMocks();
    const message: Memory = { 
      entityId: 'user-1' as UUID,
      roomId: 'room-1' as UUID,
      content: { text: 'create a todo', source: 'test' }
    } as any;
    
    let callbackCalled = false;
    const testCallback: HandlerCallback = async () => {
      callbackCalled = true;
      return [];
    };
    
    await createTodoAction.handler(mockRuntime, message, mockState, {}, testCallback);
    expect(callbackCalled).toBe(true);
  });

  it('should have proper example structure', () => {
    expect(createTodoAction.examples).toBeDefined();
    expect(Array.isArray(createTodoAction.examples)).toBe(true);
    expect(createTodoAction.examples!.length).toBeGreaterThan(0);
    
    // Check first example structure
    const firstExample = createTodoAction.examples![0];
    expect(Array.isArray(firstExample)).toBe(true);
    expect(firstExample.length).toBeGreaterThan(0);
    
    // Check example message structure
    const firstMessage = firstExample[0];
    expect(firstMessage).toHaveProperty('name');
    expect(firstMessage).toHaveProperty('content');
  });
});