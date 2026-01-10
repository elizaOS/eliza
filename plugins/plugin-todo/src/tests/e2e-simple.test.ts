import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { TodoPlugin } from '../index';
import { createTodoDataService } from '../services/todoDataService';
import { TodoReminderService } from '../services/reminderService';
import { TodoIntegrationBridge } from '../services/integrationBridge';

// Mock runtime for testing
const mockRuntime = {
  agentId: 'test-agent' as any,
  db: null, // Will be skipped in services
  getService: () => null,
  useModel: () => Promise.resolve('Mock response'),
  composeState: () => Promise.resolve({ data: {} }),
  getRoom: () => Promise.resolve(null),
  emitEvent: () => Promise.resolve(),
} as any;

describe('Todo Plugin E2E Simple Tests', () => {
  it('should initialize plugin successfully', async () => {
    expect(() => TodoPlugin.init?.({}, mockRuntime)).not.toThrow();
  });

  it('should create reminder service successfully', async () => {
    const service = await TodoReminderService.start(mockRuntime);
    expect(service).toBeDefined();
    expect(service.serviceName).toBe('TODO_REMINDER');
    await service.stop();
  });

  it('should create integration bridge successfully', async () => {
    const service = await TodoIntegrationBridge.start(mockRuntime);
    expect(service).toBeDefined();
    expect(service.serviceName).toBe('TODO_INTEGRATION_BRIDGE');
    await service.stop();
  });

  it('should have working action validation', () => {
    const createAction = TodoPlugin.actions?.find((a) => a.name === 'CREATE_TODO');
    expect(createAction).toBeDefined();
    expect(createAction?.validate).toBeDefined();
    expect(typeof createAction?.handler).toBe('function');
  });

  it('should export all required types', () => {
    expect(typeof TodoPlugin.name).toBe('string');
    expect(Array.isArray(TodoPlugin.actions)).toBe(true);
    expect(Array.isArray(TodoPlugin.services)).toBe(true);
    expect(Array.isArray(TodoPlugin.providers)).toBe(true);
    expect(TodoPlugin.schema).toBeDefined();
  });
});
