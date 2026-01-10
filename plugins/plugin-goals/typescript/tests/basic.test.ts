import { describe, it, expect } from 'vitest';
import GoalsPlugin from '../index';

describe('GoalsPlugin Basic Tests', () => {
  it('should have the correct plugin name', () => {
    expect(GoalsPlugin.name).toBe('goals');
  });

  it('should have the correct description', () => {
    expect(GoalsPlugin.description).toContain('goal management');
  });

  it('should export one service', () => {
    expect(GoalsPlugin.services).toHaveLength(1);
  });

  it('should have all required actions', () => {
    expect(GoalsPlugin.actions).toHaveLength(5);
    const actionNames = GoalsPlugin.actions?.map((action) => action.name) || [];
    expect(actionNames).toContain('CREATE_GOAL');
    expect(actionNames).toContain('COMPLETE_GOAL');
    expect(actionNames).toContain('CONFIRM_GOAL');
    expect(actionNames).toContain('UPDATE_GOAL');
    expect(actionNames).toContain('CANCEL_GOAL');
  });

  it('should have the goals provider', () => {
    expect(GoalsPlugin.providers).toHaveLength(1);
  });

  it('should have the correct test dependencies', () => {
    expect(GoalsPlugin.testDependencies).toContain('@elizaos/plugin-sql');
  });
});
