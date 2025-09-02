import { describe, it, expect, beforeEach, afterEach, jest } from 'bun:test';
import { ProcessManager } from '../process-manager';

describe('ProcessManager', () => {
  let processManager: ProcessManager;

  beforeEach(() => {
    processManager = new ProcessManager();
    jest.clearAllMocks();
  });

  afterEach(async () => {
    // Cleanup any registered processes
    await processManager.terminateAllProcesses();
  });

  describe('registerProcess', () => {
    it('should register a process successfully', () => {
      const runId = 'test-run-1';
      const pid = 12345;

      processManager.registerProcess(runId, pid, 'agent-server', 3001);

      const processes = processManager.getProcesses();
      expect(processes.has(runId)).toBe(true);

      const processInfo = processes.get(runId);
      expect(processInfo).toEqual({
        pid: 12345,
        runId: 'test-run-1',
        type: 'agent-server',
        startTime: expect.any(Date),
        port: 3001,
      });
    });

    it('should handle multiple process registrations', () => {
      processManager.registerProcess('run-1', 111, 'agent-server');
      processManager.registerProcess('run-2', 222, 'scenario-runner');

      const processes = processManager.getProcesses();
      expect(processes.size).toBe(2);
      expect(processes.has('run-1')).toBe(true);
      expect(processes.has('run-2')).toBe(true);
    });
  });

  describe('unregisterProcess', () => {
    it('should unregister a process successfully', () => {
      processManager.registerProcess('test-run', 12345, 'agent-server');
      expect(processManager.getProcesses().size).toBe(1);

      processManager.unregisterProcess('test-run');
      expect(processManager.getProcesses().size).toBe(0);
    });

    it('should handle unregistering non-existent process gracefully', () => {
      processManager.unregisterProcess('non-existent');
      expect(processManager.getProcesses().size).toBe(0);
    });
  });

  describe('isProcessRunning', () => {
    it('should return true for current process', () => {
      const currentPid = process.pid;
      expect(processManager.isProcessRunning(currentPid)).toBe(true);
    });

    it('should return false for non-existent process', () => {
      // Use a very high PID that likely doesn't exist
      const fakePid = 999999;
      expect(processManager.isProcessRunning(fakePid)).toBe(false);
    });
  });

  describe('getSummary', () => {
    it('should return correct summary for empty process manager', () => {
      const summary = processManager.getSummary();
      expect(summary).toEqual({
        total: 0,
        byType: {},
        oldestProcess: undefined,
      });
    });

    it('should return correct summary with processes', () => {
      const now = new Date();
      processManager.registerProcess('run-1', 111, 'agent-server');
      processManager.registerProcess('run-2', 222, 'agent-server');
      processManager.registerProcess('run-3', 333, 'scenario-runner');

      const summary = processManager.getSummary();
      expect(summary.total).toBe(3);
      expect(summary.byType).toEqual({
        'agent-server': 2,
        'scenario-runner': 1,
      });
      expect(summary.oldestProcess).toBeDefined();
    });
  });

  describe('terminateProcess', () => {
    it('should return true for non-existent process', async () => {
      const result = await processManager.terminateProcess('non-existent');
      expect(result).toBe(true);
    });

    it('should handle already terminated process', async () => {
      // Register a fake process that doesn't actually exist
      processManager.registerProcess('fake-run', 999999, 'agent-server');

      const result = await processManager.terminateProcess('fake-run', 100);
      expect(result).toBe(true);
      expect(processManager.getProcesses().size).toBe(0);
    });
  });

  describe('terminateAllProcesses', () => {
    it('should handle empty process list', async () => {
      await expect(processManager.terminateAllProcesses()).resolves.toBeUndefined();
    });

    it('should clear all processes after termination', async () => {
      // Register fake processes
      processManager.registerProcess('run-1', 999997, 'agent-server');
      processManager.registerProcess('run-2', 999998, 'scenario-runner');

      expect(processManager.getProcesses().size).toBe(2);

      await processManager.terminateAllProcesses(1000);

      expect(processManager.getProcesses().size).toBe(0);
    });
  });
});
