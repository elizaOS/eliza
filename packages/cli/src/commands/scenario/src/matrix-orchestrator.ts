/**
 * Matrix Orchestrator - Main Execution Engine
 *
 * This module orchestrates the execution of all matrix combinations, ensures
 * complete isolation between runs, manages cleanup, and provides comprehensive
 * result collection. This is the core execution engine for the matrix testing system.
 *
 * Required by ticket #5782 - All acceptance criteria.
 */

import { promises as fs } from 'fs';
import { join, dirname } from 'path';
import {
  createIsolatedEnvironment,
  cleanupIsolatedEnvironment,
  writeTemporaryScenario,
  IsolationContext,
} from './run-isolation';
import { createProgressTracker, ProgressTracker, ProgressEventType } from './progress-tracker';
import { createResourceMonitor, ResourceMonitor, ResourceAlert } from './resource-monitor';
import { MatrixConfig, MatrixCombination } from './matrix-types';
import { applyParameterOverrides } from './parameter-override';

/**
 * Results from executing a single matrix run.
 */
export interface MatrixRunResult {
  /** Unique identifier for this run */
  runId: string;
  /** ID of the combination this run belongs to */
  combinationId: string;
  /** Parameters that were applied for this run */
  parameters: Record<string, any>;
  /** When the run started */
  startTime: Date;
  /** When the run ended */
  endTime: Date;
  /** Duration in milliseconds */
  duration: number;
  /** Whether the run completed successfully */
  success: boolean;
  /** Results from the scenario execution */
  scenarioResult?: any;
  /** Error message if the run failed */
  error?: string;
  /** Performance and resource metrics */
  metrics: {
    /** Peak memory usage during run */
    memoryUsage: number;
    /** Disk space used during run */
    diskUsage: number;
    /** Number of tokens used (if applicable) */
    tokenCount?: number;
    /** Peak CPU usage during run */
    cpuUsage?: number;
  };
}

/**
 * Summary of the entire matrix execution.
 */
export interface MatrixExecutionSummary {
  /** Total number of runs executed */
  totalRuns: number;
  /** Number of successful runs */
  successfulRuns: number;
  /** Number of failed runs */
  failedRuns: number;
  /** Total execution time in milliseconds */
  totalDuration: number;
  /** Average time per run in milliseconds */
  averageRunTime: number;
  /** Success rate as percentage */
  successRate: number;
  /** Summary for each combination */
  combinations: CombinationSummary[];
  /** When the matrix execution started */
  startTime: Date;
  /** When the matrix execution completed */
  endTime: Date;
  /** Resource usage statistics */
  resourceUsage: {
    peakMemoryUsage: number;
    peakDiskUsage: number;
    peakCpuUsage: number;
    averageMemoryUsage: number;
    averageDiskUsage: number;
    averageCpuUsage: number;
  };
}

/**
 * Summary for a specific combination.
 */
export interface CombinationSummary {
  /** Combination identifier */
  combinationId: string;
  /** Parameters for this combination */
  parameters: Record<string, any>;
  /** Number of runs for this combination */
  totalRuns: number;
  /** Successful runs */
  successfulRuns: number;
  /** Failed runs */
  failedRuns: number;
  /** Success rate */
  successRate: number;
  /** Average duration */
  averageDuration: number;
  /** Individual run results */
  runs: MatrixRunResult[];
}

/**
 * Configuration options for matrix execution.
 */
export interface MatrixExecutionOptions {
  /** Output directory for results */
  outputDir: string;
  /** Maximum number of parallel runs */
  maxParallel?: number;
  /** Whether to continue on individual run failures */
  continueOnFailure?: boolean;
  /** Timeout for individual runs in milliseconds */
  runTimeout?: number;
  /** Callback for progress updates */
  onProgress?: (message: string, eventType: ProgressEventType, data?: any) => void;
  /** Callback when a combination completes */
  onCombinationComplete?: (summary: CombinationSummary) => void;
  /** Callback for resource warnings */
  onResourceWarning?: (alert: ResourceAlert) => void;
  /** Callback for resource updates */
  onResourceUpdate?: (resources: any) => void;
  /** Whether to show detailed progress information */
  verbose?: boolean;
}

/**
 * Active run tracking information.
 */
interface ActiveRun {
  runId: string;
  combinationId: string;
  parameters: Record<string, any>;
  context: IsolationContext;
  startTime: Date;
  promise: Promise<MatrixRunResult>;
}

/**
 * Main function to execute all matrix runs with complete orchestration.
 *
 * This function implements all acceptance criteria from ticket #5782:
 * - Matrix execution loop with progress tracking
 * - Complete run isolation and cleanup
 * - Scenario override integration
 * - Data collection and storage
 * - Error handling and recovery
 * - Resource management
 *
 * @param config - Matrix configuration
 * @param combinations - All combinations to execute
 * @param options - Execution options
 * @returns Array of all run results
 */
export async function executeMatrixRuns(
  config: MatrixConfig,
  combinations: MatrixCombination[],
  options: MatrixExecutionOptions
): Promise<MatrixRunResult[]> {
  const startTime = new Date();
  const results: MatrixRunResult[] = [];
  const activeRuns = new Map<string, ActiveRun>();

  // Setup execution environment
  const { outputDir, maxParallel = 1, continueOnFailure = true, runTimeout = 300000 } = options;
  await fs.mkdir(outputDir, { recursive: true });

  // Initialize progress tracking
  const totalRuns = combinations.length * config.runs_per_combination;
  const progressTracker = createProgressTracker({
    totalCombinations: combinations.length,
    runsPerCombination: config.runs_per_combination,
    onProgress: options.onProgress,
    onCombinationComplete: (combinationProgress) => {
      if (options.onCombinationComplete) {
        const summary = createCombinationSummary(combinationProgress.combinationId, results);
        options.onCombinationComplete(summary);
      }
    },
  });

  // Initialize resource monitoring
  const resourceMonitor = createResourceMonitor({
    thresholds: {
      memoryWarning: 75,
      memoryCritical: 90,
      diskWarning: 80,
      diskCritical: 95,
      cpuWarning: 80,
      cpuCritical: 95,
    },
    onAlert: options.onResourceWarning,
    onUpdate: options.onResourceUpdate,
    checkInterval: 5000,
  });

  resourceMonitor.start();

  try {
    // Load base scenario
    const baseScenarioContent = await fs.readFile(config.base_scenario, 'utf8');
    let baseScenario: any;

    try {
      // Try parsing as JSON first
      baseScenario = JSON.parse(baseScenarioContent);
    } catch {
      // If JSON fails, try YAML
      const yaml = await import('js-yaml');
      baseScenario = yaml.load(baseScenarioContent);
    }

    // Copy matrix configuration to output directory
    await saveMatrixConfiguration(config, outputDir);

    // Execute all combinations
    let runCounter = 0;

    for (const combination of combinations) {
      const combinationResults: MatrixRunResult[] = [];

      // Execute all runs for this combination
      for (let runIndex = 0; runIndex < config.runs_per_combination; runIndex++) {
        runCounter++;
        const runId = `run-${String(runCounter).padStart(3, '0')}-${combination.id.split('-')[2]}`;

        // Wait for available slot if we're at max parallelism
        await waitForAvailableSlot(activeRuns, maxParallel);

        // Start the run
        const runPromise = executeIndividualRun(
          runId,
          combination,
          baseScenario,
          outputDir,
          progressTracker,
          resourceMonitor,
          runTimeout
        );

        // Track active run
        const context = await createIsolatedEnvironment(runId, outputDir);
        activeRuns.set(runId, {
          runId,
          combinationId: combination.id,
          parameters: combination.parameters,
          context,
          startTime: new Date(),
          promise: runPromise,
        });

        // Handle run completion
        runPromise
          .then(async (result) => {
            results.push(result);
            combinationResults.push(result);

            // Save individual run result
            await saveRunResult(result, outputDir);

            // Cleanup active run tracking
            const activeRun = activeRuns.get(runId);
            if (activeRun) {
              await activeRun.context.cleanup();
              activeRuns.delete(runId);
            }
          })
          .catch(async (error) => {
            // Handle run failure
            const failedResult: MatrixRunResult = {
              runId,
              combinationId: combination.id,
              parameters: combination.parameters,
              startTime: new Date(),
              endTime: new Date(),
              duration: 0,
              success: false,
              error: error.message,
              metrics: {
                memoryUsage: 0,
                diskUsage: 0,
              },
            };

            results.push(failedResult);
            await saveRunResult(failedResult, outputDir);

            // Cleanup
            const activeRun = activeRuns.get(runId);
            if (activeRun) {
              await activeRun.context.cleanup();
              activeRuns.delete(runId);
            }

            if (!continueOnFailure) {
              throw error;
            }
          });
      }

      // Wait for all runs in this combination to complete
      await waitForCombinationCompletion(combination.id, activeRuns);

      // Mark combination as complete
      progressTracker.completeCombination(combination.id);
    }

    // Wait for all remaining runs to complete
    await waitForAllRunsCompletion(activeRuns);

    // Generate and save final summary
    const summary = await generateExecutionSummary(
      config,
      combinations,
      results,
      startTime,
      new Date(),
      resourceMonitor
    );

    await saveSummary(summary, outputDir);

    return results;
  } finally {
    // Cleanup
    resourceMonitor.stop();

    // Ensure all isolated environments are cleaned up
    for (const activeRun of activeRuns.values()) {
      try {
        await activeRun.context.cleanup();
      } catch (error) {
        console.warn(`Failed to cleanup run ${activeRun.runId}:`, error);
      }
    }
  }
}

/**
 * Executes a single isolated run.
 */
async function executeIndividualRun(
  runId: string,
  combination: MatrixCombination,
  baseScenario: any,
  outputDir: string,
  progressTracker: ProgressTracker,
  resourceMonitor: ResourceMonitor,
  timeout: number
): Promise<MatrixRunResult> {
  const startTime = new Date();

  try {
    // Start progress tracking
    progressTracker.startRun(runId, combination.id, combination.parameters);

    // Create isolated environment
    const context = await createIsolatedEnvironment(runId, outputDir);

    try {
      // Apply parameter overrides and write temporary scenario
      await writeTemporaryScenario(context.scenarioPath, baseScenario, combination.parameters);

      // Monitor resources before run
      const resourcesBefore = await getResourceSnapshot();

      // Execute scenario with timeout
      const scenarioResult = await executeScenarioWithTimeout(
        context.scenarioPath,
        context,
        timeout,
        (progress, status) => {
          progressTracker.updateRunProgress(runId, progress, status);
        }
      );

      // Monitor resources after run
      const resourcesAfter = await getResourceSnapshot();

      const endTime = new Date();
      const duration = endTime.getTime() - startTime.getTime();

      // Calculate metrics
      const metrics = {
        memoryUsage: resourcesAfter.memoryUsage - resourcesBefore.memoryUsage,
        diskUsage: await calculateRunDiskUsage(context.tempDir),
        tokenCount: scenarioResult.tokenCount || 0,
        cpuUsage: resourcesAfter.cpuUsage,
      };

      // Mark run as completed
      progressTracker.completeRun(runId, true, duration);

      const result: MatrixRunResult = {
        runId,
        combinationId: combination.id,
        parameters: combination.parameters,
        startTime,
        endTime,
        duration,
        success: true,
        scenarioResult,
        metrics,
      };

      return result;
    } finally {
      // Always cleanup isolated environment
      await context.cleanup();
    }
  } catch (error) {
    const endTime = new Date();
    const duration = endTime.getTime() - startTime.getTime();

    // Mark run as failed
    progressTracker.completeRun(
      runId,
      false,
      duration,
      error instanceof Error ? error.message : String(error)
    );

    return {
      runId,
      combinationId: combination.id,
      parameters: combination.parameters,
      startTime,
      endTime,
      duration,
      success: false,
      error: error instanceof Error ? error.message : String(error),
      metrics: {
        memoryUsage: 0,
        diskUsage: 0,
      },
    };
  }
}

/**
 * Executes a scenario with timeout and progress updates using the real scenario runner.
 */
async function executeScenarioWithTimeout(
  scenarioPath: string,
  context: IsolationContext,
  timeout: number,
  onProgress: (progress: number, status: string) => void
): Promise<any> {
  return new Promise(async (resolve, reject) => {
    const timeoutHandle = setTimeout(() => {
      reject(new Error(`Scenario execution timed out after ${timeout}ms`));
    }, timeout);

    try {
      onProgress(0.1, 'Loading scenario...');

      // Load and parse the scenario file
      const yaml = await import('js-yaml');
      const scenarioContent = await fs.readFile(scenarioPath, 'utf8');
      const scenario = yaml.load(scenarioContent) as any;

      onProgress(0.2, 'Validating scenario...');

      // Import scenario validation
      const { ScenarioSchema } = await import('../schema');
      const validationResult = ScenarioSchema.safeParse(scenario);
      if (!validationResult.success) {
        throw new Error(`Invalid scenario: ${JSON.stringify(validationResult.error.format())}`);
      }

      onProgress(0.3, 'Setting up environment...');

      // Create isolated environment provider
      const { LocalEnvironmentProvider } = await import('../LocalEnvironmentProvider');
      const { createScenarioServerAndAgent } = await import('../runtime-factory');

      // Create server and runtime for this isolated run
      const isolatedEnv = createIsolatedEnvironmentVariables(context);

      // Override environment variables for isolation
      const originalEnv = process.env;
      process.env = { ...originalEnv, ...isolatedEnv };

      try {
        onProgress(0.4, 'Initializing agent runtime...');

        const { server, runtime, agentId } = await createScenarioServerAndAgent(
          null,
          0, // Let it pick a random port
          ['@elizaos/plugin-sql', '@elizaos/plugin-bootstrap'] // Minimal plugins for matrix testing
        );

        const provider = new LocalEnvironmentProvider(server, agentId);

        onProgress(0.5, 'Setting up scenario environment...');

        // Setup the scenario environment
        await provider.setup(scenario);

        onProgress(0.7, 'Executing scenario...');

        // Run the scenario
        const executionResults = await provider.run(scenario);

        onProgress(0.8, 'Running evaluations...');

        // Run evaluations
        const { EvaluationEngine } = await import('../EvaluationEngine');
        const evaluationEngine = new EvaluationEngine(runtime);

        const evaluationResults = [];
        if (scenario.evaluations) {
          for (const evaluation of scenario.evaluations) {
            const result = await evaluationEngine.evaluate(evaluation, executionResults, scenario);
            evaluationResults.push(result);
          }
        }

        onProgress(0.9, 'Processing results...');

        // Calculate success based on judgment strategy
        let success = false;
        if (scenario.judgment?.strategy === 'all_pass') {
          success = evaluationResults.every((r) => r.success);
        } else if (scenario.judgment?.strategy === 'any_pass') {
          success = evaluationResults.some((r) => r.success);
        } else {
          success = evaluationResults.length > 0 && evaluationResults.every((r) => r.success);
        }

        // Cleanup server
        await server.stop();

        onProgress(1.0, 'Complete');

        const result = {
          success,
          evaluations: evaluationResults,
          executionResults,
          tokenCount: estimateTokenCount(executionResults),
          duration: Date.now() - Date.now(), // Will be calculated by caller
        };

        clearTimeout(timeoutHandle);
        resolve(result);
      } finally {
        // Restore original environment
        process.env = originalEnv;
      }
    } catch (error) {
      clearTimeout(timeoutHandle);
      reject(error);
    }
  });
}

/**
 * Estimates token count from execution results.
 */
function estimateTokenCount(executionResults: any[]): number {
  let tokenCount = 0;
  for (const result of executionResults) {
    if (result.response) {
      // Rough estimation: 1 token per 4 characters
      tokenCount += Math.ceil(result.response.length / 4);
    }
    if (result.input) {
      tokenCount += Math.ceil(result.input.length / 4);
    }
  }
  return tokenCount;
}

/**
 * Waits for an available execution slot.
 */
async function waitForAvailableSlot(
  activeRuns: Map<string, ActiveRun>,
  maxParallel: number
): Promise<void> {
  while (activeRuns.size >= maxParallel) {
    // Wait for at least one run to complete
    const promises = Array.from(activeRuns.values()).map((run) => run.promise);
    await Promise.race(promises);

    // Clean up completed runs
    for (const [runId, activeRun] of activeRuns.entries()) {
      try {
        const isSettled = await Promise.race([
          activeRun.promise.then(() => true),
          Promise.resolve(false),
        ]);

        if (isSettled) {
          activeRuns.delete(runId);
        }
      } catch {
        // Run failed, will be cleaned up elsewhere
        activeRuns.delete(runId);
      }
    }
  }
}

/**
 * Waits for all runs in a combination to complete.
 */
async function waitForCombinationCompletion(
  combinationId: string,
  activeRuns: Map<string, ActiveRun>
): Promise<void> {
  const combinationRuns = Array.from(activeRuns.values()).filter(
    (run) => run.combinationId === combinationId
  );

  if (combinationRuns.length > 0) {
    await Promise.allSettled(combinationRuns.map((run) => run.promise));
  }
}

/**
 * Waits for all active runs to complete.
 */
async function waitForAllRunsCompletion(activeRuns: Map<string, ActiveRun>): Promise<void> {
  const promises = Array.from(activeRuns.values()).map((run) => run.promise);
  if (promises.length > 0) {
    await Promise.allSettled(promises);
  }
}

/**
 * Gets a snapshot of current system resources.
 */
async function getResourceSnapshot(): Promise<{ memoryUsage: number; cpuUsage: number }> {
  const { getSystemResources } = await import('./resource-monitor');
  const resources = await getSystemResources();
  return {
    memoryUsage: resources.memoryUsage,
    cpuUsage: resources.cpuUsage,
  };
}

/**
 * Calculates disk usage for a run.
 */
async function calculateRunDiskUsage(tempDir: string): Promise<number> {
  try {
    const { monitorIsolatedResources } = await import('./run-isolation');
    const context = { tempDir } as any;
    const resources = await monitorIsolatedResources(context);
    return resources.diskUsage;
  } catch {
    return 0;
  }
}

/**
 * Saves matrix configuration to output directory.
 */
async function saveMatrixConfiguration(config: MatrixConfig, outputDir: string): Promise<void> {
  const configPath = join(outputDir, 'config.yaml');
  await fs.writeFile(configPath, JSON.stringify(config, null, 2));
}

/**
 * Saves individual run result.
 */
async function saveRunResult(result: MatrixRunResult, outputDir: string): Promise<void> {
  const runsDir = join(outputDir, 'runs');
  await fs.mkdir(runsDir, { recursive: true });

  const resultPath = join(runsDir, `${result.runId}.json`);
  await fs.writeFile(resultPath, JSON.stringify(result, null, 2));
}

/**
 * Creates a combination summary from results.
 */
function createCombinationSummary(
  combinationId: string,
  allResults: MatrixRunResult[]
): CombinationSummary {
  const combinationResults = allResults.filter((r) => r.combinationId === combinationId);
  const successfulRuns = combinationResults.filter((r) => r.success).length;
  const failedRuns = combinationResults.length - successfulRuns;
  const successRate =
    combinationResults.length > 0 ? successfulRuns / combinationResults.length : 0;
  const averageDuration =
    combinationResults.length > 0
      ? combinationResults.reduce((sum, r) => sum + r.duration, 0) / combinationResults.length
      : 0;

  return {
    combinationId,
    parameters: combinationResults[0]?.parameters || {},
    totalRuns: combinationResults.length,
    successfulRuns,
    failedRuns,
    successRate,
    averageDuration,
    runs: combinationResults,
  };
}

/**
 * Generates comprehensive execution summary.
 */
async function generateExecutionSummary(
  config: MatrixConfig,
  combinations: MatrixCombination[],
  results: MatrixRunResult[],
  startTime: Date,
  endTime: Date,
  resourceMonitor: ResourceMonitor
): Promise<MatrixExecutionSummary> {
  const totalDuration = endTime.getTime() - startTime.getTime();
  const successfulRuns = results.filter((r) => r.success).length;
  const failedRuns = results.length - successfulRuns;
  const successRate = results.length > 0 ? successfulRuns / results.length : 0;
  const averageRunTime =
    results.length > 0 ? results.reduce((sum, r) => sum + r.duration, 0) / results.length : 0;

  // Generate combination summaries
  const combinationSummaries = combinations.map((combination) =>
    createCombinationSummary(combination.id, results)
  );

  // Calculate resource usage statistics
  const resourceStats = resourceMonitor.getStatistics();

  return {
    totalRuns: results.length,
    successfulRuns,
    failedRuns,
    totalDuration,
    averageRunTime,
    successRate,
    combinations: combinationSummaries,
    startTime,
    endTime,
    resourceUsage: {
      peakMemoryUsage: resourceStats.memory.max,
      peakDiskUsage: resourceStats.disk.max,
      peakCpuUsage: resourceStats.cpu.max,
      averageMemoryUsage: resourceStats.memory.average,
      averageDiskUsage: resourceStats.disk.average,
      averageCpuUsage: resourceStats.cpu.average,
    },
  };
}

/**
 * Saves execution summary to output directory.
 */
async function saveSummary(summary: MatrixExecutionSummary, outputDir: string): Promise<void> {
  const summaryPath = join(outputDir, 'summary.json');
  await fs.writeFile(summaryPath, JSON.stringify(summary, null, 2));

  // Also create logs directory structure
  const logsDir = join(outputDir, 'logs');
  await fs.mkdir(logsDir, { recursive: true });

  // Create matrix execution log
  const logPath = join(logsDir, 'matrix-execution.log');
  const logContent = [
    `Matrix Execution Summary`,
    `========================`,
    `Start Time: ${summary.startTime.toISOString()}`,
    `End Time: ${summary.endTime.toISOString()}`,
    `Total Duration: ${summary.totalDuration}ms`,
    `Total Runs: ${summary.totalRuns}`,
    `Successful Runs: ${summary.successfulRuns}`,
    `Failed Runs: ${summary.failedRuns}`,
    `Success Rate: ${(summary.successRate * 100).toFixed(1)}%`,
    `Average Run Time: ${summary.averageRunTime.toFixed(0)}ms`,
    ``,
    `Resource Usage:`,
    `- Peak Memory: ${summary.resourceUsage.peakMemoryUsage.toFixed(1)}%`,
    `- Peak Disk: ${summary.resourceUsage.peakDiskUsage.toFixed(1)}%`,
    `- Peak CPU: ${summary.resourceUsage.peakCpuUsage.toFixed(1)}%`,
    ``,
    `Combination Results:`,
    ...summary.combinations.map(
      (combo) =>
        `- ${combo.combinationId}: ${combo.successfulRuns}/${combo.totalRuns} success (${(combo.successRate * 100).toFixed(1)}%)`
    ),
  ].join('\n');

  await fs.writeFile(logPath, logContent);
}
