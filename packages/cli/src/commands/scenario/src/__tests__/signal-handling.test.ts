import { describe, it, expect, beforeEach, afterEach, jest } from 'bun:test';
import { processManager } from '../process-manager';

describe('Signal Handling Integration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(async () => {
    // Clean up any test processes
    await processManager.terminateAllProcesses();
  });

  it('should handle graceful shutdown without processes', async () => {
    const summary = processManager.getSummary();
    expect(summary.total).toBe(0);

    // Test that terminate all processes works even with no processes
    await expect(processManager.terminateAllProcesses()).resolves.toBeUndefined();
  });

  it('should track and cleanup processes properly', async () => {
    // Register a fake process
    processManager.registerProcess('test-shutdown-1', 999999, 'agent-server');

    let summary = processManager.getSummary();
    expect(summary.total).toBe(1);

    // Cleanup all processes
    await processManager.terminateAllProcesses();

    summary = processManager.getSummary();
    expect(summary.total).toBe(0);
  });

  it('should handle multiple process types', async () => {
    processManager.registerProcess('test-1', 999997, 'agent-server');
    processManager.registerProcess('test-2', 999998, 'scenario-runner');

    const summary = processManager.getSummary();
    expect(summary.total).toBe(2);
    expect(summary.byType['agent-server']).toBe(1);
    expect(summary.byType['scenario-runner']).toBe(1);

    await processManager.terminateAllProcesses();

    const finalSummary = processManager.getSummary();
    expect(finalSummary.total).toBe(0);
  });
});
