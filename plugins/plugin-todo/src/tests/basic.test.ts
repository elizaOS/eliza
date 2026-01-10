import { describe, it, expect } from 'vitest';
import { TodoPlugin } from '../index';

describe('TodoPlugin Basic Tests', () => {
  it('should have the correct plugin name', () => {
    expect(TodoPlugin.name).toBe('todo');
  });

  it('should have the correct description', () => {
    expect(TodoPlugin.description).toContain('task management');
  });

  it('should export two services', () => {
    expect(TodoPlugin.services).toHaveLength(2);
  });

  it('should have all required actions', () => {
    expect(TodoPlugin.actions).toHaveLength(5);
    const actionNames = TodoPlugin.actions?.map((action) => action.name) || [];
    expect(actionNames).toContain('CREATE_TODO');
    expect(actionNames).toContain('COMPLETE_TODO');
    expect(actionNames).toContain('CONFIRM_TODO');
    expect(actionNames).toContain('UPDATE_TODO');
    expect(actionNames).toContain('CANCEL_TODO');
  });

  it('should have the todos provider', () => {
    expect(TodoPlugin.providers).toHaveLength(1);
  });

  it('should have the correct test dependencies', () => {
    expect(TodoPlugin.testDependencies).toContain('@elizaos/plugin-sql');
  });
});
