import { describe, it, expect } from 'vitest';
import { createTodoAction } from '../actions/createTodo';
import { completeTodoAction } from '../actions/completeTodo';
import { confirmTodoAction } from '../actions/confirmTodo';
import { updateTodoAction } from '../actions/updateTodo';
import { cancelTodoAction } from '../actions/cancelTodo';
import type { IAgentRuntime, Memory, UUID } from '@elizaos/core';

describe('Todo Actions', () => {
  const mockRuntime: IAgentRuntime = {
    agentId: 'test-agent' as UUID,
    useModel: () => Promise.resolve('<response></response>'),
    composeState: () => Promise.resolve({ data: {} }),
    db: null,
    getRoom: () => Promise.resolve({ worldId: 'test-world' }),
  } as any;

  const mockMessage: Memory = {
    entityId: 'user-1' as UUID,
    roomId: 'room-1' as UUID,
    content: { text: 'test message', source: 'test' }
  } as any;

  describe('Action Properties', () => {
    it('should have all actions with required properties', () => {
      const actions = [createTodoAction, completeTodoAction, confirmTodoAction, updateTodoAction, cancelTodoAction];
      
      actions.forEach(action => {
        expect(action.name).toBeDefined();
        expect(typeof action.name).toBe('string');
        expect(action.description).toBeDefined();
        expect(typeof action.description).toBe('string');
        expect(action.handler).toBeDefined();
        expect(typeof action.handler).toBe('function');
        expect(action.validate).toBeDefined();
        expect(typeof action.validate).toBe('function');
      });
    });

    it('should have unique action names', () => {
      const actions = [createTodoAction, completeTodoAction, confirmTodoAction, updateTodoAction, cancelTodoAction];
      const names = actions.map(action => action.name);
      const uniqueNames = new Set(names);
      expect(uniqueNames.size).toBe(actions.length);
    });
  });

  describe('CREATE_TODO Action', () => {
    it('should validate correctly', async () => {
      const result = await createTodoAction.validate(mockRuntime, mockMessage);
      expect(typeof result).toBe('boolean');
    });

    it('should handle missing context gracefully', async () => {
      const messageWithoutRoom: Memory = {
        entityId: 'user-1' as UUID,
        content: { text: 'test message', source: 'test' }
      } as any;

      let callbackCalled = false;
      await createTodoAction.handler(mockRuntime, messageWithoutRoom, undefined, {}, async () => {
        callbackCalled = true;
        return [];
      });
      expect(callbackCalled).toBe(true);
    });
  });

  describe('COMPLETE_TODO Action', () => {
    it('should validate correctly', async () => {
      const result = await completeTodoAction.validate(mockRuntime, mockMessage);
      expect(typeof result).toBe('boolean');
    });

    it('should handle missing context gracefully', async () => {
      let callbackCalled = false;
      await completeTodoAction.handler(mockRuntime, mockMessage, undefined, {}, async () => {
        callbackCalled = true;
        return [];
      });
      expect(callbackCalled).toBe(true);
    });
  });

  describe('CONFIRM_TODO Action', () => {
    it('should validate correctly', async () => {
      const result = await confirmTodoAction.validate(mockRuntime, mockMessage);
      expect(typeof result).toBe('boolean');
    });

    it('should handle missing pending todo gracefully', async () => {
      let callbackCalled = false;
      await confirmTodoAction.handler(mockRuntime, mockMessage, undefined, {}, async () => {
        callbackCalled = true;
        return [];
      });
      expect(callbackCalled).toBe(true);
    });
  });

  describe('UPDATE_TODO Action', () => {
    it('should validate correctly', async () => {
      const result = await updateTodoAction.validate(mockRuntime, mockMessage);
      expect(typeof result).toBe('boolean');
    });

    it('should handle missing context gracefully', async () => {
      let callbackCalled = false;
      await updateTodoAction.handler(mockRuntime, mockMessage, undefined, {}, async () => {
        callbackCalled = true;
        return [];
      });
      expect(callbackCalled).toBe(true);
    });
  });

  describe('CANCEL_TODO Action', () => {
    it('should validate correctly', async () => {
      const result = await cancelTodoAction.validate(mockRuntime, mockMessage);
      expect(typeof result).toBe('boolean');
    });

    it('should handle missing context gracefully', async () => {
      let callbackCalled = false;
      await cancelTodoAction.handler(mockRuntime, mockMessage, undefined, {}, async () => {
        callbackCalled = true;
        return [];
      });
      expect(callbackCalled).toBe(true);
    });
  });

  describe('Action Examples', () => {
    it('should have proper example structures', () => {
      const actions = [createTodoAction, completeTodoAction, confirmTodoAction, updateTodoAction, cancelTodoAction];
      
      actions.forEach(action => {
        expect(action.examples).toBeDefined();
        expect(Array.isArray(action.examples)).toBe(true);
        
        if (action.examples && action.examples.length > 0) {
          action.examples.forEach(example => {
            expect(Array.isArray(example)).toBe(true);
            
            example.forEach(message => {
              expect(message).toHaveProperty('name');
              expect(message).toHaveProperty('content');
              expect(typeof message.name).toBe('string');
              expect(typeof message.content).toBe('object');
            });
          });
        }
      });
    });
  });

  describe('Action Similes', () => {
    it('should have appropriate similes', () => {
      expect(createTodoAction.similes).toContain('ADD_TODO');
      expect(completeTodoAction.similes).toContain('FINISH_TASK');
      expect(updateTodoAction.similes).toContain('MODIFY_TODO');
      expect(cancelTodoAction.similes).toContain('DELETE_TODO');
    });
  });
});