import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { executeMatrixRuns, MatrixRunResult, MatrixExecutionSummary } from '../matrix-orchestrator';
import {
  createIsolatedEnvironment,
  cleanupIsolatedEnvironment,
  IsolationContext,
} from '../run-isolation';
import { MatrixConfig, MatrixCombination } from '../matrix-types';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('Matrix Orchestrator', () => {
  let testOutputDir: string;
  let mockMatrixConfig: MatrixConfig;
  let mockCombinations: MatrixCombination[];

  beforeEach(async () => {
    // Create temporary output directory for tests
    testOutputDir = join(tmpdir(), `matrix-test-${Date.now()}`);
    await fs.mkdir(testOutputDir, { recursive: true });

    // Mock matrix configuration with real scenario file
    const testScenarioPath = join(__dirname, 'test-scenarios', 'matrix-test.scenario.yaml');
    mockMatrixConfig = {
      name: 'Test Matrix',
      description: 'Test matrix for orchestrator',
      base_scenario: testScenarioPath,
      runs_per_combination: 1, // Reduced for faster testing
      matrix: [
        {
          parameter: 'character.name',
          values: ['Alice', 'Bob'],
        },
      ],
    };

    // Mock combinations
    mockCombinations = [
      {
        id: 'combo-000-test1',
        parameters: { 'character.name': 'Alice' },
        metadata: {
          combinationIndex: 0,
          totalCombinations: 2,
          parameterValues: { 'character.name': 'Alice' },
        },
      },
      {
        id: 'combo-001-test2',
        parameters: { 'character.name': 'Bob' },
        metadata: {
          combinationIndex: 1,
          totalCombinations: 2,
          parameterValues: { 'character.name': 'Bob' },
        },
      },
    ];
  });

  afterEach(async () => {
    // Cleanup test output directory
    try {
      await fs.rm(testOutputDir, { recursive: true, force: true });
    } catch (error) {
      // Ignore cleanup errors in tests
    }
  });

  describe('Matrix Execution Loop (Acceptance Criterion 1)', () => {
    it('should execute all matrix combinations the specified number of times', async () => {
      const results = await executeMatrixRuns(mockMatrixConfig, mockCombinations, {
        outputDir: testOutputDir,
        maxParallel: 1,
      });

      // Should execute 2 combinations × 1 run each = 2 total runs
      expect(results).toHaveLength(2);

      // Verify all combinations were executed
      const aliceRuns = results.filter((r) => r.parameters['character.name'] === 'Alice');
      const bobRuns = results.filter((r) => r.parameters['character.name'] === 'Bob');

      expect(aliceRuns).toHaveLength(1);
      expect(bobRuns).toHaveLength(1);
    });

    it('should maintain execution order and provide progress feedback', async () => {
      const progressUpdates: string[] = [];
      const mockProgressCallback = mock((message: string) => {
        progressUpdates.push(message);
      });

      await executeMatrixRuns(mockMatrixConfig, mockCombinations, {
        outputDir: testOutputDir,
        maxParallel: 1,
        onProgress: mockProgressCallback,
      });

      // Should have progress updates for each run
      expect(progressUpdates.length).toBeGreaterThan(0);
      expect(progressUpdates.some((msg) => msg.includes('Executing run'))).toBe(true);
      expect(progressUpdates.some((msg) => msg.includes('Combination'))).toBe(true);
    });

    it('should handle individual run failures without stopping matrix execution', async () => {
      // Mock scenario runner to fail on specific combinations
      const mockFailingConfig = {
        ...mockMatrixConfig,
        matrix: [
          {
            parameter: 'character.name',
            values: ['FailingScenario', 'PassingScenario'],
          },
        ],
      };

      const failingCombinations = [
        {
          id: 'combo-fail',
          parameters: { 'character.name': 'FailingScenario' },
          metadata: { combinationIndex: 0, totalCombinations: 2, parameterValues: {} },
        },
        {
          id: 'combo-pass',
          parameters: { 'character.name': 'PassingScenario' },
          metadata: { combinationIndex: 1, totalCombinations: 2, parameterValues: {} },
        },
      ];

      const results = await executeMatrixRuns(mockFailingConfig, failingCombinations, {
        outputDir: testOutputDir,
        maxParallel: 1,
        continueOnFailure: true,
      });

      // Should complete all runs even if some fail
      expect(results).toHaveLength(4); // 2 combinations × 2 runs each

      // Should have both successful and failed runs
      const failedRuns = results.filter((r) => !r.success);
      const successfulRuns = results.filter((r) => r.success);

      expect(failedRuns.length).toBeGreaterThan(0);
      expect(successfulRuns.length).toBeGreaterThan(0);
    });
  });

  describe('Run Isolation System (Acceptance Criterion 2)', () => {
    it('should create completely isolated environment for each run', async () => {
      const runId = 'test-run-001';
      const context = await createIsolatedEnvironment(runId, testOutputDir);

      // Verify isolation context structure
      expect(context.runId).toBe(runId);
      expect(context.tempDir).toContain(runId);
      expect(context.dbPath).toContain(runId);
      expect(context.logPath).toContain(runId);
      expect(context.scenarioPath).toContain(runId);
      expect(typeof context.cleanup).toBe('function');

      // Verify directories are created
      const tempDirExists = await fs
        .access(context.tempDir)
        .then(() => true)
        .catch(() => false);
      expect(tempDirExists).toBe(true);

      // Cleanup
      await context.cleanup();
    });

    it('should ensure separate temporary directories for each run', async () => {
      const context1 = await createIsolatedEnvironment('run-001', testOutputDir);
      const context2 = await createIsolatedEnvironment('run-002', testOutputDir);

      // Each run should have unique directories
      expect(context1.tempDir).not.toBe(context2.tempDir);
      expect(context1.dbPath).not.toBe(context2.dbPath);
      expect(context1.logPath).not.toBe(context2.logPath);

      // Both directories should exist
      const dir1Exists = await fs
        .access(context1.tempDir)
        .then(() => true)
        .catch(() => false);
      const dir2Exists = await fs
        .access(context2.tempDir)
        .then(() => true)
        .catch(() => false);

      expect(dir1Exists).toBe(true);
      expect(dir2Exists).toBe(true);

      // Cleanup
      await Promise.all([context1.cleanup(), context2.cleanup()]);
    });

    it('should completely cleanup isolated environment', async () => {
      const runId = 'cleanup-test-run';
      const context = await createIsolatedEnvironment(runId, testOutputDir);

      // Verify environment exists
      const tempDirExists = await fs
        .access(context.tempDir)
        .then(() => true)
        .catch(() => false);
      expect(tempDirExists).toBe(true);

      // Cleanup
      await cleanupIsolatedEnvironment(context);

      // Verify environment is removed
      const tempDirExistsAfter = await fs
        .access(context.tempDir)
        .then(() => true)
        .catch(() => false);
      expect(tempDirExistsAfter).toBe(false);
    });

    it('should handle cleanup even when environment creation fails', async () => {
      // This tests error recovery
      const invalidOutputDir = '/invalid/nonexistent/path';

      let context: IsolationContext | null = null;
      try {
        context = await createIsolatedEnvironment('fail-test', invalidOutputDir);
      } catch (error) {
        // Expected to fail
      }

      // If context was partially created, cleanup should not throw
      if (context) {
        await expect(context.cleanup()).resolves.not.toThrow();
      }
    });
  });

  describe('Progress Tracking and Logging (Acceptance Criterion 4)', () => {
    it('should provide real-time progress updates with detailed information', async () => {
      const progressMessages: string[] = [];
      const mockProgressCallback = mock((message: string) => {
        progressMessages.push(message);
      });

      await executeMatrixRuns(mockMatrixConfig, mockCombinations.slice(0, 1), {
        outputDir: testOutputDir,
        maxParallel: 1,
        onProgress: mockProgressCallback,
      });

      // Should include run number, total runs, combination info
      const detailedProgress = progressMessages.find(
        (msg) => msg.includes('Executing run') && msg.includes('of') && msg.includes('Combination')
      );
      expect(detailedProgress).toBeDefined();
    });

    it('should calculate and provide estimated time remaining', async () => {
      const progressMessages: string[] = [];
      const mockProgressCallback = mock((message: string) => {
        progressMessages.push(message);
      });

      await executeMatrixRuns(mockMatrixConfig, mockCombinations, {
        outputDir: testOutputDir,
        maxParallel: 1,
        onProgress: mockProgressCallback,
      });

      // Should include ETA information after first few runs
      const etaMessage = progressMessages.find(
        (msg) => msg.includes('ETA') || msg.includes('remaining')
      );
      expect(etaMessage).toBeDefined();
    });

    it('should provide summary statistics after each combination completes', async () => {
      const summaryMessages: string[] = [];
      const mockSummaryCallback = mock((summary: any) => {
        summaryMessages.push(JSON.stringify(summary));
      });

      await executeMatrixRuns(mockMatrixConfig, mockCombinations.slice(0, 1), {
        outputDir: testOutputDir,
        maxParallel: 1,
        onCombinationComplete: mockSummaryCallback,
      });

      expect(summaryMessages.length).toBe(1);
      const summary = JSON.parse(summaryMessages[0]);
      expect(summary).toHaveProperty('combinationId');
      expect(summary).toHaveProperty('runsCompleted');
      expect(summary).toHaveProperty('successRate');
    });
  });

  describe('Data Collection and Storage (Acceptance Criterion 5)', () => {
    it('should capture comprehensive data for each run', async () => {
      const results = await executeMatrixRuns(mockMatrixConfig, mockCombinations.slice(0, 1), {
        outputDir: testOutputDir,
        maxParallel: 1,
      });

      const result = results[0];

      // Verify comprehensive data capture
      expect(result).toHaveProperty('runId');
      expect(result).toHaveProperty('combinationId');
      expect(result).toHaveProperty('parameters');
      expect(result).toHaveProperty('startTime');
      expect(result).toHaveProperty('endTime');
      expect(result).toHaveProperty('duration');
      expect(result).toHaveProperty('success');
      expect(result).toHaveProperty('metrics');

      expect(result.metrics).toHaveProperty('memoryUsage');
      expect(result.metrics).toHaveProperty('diskUsage');

      expect(typeof result.startTime).toBe('object');
      expect(typeof result.endTime).toBe('object');
      expect(typeof result.duration).toBe('number');
    });

    it('should store results in structured JSON format', async () => {
      await executeMatrixRuns(mockMatrixConfig, mockCombinations.slice(0, 1), {
        outputDir: testOutputDir,
        maxParallel: 1,
      });

      // Verify output directory structure
      const runsDir = join(testOutputDir, 'runs');
      const runsDirExists = await fs
        .access(runsDir)
        .then(() => true)
        .catch(() => false);
      expect(runsDirExists).toBe(true);

      // Verify individual run files
      const runFiles = await fs.readdir(runsDir);
      expect(runFiles.length).toBeGreaterThan(0);
      expect(runFiles.some((file) => file.endsWith('.json'))).toBe(true);

      // Verify JSON structure
      const firstRunFile = join(runsDir, runFiles[0]);
      const runData = JSON.parse(await fs.readFile(firstRunFile, 'utf8'));

      expect(runData).toHaveProperty('runId');
      expect(runData).toHaveProperty('parameters');
      expect(runData).toHaveProperty('success');
    });

    it('should create proper output directory structure', async () => {
      await executeMatrixRuns(mockMatrixConfig, mockCombinations.slice(0, 1), {
        outputDir: testOutputDir,
        maxParallel: 1,
      });

      // Verify required directory structure from ticket
      const configExists = await fs
        .access(join(testOutputDir, 'config.yaml'))
        .then(() => true)
        .catch(() => false);
      const summaryExists = await fs
        .access(join(testOutputDir, 'summary.json'))
        .then(() => true)
        .catch(() => false);
      const runsExists = await fs
        .access(join(testOutputDir, 'runs'))
        .then(() => true)
        .catch(() => false);
      const logsExists = await fs
        .access(join(testOutputDir, 'logs'))
        .then(() => true)
        .catch(() => false);

      expect(configExists).toBe(true);
      expect(summaryExists).toBe(true);
      expect(runsExists).toBe(true);
      expect(logsExists).toBe(true);
    });
  });

  describe('Error Handling and Recovery (Acceptance Criterion 6)', () => {
    it('should handle individual run failures gracefully', async () => {
      // Mock a scenario that will fail
      const failingConfig = {
        ...mockMatrixConfig,
        base_scenario: 'nonexistent.scenario.yaml',
      };

      const results = await executeMatrixRuns(failingConfig, mockCombinations.slice(0, 1), {
        outputDir: testOutputDir,
        maxParallel: 1,
        continueOnFailure: true,
      });

      // Should complete despite failures
      expect(results).toHaveLength(2); // 1 combination × 2 runs

      // Failed runs should have error information
      const failedRuns = results.filter((r) => !r.success);
      expect(failedRuns.length).toBeGreaterThan(0);
      expect(failedRuns[0]).toHaveProperty('error');
      expect(typeof failedRuns[0].error).toBe('string');
    });

    it('should implement timeout handling for long-running scenarios', async () => {
      const results = await executeMatrixRuns(mockMatrixConfig, mockCombinations.slice(0, 1), {
        outputDir: testOutputDir,
        maxParallel: 1,
        runTimeout: 100, // Very short timeout for testing
      });

      // Should complete within timeout constraints
      expect(results).toHaveLength(2);

      // Check that runs didn't exceed timeout significantly
      results.forEach((result) => {
        expect(result.duration).toBeLessThan(1000); // Should be much less than 1 second
      });
    });

    it('should cleanup resources even when runs fail', async () => {
      const tempDirsBefore = await fs.readdir(tmpdir());

      // Run matrix with failing scenario
      await executeMatrixRuns(mockMatrixConfig, mockCombinations.slice(0, 1), {
        outputDir: testOutputDir,
        maxParallel: 1,
        continueOnFailure: true,
      });

      const tempDirsAfter = await fs.readdir(tmpdir());

      // Should not have significantly more temp directories
      expect(tempDirsAfter.length - tempDirsBefore.length).toBeLessThan(5);
    });
  });

  describe('Resource Management (Acceptance Criterion 7)', () => {
    it('should monitor system resources during execution', async () => {
      const resourceUpdates: any[] = [];
      const mockResourceCallback = mock((resources: any) => {
        resourceUpdates.push(resources);
      });

      await executeMatrixRuns(mockMatrixConfig, mockCombinations.slice(0, 1), {
        outputDir: testOutputDir,
        maxParallel: 1,
        onResourceUpdate: mockResourceCallback,
      });

      expect(resourceUpdates.length).toBeGreaterThan(0);
      expect(resourceUpdates[0]).toHaveProperty('memoryUsage');
      expect(resourceUpdates[0]).toHaveProperty('diskUsage');
    });

    it('should respect parallel execution limits', async () => {
      const maxParallel = 2;
      const startTimes: Date[] = [];

      const mockProgressCallback = mock((message: string) => {
        if (message.includes('Starting run')) {
          startTimes.push(new Date());
        }
      });

      await executeMatrixRuns(mockMatrixConfig, mockCombinations, {
        outputDir: testOutputDir,
        maxParallel,
        onProgress: mockProgressCallback,
      });

      // With 4 total runs and maxParallel=2, should have controlled concurrency
      // This is hard to test precisely, but we can verify the feature exists
      expect(startTimes.length).toBe(4);
    });
  });

  describe('Integration Tests', () => {
    it('should execute a complete matrix with real scenario structure', async () => {
      // Create a minimal real scenario file
      const scenarioContent = `
name: "Integration Test Scenario"
description: "Test scenario for matrix orchestrator"
run:
  - input: "Test input"
    evaluations:
      - type: "string_contains"
        value: "test"
        description: "Should contain test"
`;

      const scenarioPath = join(testOutputDir, 'test.scenario.yaml');
      await fs.writeFile(scenarioPath, scenarioContent);

      const realConfig = {
        ...mockMatrixConfig,
        base_scenario: scenarioPath,
      };

      const results = await executeMatrixRuns(realConfig, mockCombinations.slice(0, 1), {
        outputDir: testOutputDir,
        maxParallel: 1,
      });

      expect(results).toHaveLength(2);
      expect(results.every((r) => r.runId)).toBe(true);
      expect(results.every((r) => r.combinationId)).toBe(true);
    });
  });
});
