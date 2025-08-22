import { describe, it, expect, beforeEach, mock } from 'bun:test';
import {
  ProgressTracker,
  MatrixProgress,
  CombinationProgress,
  ProgressEventType,
  ProgressCallback,
  createProgressTracker,
} from '../progress-tracker';

describe('Progress Tracker', () => {
  let progressTracker: ProgressTracker;
  let mockProgressCallback: ProgressCallback;
  let progressMessages: string[];

  beforeEach(() => {
    progressMessages = [];
    mockProgressCallback = mock((message: string, eventType: ProgressEventType, data?: any) => {
      progressMessages.push(`${eventType}: ${message}`);
    });

    progressTracker = createProgressTracker({
      totalCombinations: 3,
      runsPerCombination: 2,
      onProgress: mockProgressCallback,
    });
  });

  describe('Progress Tracking Initialization', () => {
    it('should initialize with correct total counts', () => {
      const progress = progressTracker.getOverallProgress();

      expect(progress.totalCombinations).toBe(3);
      expect(progress.totalRuns).toBe(6); // 3 combinations × 2 runs each
      expect(progress.completedRuns).toBe(0);
      expect(progress.completedCombinations).toBe(0);
      expect(progress.currentCombination).toBe(0);
    });

    it('should start with no estimated completion time', () => {
      const progress = progressTracker.getOverallProgress();

      expect(progress.estimatedTimeRemaining).toBeNull();
      expect(progress.averageRunDuration).toBe(0);
    });
  });

  describe('Run Progress Tracking', () => {
    it('should track individual run start and completion', () => {
      const runId = 'run-001';
      const combinationId = 'combo-001';

      progressTracker.startRun(runId, combinationId, { param1: 'value1' });

      expect(progressMessages).toContainEqual(
        expect.stringContaining('RUN_STARTED: Executing run 1 of 6')
      );
      expect(progressMessages).toContainEqual(expect.stringContaining('Combination 1/3'));

      // Complete the run
      progressTracker.completeRun(runId, true, 5000); // 5 second duration

      expect(progressMessages).toContainEqual(
        expect.stringContaining('RUN_COMPLETED: Run 1 completed successfully')
      );

      const progress = progressTracker.getOverallProgress();
      expect(progress.completedRuns).toBe(1);
      expect(progress.averageRunDuration).toBe(5000);
    });

    it('should track failed runs appropriately', () => {
      const runId = 'run-fail';
      const combinationId = 'combo-001';

      progressTracker.startRun(runId, combinationId, { param1: 'value1' });
      progressTracker.completeRun(runId, false, 3000, 'Test error message');

      expect(progressMessages).toContainEqual(
        expect.stringContaining('RUN_FAILED: Run 1 failed: Test error message')
      );

      const progress = progressTracker.getOverallProgress();
      expect(progress.completedRuns).toBe(1);
      expect(progress.failedRuns).toBe(1);
    });

    it('should update estimated time remaining after multiple runs', () => {
      // Complete several runs to establish timing pattern
      const runDurations = [2000, 3000, 2500, 1500]; // milliseconds

      runDurations.forEach((duration, index) => {
        const runId = `run-${index + 1}`;
        const combinationId = `combo-${Math.floor(index / 2) + 1}`;

        progressTracker.startRun(runId, combinationId, { param1: `value${index}` });
        progressTracker.completeRun(runId, true, duration);
      });

      const progress = progressTracker.getOverallProgress();

      expect(progress.completedRuns).toBe(4);
      expect(progress.estimatedTimeRemaining).not.toBeNull();
      expect(progress.averageRunDuration).toBeGreaterThan(0);

      // Should have ETA message
      const etaMessage = progressMessages.find(
        (msg) => msg.includes('ETA') || msg.includes('remaining')
      );
      expect(etaMessage).toBeDefined();
    });
  });

  describe('Combination Progress Tracking', () => {
    it('should track combination completion', () => {
      const combinationId = 'combo-001';

      // Start and complete first combination (2 runs)
      progressTracker.startRun('run-1', combinationId, { param1: 'value1' });
      progressTracker.completeRun('run-1', true, 2000);

      progressTracker.startRun('run-2', combinationId, { param1: 'value1' });
      progressTracker.completeRun('run-2', true, 2500);

      progressTracker.completeCombination(combinationId);

      expect(progressMessages).toContainEqual(
        expect.stringContaining('COMBINATION_COMPLETED: Combination 1/3 completed')
      );

      const progress = progressTracker.getOverallProgress();
      expect(progress.completedCombinations).toBe(1);
    });

    it('should provide combination-specific statistics', () => {
      const combinationId = 'combo-stats-test';

      progressTracker.startRun('run-1', combinationId, { param1: 'value1' });
      progressTracker.completeRun('run-1', true, 1000);

      progressTracker.startRun('run-2', combinationId, { param1: 'value1' });
      progressTracker.completeRun('run-2', false, 1500, 'Test failure');

      const combinationStats = progressTracker.getCombinationProgress(combinationId);

      expect(combinationStats.totalRuns).toBe(2);
      expect(combinationStats.completedRuns).toBe(2);
      expect(combinationStats.successfulRuns).toBe(1);
      expect(combinationStats.failedRuns).toBe(1);
      expect(combinationStats.successRate).toBe(0.5);
      expect(combinationStats.averageDuration).toBe(1250); // (1000 + 1500) / 2
    });
  });

  describe('Progress Messages and Formatting', () => {
    it('should format detailed progress messages correctly', () => {
      progressTracker.startRun('run-001', 'combo-001', {
        'character.name': 'Alice',
        'character.model': 'gpt-4',
      });

      const detailedMessage = progressMessages.find(
        (msg) =>
          msg.includes('Executing run') &&
          msg.includes('Combination') &&
          msg.includes('character.name')
      );

      expect(detailedMessage).toBeDefined();
      expect(detailedMessage).toContain('Alice');
      expect(detailedMessage).toContain('gpt-4');
    });

    it('should format time estimates in human-readable format', () => {
      // Complete 5 runs to ensure ETA calculation (needs >= 3 + some for remaining work)
      for (let i = 0; i < 5; i++) {
        progressTracker.startRun(`run-${i}`, `combo-${i}`, {});
        progressTracker.completeRun(`run-${i}`, true, 2000);
      }

      const progress = progressTracker.getOverallProgress();

      if (progress.estimatedTimeRemaining) {
        expect(progress.estimatedTimeRemaining).toBeGreaterThan(0);
      }

      // Should have formatted ETA in messages after enough runs
      const etaMessage = progressMessages.find(
        (msg) =>
          msg.includes('ETA') &&
          (msg.includes('seconds') ||
            msg.includes('minutes') ||
            msg.includes('hours') ||
            msg.includes('completion'))
      );

      // With 5 completed runs out of 10 total, and ETA calculation enabled, we should have ETA messages
      expect(etaMessage).toBeDefined();
    });

    it('should provide summary statistics after combination completion', () => {
      const combinationId = 'combo-summary-test';

      // Complete a full combination
      progressTracker.startRun('run-1', combinationId, { param: 'value1' });
      progressTracker.completeRun('run-1', true, 1500);

      progressTracker.startRun('run-2', combinationId, { param: 'value1' });
      progressTracker.completeRun('run-2', true, 2000);

      progressTracker.completeCombination(combinationId);

      const summaryMessage = progressMessages.find(
        (msg) => msg.includes('COMBINATION_COMPLETED') && msg.includes('100%')
      );
      expect(summaryMessage).toBeDefined();
    });
  });

  describe('Real-time Progress Updates', () => {
    it('should provide progress updates during long-running operations', () => {
      const startTime = Date.now();

      progressTracker.startRun('long-run', 'combo-001', { param: 'value' });

      // Simulate progress updates during execution
      progressTracker.updateRunProgress('long-run', 0.25, 'Initializing...');
      progressTracker.updateRunProgress('long-run', 0.5, 'Processing...');
      progressTracker.updateRunProgress('long-run', 0.75, 'Finalizing...');

      const progressUpdates = progressMessages.filter((msg) => msg.includes('PROGRESS_UPDATE'));

      expect(progressUpdates).toHaveLength(3);
      expect(progressUpdates[0]).toContain('25%');
      expect(progressUpdates[1]).toContain('50%');
      expect(progressUpdates[2]).toContain('75%');
    });

    it('should calculate accurate completion percentages', () => {
      const totalRuns = 6; // 3 combinations × 2 runs each

      // Complete half the runs
      for (let i = 0; i < 3; i++) {
        progressTracker.startRun(`run-${i}`, `combo-${Math.floor(i / 2)}`, {});
        progressTracker.completeRun(`run-${i}`, true, 1000);
      }

      const progress = progressTracker.getOverallProgress();
      expect(progress.overallProgress).toBe(0.5); // 50% complete

      const percentageMessage = progressMessages.find(
        (msg) => msg.includes('50%') || msg.includes('3 of 6')
      );
      expect(percentageMessage).toBeDefined();
    });
  });

  describe('Error and Timeout Handling', () => {
    it('should handle run timeouts appropriately', () => {
      const runId = 'timeout-run';
      const timeoutMs = 30000; // 30 seconds

      progressTracker.startRun(runId, 'combo-001', { param: 'value' });
      progressTracker.timeoutRun(runId, timeoutMs);

      const timeoutMessage = progressMessages.find(
        (msg) => msg.includes('TIMEOUT') && msg.includes('30')
      );
      expect(timeoutMessage).toBeDefined();

      const progress = progressTracker.getOverallProgress();
      expect(progress.failedRuns).toBe(1);
    });

    it('should track resource warnings and system issues', () => {
      progressTracker.reportResourceWarning('memory', 85, 'High memory usage detected');
      progressTracker.reportResourceWarning('disk', 95, 'Low disk space');

      const memoryWarning = progressMessages.find(
        (msg) => msg.includes('RESOURCE_WARNING') && msg.includes('memory')
      );
      const diskWarning = progressMessages.find(
        (msg) => msg.includes('RESOURCE_WARNING') && msg.includes('disk')
      );

      expect(memoryWarning).toBeDefined();
      expect(diskWarning).toBeDefined();
    });
  });

  describe('Progress Data Export', () => {
    it('should export comprehensive progress data', () => {
      // Complete some runs to have data
      progressTracker.startRun('run-1', 'combo-1', { param: 'value1' });
      progressTracker.completeRun('run-1', true, 2000);

      progressTracker.startRun('run-2', 'combo-1', { param: 'value1' });
      progressTracker.completeRun('run-2', false, 1500, 'Test error');

      const exportData = progressTracker.exportProgressData();

      expect(exportData).toHaveProperty('overallProgress');
      expect(exportData).toHaveProperty('combinations');
      expect(exportData).toHaveProperty('runs');
      expect(exportData).toHaveProperty('startTime');
      expect(exportData).toHaveProperty('statistics');

      expect(exportData.overallProgress.completedRuns).toBe(2);
      expect(exportData.runs).toHaveLength(2);
      expect(exportData.combinations.get('combo-1')?.completedRuns).toBe(2);
    });
  });

  describe('Performance Considerations', () => {
    it('should handle large numbers of progress updates efficiently', () => {
      const startTime = Date.now();
      const numUpdates = 1000;

      // Generate many progress updates
      for (let i = 0; i < numUpdates; i++) {
        progressTracker.startRun(`run-${i}`, `combo-${Math.floor(i / 10)}`, {});
        progressTracker.completeRun(`run-${i}`, true, 100);
      }

      const endTime = Date.now();
      const duration = endTime - startTime;

      // Should complete many updates quickly (< 1 second)
      expect(duration).toBeLessThan(1000);

      const progress = progressTracker.getOverallProgress();
      expect(progress.completedRuns).toBe(numUpdates);
    });
  });
});
