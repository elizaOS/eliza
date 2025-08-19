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
import { generateRunFilename } from './file-naming-utils';
import { processManager } from './process-manager';
import { MatrixCombination } from './matrix-types';
import { applyParameterOverrides } from './parameter-override';
import { MatrixConfig } from './matrix-schema';

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
  console.log('🔧 [DEBUG] executeMatrixRuns started');
  const startTime = new Date();
  const results: MatrixRunResult[] = [];
  const activeRuns = new Map<string, ActiveRun>();

  // Log initial process state
  const initialSummary = processManager.getSummary();
  console.log(`🔧 [DEBUG] [ProcessManager] Initial state: ${initialSummary.total} processes tracked`);

  console.log('🔧 [DEBUG] About to setup execution environment');

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
    console.log('🔧 [DEBUG] About to read base scenario file');
    const baseScenarioContent = await fs.readFile(config.base_scenario, 'utf8');
    console.log('🔧 [DEBUG] Base scenario file read successfully');
    let baseScenario: any;

    try {
      // Try parsing as JSON first
      console.log('🔧 [DEBUG] Attempting to parse as JSON');
      baseScenario = JSON.parse(baseScenarioContent);
      console.log('🔧 [DEBUG] JSON parsing successful');
    } catch {
      // If JSON fails, try YAML
      console.log('🔧 [DEBUG] JSON parsing failed, attempting YAML import');
      const yaml = await import('js-yaml');
      console.log('🔧 [DEBUG] YAML import successful, parsing content');
      baseScenario = yaml.load(baseScenarioContent);
      console.log('🔧 [DEBUG] YAML parsing successful');
    }

    console.log('🔧 [DEBUG] About to save matrix configuration');
    // Copy matrix configuration to output directory
    await saveMatrixConfiguration(config, outputDir);
    console.log('🔧 [DEBUG] Matrix configuration saved successfully');

    console.log('🔧 [DEBUG] About to execute all combinations');
    // Execute all combinations
    let runCounter = 0;
    console.log(`🔧 [DEBUG] Total combinations to execute: ${combinations.length}`);

    console.log('🔧 [DEBUG] About to start execution loop');
    for (const combination of combinations) {
      console.log(`🔧 [DEBUG] Processing combination: ${combination.id}`);
      const combinationResults: MatrixRunResult[] = [];
      console.log(`🔧 [DEBUG] About to process ${config.runs_per_combination} runs for this combination`);

      // Execute all runs for this combination
      console.log('🔧 [DEBUG] About to start processing runs for this combination');
      for (let runIndex = 0; runIndex < config.runs_per_combination; runIndex++) {
        console.log(`🔧 [DEBUG] About to process run ${runIndex + 1} of ${config.runs_per_combination}`);
        console.log(`🔧 [DEBUG] Current active runs count: ${activeRuns.size}`);
        console.log(`🔧 [DEBUG] Max parallel execution: ${maxParallel}`);
        const memoryUsage = process.memoryUsage();
        console.log(`🔧 [DEBUG] Current memory usage: ${memoryUsage.heapUsed / 1024 / 1024} MB`);
        console.log(`🔧 [DEBUG] Total memory usage: ${memoryUsage.heapTotal / 1024 / 1024} MB`);

        // Check if memory usage is too high and force cleanup
        if (memoryUsage.heapUsed > 500 * 1024 * 1024) { // 500MB threshold
          console.log(`🔧 [DEBUG] High memory usage detected, forcing cleanup...`);
          if (global.gc) {
            global.gc();
            console.log(`🔧 [DEBUG] Forced garbage collection due to high memory usage`);
          }
        }

        runCounter++;
        const runId = generateRunFilename(runCounter);
        console.log(`🔧 [DEBUG] Generated runId: ${runId}`);
        console.log(`🔧 [DEBUG] Combination parameters:`, JSON.stringify(combination.parameters, null, 2));

        // Wait for available slot if we're at max parallelism
        console.log(`🔧 [DEBUG] Waiting for available slot... (active runs: ${activeRuns.size}/${maxParallel})`);
        await waitForAvailableSlot(activeRuns, maxParallel);
        console.log(`🔧 [DEBUG] Slot available, about to start the run ${runId}`);
        console.log(`🔧 [DEBUG] About to call executeIndividualRun with timeout: ${runTimeout}ms`);

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
        console.log(`🔧 [DEBUG] Creating isolated environment for runId: ${runId}`);
        const context = await createIsolatedEnvironment(runId, outputDir);
        console.log(`🔧 [DEBUG] Isolated environment created, adding to active runs`);
        activeRuns.set(runId, {
          runId,
          combinationId: combination.id,
          parameters: combination.parameters,
          context,
          startTime: new Date(),
          promise: runPromise,
        });
        console.log(`🔧 [DEBUG] Active runs after adding: ${activeRuns.size}`);

        // Handle run completion
        console.log(`🔧 [DEBUG] Setting up completion handlers for runId: ${runId}`);
        runPromise
          .then(async (result) => {
            console.log(`🔧 [DEBUG] Run ${runId} completed successfully`);
            results.push(result);
            combinationResults.push(result);

            // Save individual run result
            await saveRunResult(result, outputDir);

            // Cleanup active run tracking
            const activeRun = activeRuns.get(runId);
            if (activeRun) {
              console.log(`🔧 [DEBUG] Cleaning up resources for runId: ${runId}`);
              try {
                await activeRun.context.cleanup();
                console.log(`🔧 [DEBUG] Context cleanup completed for runId: ${runId}`);
              } catch (cleanupError) {
                console.log(`🔧 [DEBUG] Context cleanup failed for runId: ${runId}: ${cleanupError}`);
              }
              activeRuns.delete(runId);
              console.log(`🔧 [DEBUG] Active runs after cleanup: ${activeRuns.size}`);

              // Force garbage collection if available
              if (global.gc) {
                global.gc();
                console.log(`🔧 [DEBUG] Forced garbage collection after runId: ${runId}`);
              }
            }
          })
          .catch(async (error) => {
            console.log(`🔧 [DEBUG] Run ${runId} failed with error: ${error.message}`);
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

            // Enhanced cleanup for failed runs
            const activeRun = activeRuns.get(runId);
            if (activeRun) {
              console.log(`🔧 [DEBUG] Cleaning up failed run resources for runId: ${runId}`);
              try {
                await activeRun.context.cleanup();
                console.log(`🔧 [DEBUG] Failed run context cleanup completed for runId: ${runId}`);
              } catch (cleanupError) {
                console.log(`🔧 [DEBUG] Failed run context cleanup failed for runId: ${runId}: ${cleanupError}`);
              }
              activeRuns.delete(runId);
              console.log(`🔧 [DEBUG] Active runs after failed run cleanup: ${activeRuns.size}`);

              // Force garbage collection if available
              if (global.gc) {
                global.gc();
                console.log(`🔧 [DEBUG] Forced garbage collection after failed runId: ${runId}`);
              }
            }

            if (!continueOnFailure) {
              throw error;
            }
          });
      }

      // Wait for all runs in this combination to complete
      console.log(`🔧 [DEBUG] Waiting for combination ${combination.id} to complete...`);
      try {
        await waitForCombinationCompletion(combination.id, activeRuns);
        console.log(`🔧 [DEBUG] Combination ${combination.id} completed successfully`);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.log(`🔧 [DEBUG] Combination ${combination.id} failed: ${errorMessage}`);
        // Continue with next combination even if this one failed
        if (!continueOnFailure) {
          throw error;
        }
      }

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

    // Log final process state before cleanup
    const finalSummary = processManager.getSummary();
    console.log(`🔧 [DEBUG] [ProcessManager] Final state: ${finalSummary.total} processes tracked`);
    if (finalSummary.total > 0) {
      console.log(`🔧 [DEBUG] [ProcessManager] Process types:`, finalSummary.byType);
    }

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
  console.log(`🔧 [DEBUG] executeIndividualRun started for runId: ${runId} with timeout: ${timeout}ms`);
  const startTime = new Date();

  // Add timeout wrapper to prevent hanging
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => {
      reject(new Error(`Run ${runId} timed out after ${timeout}ms`));
    }, timeout);
  });

  try {
    console.log(`🔧 [DEBUG] executeIndividualRun: Starting progress tracking for runId: ${runId}`);
    // Start progress tracking
    progressTracker.startRun(runId, combination.id, combination.parameters);

    console.log(`🔧 [DEBUG] executeIndividualRun: About to create isolated environment for runId: ${runId}`);
    // Create isolated environment
    const context = await createIsolatedEnvironment(runId, outputDir);
    console.log(`🔧 [DEBUG] executeIndividualRun: Isolated environment created successfully for runId: ${runId}`);

    try {
      console.log(`🔧 [DEBUG] executeIndividualRun: About to write temporary scenario for runId: ${runId}`);
      // Apply parameter overrides and write temporary scenario
      await writeTemporaryScenario(context.scenarioPath, baseScenario, combination.parameters);
      console.log(`🔧 [DEBUG] executeIndividualRun: Temporary scenario written successfully for runId: ${runId}`);

      console.log(`🔧 [DEBUG] executeIndividualRun: About to get resource snapshot before run for runId: ${runId}`);
      // Monitor resources before run
      const resourcesBefore = await getResourceSnapshot();
      console.log(`🔧 [DEBUG] executeIndividualRun: Resource snapshot before run completed for runId: ${runId}`);

      console.log(`🔧 [DEBUG] executeIndividualRun: About to execute scenario with timeout for runId: ${runId}, timeout: ${timeout}ms`);
      // Execute scenario with timeout and race against timeout wrapper
      const scenarioResult = await Promise.race([
        executeScenarioWithTimeout(
          context.scenarioPath,
          context,
          timeout,
          (progress, status) => {
            progressTracker.updateRunProgress(runId, progress, status);
          }
        ),
        timeoutPromise
      ]);
      console.log(`🔧 [DEBUG] executeIndividualRun: Scenario execution completed successfully for runId: ${runId}`);

      console.log(`🔧 [DEBUG] executeIndividualRun: About to get resource snapshot after run for runId: ${runId}`);
      // Monitor resources after run
      const resourcesAfter = await getResourceSnapshot();
      console.log(`🔧 [DEBUG] executeIndividualRun: Resource snapshot after run completed for runId: ${runId}`);

      console.log(`🔧 [DEBUG] executeIndividualRun: About to calculate metrics for runId: ${runId}`);
      const endTime = new Date();
      const duration = endTime.getTime() - startTime.getTime();

      // Calculate metrics
      const metrics = {
        memoryUsage: resourcesAfter.memoryUsage - resourcesBefore.memoryUsage,
        diskUsage: await calculateRunDiskUsage(context.tempDir),
        tokenCount: scenarioResult.tokenCount || 0,
        cpuUsage: resourcesAfter.cpuUsage,
      };

      console.log(`🔧 [DEBUG] executeIndividualRun: About to mark run as completed for runId: ${runId}`);
      // Mark run as completed
      progressTracker.completeRun(runId, true, duration);
      console.log(`🔧 [DEBUG] executeIndividualRun: Run marked as completed for runId: ${runId}`);

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

      console.log(`🔧 [DEBUG] executeIndividualRun: About to return result for runId: ${runId}`);
      return result;
    } finally {
      console.log(`🔧 [DEBUG] executeIndividualRun: About to cleanup isolated environment for runId: ${runId}`);
      // Always cleanup isolated environment
      await context.cleanup();
      console.log(`🔧 [DEBUG] executeIndividualRun: Isolated environment cleanup completed for runId: ${runId}`);
    }
  } catch (error) {
    console.log(`🔧 [DEBUG] executeIndividualRun: Error occurred for runId: ${runId}, error: ${error}`);
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
      const { ScenarioSchema } = await import('./schema');
      const validationResult = ScenarioSchema.safeParse(scenario);
      if (!validationResult.success) {
        throw new Error(`Invalid scenario: ${JSON.stringify(validationResult.error.format())}`);
      }

      onProgress(0.3, 'Setting up environment...');

      // Create isolated environment provider
      const { LocalEnvironmentProvider } = await import('./LocalEnvironmentProvider');
      const { createScenarioServerAndAgent, shutdownScenarioServer } = await import('./runtime-factory');

      // Create server and runtime for this isolated run
      // Use the context directly for isolation

      // Override environment variables for isolation
      const originalEnv = process.env;
      // Set up isolated environment variables
      process.env = {
        ...originalEnv,
        ELIZAOS_DB_PATH: context.dbPath,
        ELIZAOS_LOG_PATH: context.logPath,
        ELIZAOS_TEMP_DIR: context.tempDir
      };

      try {
        onProgress(0.4, 'Initializing agent runtime...');

        const { server, runtime, agentId, port } = await createScenarioServerAndAgent(
          null,
          0, // Let it pick a random port
          ['@elizaos/plugin-sql', '@elizaos/plugin-bootstrap'] // Minimal plugins for matrix testing
        );

        const provider = new LocalEnvironmentProvider(server, agentId, runtime as any);

        onProgress(0.5, 'Setting up scenario environment...');

        // Setup the scenario environment
        await provider.setup(scenario);

        onProgress(0.7, 'Executing scenario...');

        // Run the scenario
        const executionResults = await provider.run(scenario);

        onProgress(0.8, 'Running evaluations...');

        // Run evaluations
        const { EvaluationEngine } = await import('./EvaluationEngine');
        const evaluationEngine = new EvaluationEngine(runtime as any);

        const evaluationResults = [];
        if (scenario.evaluations && executionResults.length > 0) {
          // Run evaluations on the first execution result
          const results = await evaluationEngine.runEvaluations(scenario.evaluations, executionResults[0]);
          evaluationResults.push(...results);
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

        // Cleanup server using proper shutdown function
        await shutdownScenarioServer(server, port);

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
