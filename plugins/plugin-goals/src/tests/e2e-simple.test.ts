import { describe, it, expect } from 'vitest';
import GoalsPlugin from '../index';
import { createGoalDataService } from '../services/goalDataService';

// Mock runtime for testing
const mockRuntime = {
  agentId: 'test-agent' as any,
  db: {
    execute: () => Promise.resolve([]),
    select: () => ({
      from: () => ({
        where: () => Promise.resolve([]),
      }),
    }),
    insert: () => ({
      values: () => ({
        returning: () => Promise.resolve([{ id: 'test-id' }]),
      }),
    }),
  },
  getService: () => null,
  useModel: () => Promise.resolve('Mock response'),
  composeState: () => Promise.resolve({ data: {} }),
  getRoom: () => Promise.resolve(null),
  emitEvent: () => Promise.resolve(),
} as any;

describe('Goals Plugin E2E Simple Tests', () => {
  it('should initialize plugin successfully', async () => {
    expect(() => GoalsPlugin.init?.({}, mockRuntime)).not.toThrow();
  });

  it('should have working action validation', () => {
    const createAction = GoalsPlugin.actions?.find((a) => a.name === 'CREATE_GOAL');
    expect(createAction).toBeDefined();
    expect(createAction?.validate).toBeDefined();
    expect(typeof createAction?.handler).toBe('function');
  });

  it('should export all required types', () => {
    expect(typeof GoalsPlugin.name).toBe('string');
    expect(Array.isArray(GoalsPlugin.actions)).toBe(true);
    expect(Array.isArray(GoalsPlugin.services)).toBe(true);
    expect(Array.isArray(GoalsPlugin.providers)).toBe(true);
    expect(GoalsPlugin.schema).toBeDefined();
  });

  it('should create goal data service successfully', () => {
    const dataService = createGoalDataService(mockRuntime);
    expect(dataService).toBeDefined();
  });
});
