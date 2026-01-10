import { describe, it, expect } from 'vitest';
import GoalsPlugin from '../index';
import type { IAgentRuntime, UUID } from '@elizaos/core';

describe('GoalsPlugin Initialization', () => {
  let mockRuntime: IAgentRuntime;

  const setupMocks = () => {
    mockRuntime = {
      agentId: 'test-agent' as UUID,
      getSetting: () => undefined,
      db: null, // No database available
    } as any;
  };

  it('should have correct plugin metadata', () => {
    expect(GoalsPlugin.name).toBe('goals');
    expect(GoalsPlugin.description).toContain('goal management');
    expect(GoalsPlugin.services).toBeDefined();
    expect(GoalsPlugin.actions).toBeDefined();
    expect(GoalsPlugin.providers).toBeDefined();
    expect(GoalsPlugin.schema).toBeDefined();
  });

  it('should have the correct number of services', () => {
    expect(GoalsPlugin.services).toHaveLength(1);
    expect(GoalsPlugin.services![0].serviceType).toBe('GOAL_DATA');
  });

  it('should have all required actions', () => {
    expect(GoalsPlugin.actions).toHaveLength(5);
    const actionNames = GoalsPlugin.actions!.map((action) => action.name);
    expect(actionNames).toContain('CREATE_GOAL');
    expect(actionNames).toContain('COMPLETE_GOAL');
    expect(actionNames).toContain('CONFIRM_GOAL');
    expect(actionNames).toContain('UPDATE_GOAL');
    expect(actionNames).toContain('CANCEL_GOAL');
  });

  it('should have the goals provider', () => {
    expect(GoalsPlugin.providers).toHaveLength(1);
    expect(GoalsPlugin.providers![0].name).toBe('GOALS');
  });

  it('should have test dependencies', () => {
    expect(GoalsPlugin.testDependencies).toContain('@elizaos/plugin-sql');
  });

  it('should initialize without database gracefully', async () => {
    setupMocks();

    // Should not throw when no database is available
    await expect(GoalsPlugin.init!({}, mockRuntime)).resolves.toBeUndefined();
  });

  it('should have schema with correct tables', () => {
    expect(GoalsPlugin.schema).toBeDefined();
    expect(GoalsPlugin.schema.goalsTable).toBeDefined();
    expect(GoalsPlugin.schema.goalTagsTable).toBeDefined();
  });

  it('should export correct types', () => {
    // Check that the plugin exports are defined
    expect(GoalsPlugin).toBeDefined();
    expect(GoalsPlugin.name).toBe('goals');
    expect(typeof GoalsPlugin.init).toBe('function');
  });
});
