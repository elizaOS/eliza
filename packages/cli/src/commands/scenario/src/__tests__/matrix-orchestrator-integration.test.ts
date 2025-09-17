import { describe, it, expect, beforeEach, afterEach, jest } from 'bun:test';
import { processManager } from '../process-manager';

describe('Matrix Orchestrator Process Manager Integration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(async () => {
    // Clean up any test processes
    await processManager.terminateAllProcesses();
  });

  it('should import process manager without errors', () => {
    expect(processManager).toBeDefined();
    expect(typeof processManager.getSummary).toBe('function');
    expect(typeof processManager.registerProcess).toBe('function');
    expect(typeof processManager.terminateAllProcesses).toBe('function');
  });

  it('should get initial summary without errors', () => {
    const summary = processManager.getSummary();
    expect(summary).toEqual({
      total: 0,
      byType: {},
      oldestProcess: undefined,
    });
  });

  it('should handle process registration and cleanup', () => {
    // Test that we can register and unregister processes
    processManager.registerProcess('test-run-1', 999999, 'agent-server');

    let summary = processManager.getSummary();
    expect(summary.total).toBe(1);
    expect(summary.byType['agent-server']).toBe(1);

    processManager.unregisterProcess('test-run-1');

    summary = processManager.getSummary();
    expect(summary.total).toBe(0);
  });
});
