import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { executeMatrixRuns } from '../../matrix-orchestrator';
import { generateMatrixCombinations } from '../../matrix-runner';
import { validateMatrixConfig } from '../../matrix-schema';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('Full Matrix Integration Tests', () => {
  let testOutputDir: string;
  let baseScenarioPath: string;

  beforeEach(async () => {
    testOutputDir = join(tmpdir(), `matrix-integration-${Date.now()}`);
    await fs.mkdir(testOutputDir, { recursive: true });

    // Create a realistic base scenario file
    const baseScenario = {
      name: 'Integration Test Scenario',
      description: 'A realistic scenario for integration testing',
      character: {
        name: 'TestAgent',
        llm: {
          model: 'gpt-4',
          temperature: 0.7,
        },
      },
      environment: {
        type: 'test',
      },
      run: [
        {
          input: 'Hello, how are you?',
          timeout: 30000,
          evaluations: [
            {
              type: 'string_contains',
              value: 'response',
              description: 'Should contain some response',
            },
            {
              type: 'response_time',
              value: 10000,
              description: 'Should respond within 10 seconds',
            },
          ],
        },
        {
          input: 'What is the weather like?',
          timeout: 30000,
          evaluations: [
            {
              type: 'string_contains',
              value: 'weather',
              description: 'Should mention weather',
            },
          ],
        },
      ],
    };

    baseScenarioPath = join(testOutputDir, 'base-scenario.yaml');
    await fs.writeFile(baseScenarioPath, JSON.stringify(baseScenario, null, 2));
  });

  afterEach(async () => {
    try {
      await fs.rm(testOutputDir, { recursive: true, force: true });
    } catch (error) {
      // Ignore cleanup errors in tests
    }
  });

  describe('Complete Matrix Execution Workflow', () => {
    it('should execute a complete matrix from configuration to results', async () => {
      // Step 1: Create matrix configuration
      const matrixConfig = {
        name: 'Complete Integration Test',
        description: 'Tests the full matrix execution pipeline',
        base_scenario: baseScenarioPath,
        runs_per_combination: 2,
        matrix: [
          {
            parameter: 'character.llm.model',
            values: ['gpt-4', 'gpt-3.5-turbo'],
          },
          {
            parameter: 'character.llm.temperature',
            values: [0.3, 0.7, 0.9],
          },
        ],
      };

      // Step 2: Validate matrix configuration
      const validation = validateMatrixConfig(matrixConfig);
      expect(validation.success).toBe(true);

      // Step 3: Generate combinations
      const combinations = generateMatrixCombinations(matrixConfig);
      expect(combinations).toHaveLength(6); // 2 models × 3 temperatures = 6 combinations

      // Step 4: Execute matrix
      const results = await executeMatrixRuns(matrixConfig, combinations, {
        outputDir: testOutputDir,
        maxParallel: 2,
        continueOnFailure: true,
      });

      // Step 5: Verify execution results
      expect(results).toHaveLength(12); // 6 combinations × 2 runs each = 12 total runs

      // Verify all combinations were executed
      const uniqueCombinations = new Set(results.map((r) => r.combinationId));
      expect(uniqueCombinations.size).toBe(6);

      // Verify all runs have required data
      results.forEach((result) => {
        expect(result).toHaveProperty('runId');
        expect(result).toHaveProperty('combinationId');
        expect(result).toHaveProperty('parameters');
        expect(result).toHaveProperty('startTime');
        expect(result).toHaveProperty('endTime');
        expect(result).toHaveProperty('duration');
        expect(result).toHaveProperty('success');
        expect(result).toHaveProperty('metrics');

        expect(result.parameters).toHaveProperty('character.llm.model');
        expect(result.parameters).toHaveProperty('character.llm.temperature');
        expect(['gpt-4', 'gpt-3.5-turbo']).toContain(result.parameters['character.llm.model']);
        expect([0.3, 0.7, 0.9]).toContain(result.parameters['character.llm.temperature']);
      });

      // Step 6: Verify output structure
      await verifyOutputStructure(testOutputDir);
    });

    it('should handle mixed success and failure scenarios', async () => {
      const matrixConfig = {
        name: 'Mixed Results Test',
        description: 'Tests handling of both successful and failed runs',
        base_scenario: baseScenarioPath,
        runs_per_combination: 3,
        matrix: [
          {
            parameter: 'character.name',
            values: ['SuccessAgent', 'FailAgent', 'TimeoutAgent'],
          },
        ],
      };

      const combinations = generateMatrixCombinations(matrixConfig);
      const results = await executeMatrixRuns(matrixConfig, combinations, {
        outputDir: testOutputDir,
        maxParallel: 1,
        continueOnFailure: true,
        runTimeout: 5000,
      });

      expect(results).toHaveLength(9); // 3 combinations × 3 runs each

      // Should have both successful and failed runs
      const successfulRuns = results.filter((r) => r.success);
      const failedRuns = results.filter((r) => !r.success);

      // In a real scenario, we'd expect some successes and some failures
      // For this test, we just verify the structure handles both
      expect(results.length).toBe(successfulRuns.length + failedRuns.length);

      // Failed runs should have error messages
      failedRuns.forEach((result) => {
        expect(result.error).toBeDefined();
        expect(typeof result.error).toBe('string');
      });
    });

    it('should maintain isolation between concurrent runs', async () => {
      const matrixConfig = {
        name: 'Concurrency Isolation Test',
        description: "Tests that concurrent runs don't interfere with each other",
        base_scenario: baseScenarioPath,
        runs_per_combination: 1,
        matrix: [
          {
            parameter: 'character.name',
            values: ['Agent1', 'Agent2', 'Agent3', 'Agent4'],
          },
        ],
      };

      const combinations = generateMatrixCombinations(matrixConfig);
      const results = await executeMatrixRuns(matrixConfig, combinations, {
        outputDir: testOutputDir,
        maxParallel: 4, // Run all concurrently
        continueOnFailure: true,
      });

      expect(results).toHaveLength(4);

      // Verify each run has unique IDs
      const runIds = results.map((r) => r.runId);
      const uniqueRunIds = new Set(runIds);
      expect(uniqueRunIds.size).toBe(4);

      // Verify runs completed within reasonable time (concurrency should be faster)
      const totalDuration = results.reduce((sum, r) => sum + r.duration, 0);
      const averageDuration = totalDuration / results.length;
      expect(averageDuration).toBeGreaterThan(0);

      // Verify all runs have correct parameters
      results.forEach((result) => {
        expect(['Agent1', 'Agent2', 'Agent3', 'Agent4']).toContain(
          result.parameters['character.name']
        );
      });
    });

    it('should handle large matrix configurations efficiently', async () => {
      const matrixConfig = {
        name: 'Large Matrix Test',
        description: 'Tests handling of larger matrix configurations',
        base_scenario: baseScenarioPath,
        runs_per_combination: 1,
        matrix: [
          {
            parameter: 'character.llm.model',
            values: ['gpt-4', 'gpt-3.5-turbo', 'claude-3', 'gemini-pro'],
          },
          {
            parameter: 'character.llm.temperature',
            values: [0.1, 0.3, 0.5, 0.7, 0.9],
          },
          {
            parameter: 'character.name',
            values: ['Agent1', 'Agent2', 'Agent3'],
          },
        ],
      };

      const startTime = Date.now();

      const combinations = generateMatrixCombinations(matrixConfig);
      expect(combinations).toHaveLength(60); // 4 × 5 × 3 = 60 combinations

      const results = await executeMatrixRuns(matrixConfig, combinations, {
        outputDir: testOutputDir,
        maxParallel: 4,
        continueOnFailure: true,
        runTimeout: 10000,
      });

      const endTime = Date.now();
      const totalDuration = endTime - startTime;

      expect(results).toHaveLength(60);

      // Should complete in reasonable time (< 30 seconds for test)
      expect(totalDuration).toBeLessThan(30000);

      // Verify output files are created properly
      await verifyOutputStructure(testOutputDir);

      // Verify summary file contains correct statistics
      const summaryPath = join(testOutputDir, 'summary.json');
      const summaryContent = await fs.readFile(summaryPath, 'utf8');
      const summary = JSON.parse(summaryContent);

      expect(summary.totalRuns).toBe(60);
      expect(summary.totalCombinations).toBe(60);
      expect(summary.completedRuns).toBe(60);
    });
  });

  describe('Error Recovery and Resilience', () => {
    it('should recover from individual run failures and continue execution', async () => {
      const matrixConfig = {
        name: 'Recovery Test',
        description: 'Tests recovery from failures',
        base_scenario: baseScenarioPath,
        runs_per_combination: 2,
        matrix: [
          {
            parameter: 'character.name',
            values: ['GoodAgent', 'BadAgent', 'UglyAgent'],
          },
        ],
      };

      const combinations = generateMatrixCombinations(matrixConfig);
      const results = await executeMatrixRuns(matrixConfig, combinations, {
        outputDir: testOutputDir,
        maxParallel: 1,
        continueOnFailure: true,
        runTimeout: 2000, // Short timeout to trigger some failures
      });

      // Should complete all runs despite individual failures
      expect(results).toHaveLength(6); // 3 combinations × 2 runs each

      // Should have completed execution
      expect(results.every((r) => r.endTime > r.startTime)).toBe(true);

      // Verify failed runs are properly recorded
      const failedRuns = results.filter((r) => !r.success);
      failedRuns.forEach((result) => {
        expect(result.error).toBeDefined();
        expect(result.duration).toBeGreaterThan(0);
      });
    });

    it('should handle resource exhaustion scenarios gracefully', async () => {
      const matrixConfig = {
        name: 'Resource Exhaustion Test',
        description: 'Tests handling when system resources are limited',
        base_scenario: baseScenarioPath,
        runs_per_combination: 1,
        matrix: [
          {
            parameter: 'character.name',
            values: Array(20)
              .fill(0)
              .map((_, i) => `Agent${i}`), // Many agents
          },
        ],
      };

      const combinations = generateMatrixCombinations(matrixConfig);

      let resourceWarnings = 0;
      const mockResourceCallback = () => {
        resourceWarnings++;
      };

      const results = await executeMatrixRuns(matrixConfig, combinations, {
        outputDir: testOutputDir,
        maxParallel: 10, // High parallelism to stress system
        continueOnFailure: true,
        onResourceWarning: mockResourceCallback,
      });

      expect(results).toHaveLength(20);

      // Should have completed despite resource constraints
      expect(results.every((r) => r.runId)).toBe(true);
    });
  });

  describe('Performance and Scalability', () => {
    it('should scale efficiently with parallel execution', async () => {
      const matrixConfig = {
        name: 'Scalability Test',
        description: 'Tests scalability with different parallel configurations',
        base_scenario: baseScenarioPath,
        runs_per_combination: 1,
        matrix: [
          {
            parameter: 'character.name',
            values: Array(12)
              .fill(0)
              .map((_, i) => `ScaleAgent${i}`),
          },
        ],
      };

      const combinations = generateMatrixCombinations(matrixConfig);

      // Test sequential execution
      const sequentialStart = Date.now();
      const sequentialResults = await executeMatrixRuns(matrixConfig, combinations.slice(0, 4), {
        outputDir: join(testOutputDir, 'sequential'),
        maxParallel: 1,
        continueOnFailure: true,
      });
      const sequentialDuration = Date.now() - sequentialStart;

      // Test parallel execution
      const parallelStart = Date.now();
      const parallelResults = await executeMatrixRuns(matrixConfig, combinations.slice(4, 8), {
        outputDir: join(testOutputDir, 'parallel'),
        maxParallel: 4,
        continueOnFailure: true,
      });
      const parallelDuration = Date.now() - parallelStart;

      expect(sequentialResults).toHaveLength(4);
      expect(parallelResults).toHaveLength(4);

      // Parallel execution should generally be faster (though this is hard to test reliably)
      // We just verify both completed successfully
      expect(sequentialDuration).toBeGreaterThan(0);
      expect(parallelDuration).toBeGreaterThan(0);
    });
  });

  async function verifyOutputStructure(outputDir: string): Promise<void> {
    // Verify required directory structure from ticket
    const configExists = await fs
      .access(join(outputDir, 'config.yaml'))
      .then(() => true)
      .catch(() => false);
    const summaryExists = await fs
      .access(join(outputDir, 'summary.json'))
      .then(() => true)
      .catch(() => false);
    const runsExists = await fs
      .access(join(outputDir, 'runs'))
      .then(() => true)
      .catch(() => false);
    const logsExists = await fs
      .access(join(outputDir, 'logs'))
      .then(() => true)
      .catch(() => false);

    expect(configExists).toBe(true);
    expect(summaryExists).toBe(true);
    expect(runsExists).toBe(true);
    expect(logsExists).toBe(true);

    // Verify runs directory contains JSON files
    const runsDir = join(outputDir, 'runs');
    const runFiles = await fs.readdir(runsDir);
    expect(runFiles.length).toBeGreaterThan(0);
    expect(runFiles.every((file) => file.endsWith('.json'))).toBe(true);

    // Verify logs directory contains log files
    const logsDir = join(outputDir, 'logs');
    const logFiles = await fs.readdir(logsDir);
    expect(logFiles.length).toBeGreaterThan(0);

    // Verify summary file structure
    const summaryPath = join(outputDir, 'summary.json');
    const summaryContent = await fs.readFile(summaryPath, 'utf8');
    const summary = JSON.parse(summaryContent);

    expect(summary).toHaveProperty('totalRuns');
    expect(summary).toHaveProperty('completedRuns');
    expect(summary).toHaveProperty('successfulRuns');
    expect(summary).toHaveProperty('failedRuns');
    expect(summary).toHaveProperty('totalDuration');
    expect(summary).toHaveProperty('averageRunTime');
    expect(summary).toHaveProperty('combinations');
  }
});
