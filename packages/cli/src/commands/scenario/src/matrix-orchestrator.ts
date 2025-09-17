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
import { join } from 'path';
import {
  createIsolatedEnvironment,
  writeTemporaryScenario,
  IsolationContext,
} from './run-isolation';
import { createProgressTracker, ProgressTracker, ProgressEventType } from './progress-tracker';
import { createResourceMonitor, ResourceMonitor, ResourceAlert } from './resource-monitor';
import { generateRunFilename } from './file-naming-utils';
import { processManager } from './process-manager';
import { MatrixCombination } from './matrix-types';
// import { applyParameterOverrides } from './parameter-override'; // unused
import { MatrixConfig } from './matrix-schema';
import { IAgentRuntime, UUID } from '@elizaos/core';
import { AgentServer } from '@elizaos/server';
import { Scenario } from './schema';

/**
 * Results from executing a single matrix run.
 */
export interface MatrixRunResult {
  /** Unique identifier for this run */
  runId: string;
  /** ID of the combination this run belongs to */
  combinationId: string;
  /** Parameters that were applied for this run */
  parameters: Record<string, unknown>;
  /** When the run started */
  startTime: Date;
  /** When the run ended */
  endTime: Date;
  /** Duration in milliseconds */
  duration: number;
  /** Whether the run completed successfully */
  success: boolean;
  /** Results from the scenario execution */
  scenarioResult?: unknown;
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
  parameters: Record<string, unknown>;
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
  onProgress?: (message: string, eventType: ProgressEventType, data?: unknown) => void;
  /** Callback when a combination completes */
  onCombinationComplete?: (summary: CombinationSummary) => void;
  /** Callback for resource warnings */
  onResourceWarning?: (alert: ResourceAlert) => void;
  /** Callback for resource updates */
  onResourceUpdate?: (resources: unknown) => void;
  /** Whether to show detailed progress information */
  verbose?: boolean;
}

/**
 * Active run tracking information.
 */
interface ActiveRun {
  runId: string;
  combinationId: string;
  parameters: Record<string, unknown>;
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

  // Declare shared server at function scope for cleanup
  let sharedServer: { server: AgentServer; port: number } | null = null;

  // Log initial process state
  const initialSummary = processManager.getSummary();
  console.log(
    `🔧 [DEBUG] [ProcessManager] Initial state: ${initialSummary.total} processes tracked`
  );

  console.log('🔧 [DEBUG] About to setup execution environment');

  // Setup execution environment
  const { outputDir, maxParallel = 1, continueOnFailure = true, runTimeout = 300000 } = options;
  await fs.mkdir(outputDir, { recursive: true });

  // Initialize progress tracking
  // const totalRuns = combinations.length * config.runs_per_combination; // unused
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
    let baseScenario: Scenario;

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
      baseScenario = yaml.load(baseScenarioContent) as Scenario;
      console.log('🔧 [DEBUG] YAML parsing successful');
    }

    console.log('🔧 [DEBUG] About to save matrix configuration');
    // Copy matrix configuration to output directory
    await saveMatrixConfiguration(config, outputDir);
    console.log('🔧 [DEBUG] Matrix configuration saved successfully');

    console.log('🔧 [DEBUG] About to execute all combinations');

    // Extract plugins from base scenario configuration (restore dynamic plugin loading)
    console.log('🔧 [DEBUG] Extracting dynamic plugins from scenario configuration...');
    const defaultPlugins = ['@elizaos/plugin-sql', '@elizaos/plugin-bootstrap']; // Always include core plugins
    const scenarioPlugins = Array.isArray(baseScenario.plugins)
      ? baseScenario.plugins
          .filter((p: any) => typeof p === 'string' || p.enabled !== false) // Only include enabled plugins (default to true if not specified)
          .map((p: string | { name: string }) => (typeof p === 'string' ? p : p.name)) // Extract name if it's an object
      : [];
    const finalPlugins = Array.from(
      new Set([...scenarioPlugins, ...defaultPlugins, '@elizaos/plugin-openai'])
    ); // Always include OpenAI for responses
    console.log(`🔧 [DEBUG] Dynamic plugins loaded: ${JSON.stringify(finalPlugins)}`);

    console.log(
      `🔧 [DEBUG] Shared server condition check: combinations.length=${combinations.length}, runs_per_combination=${config.runs_per_combination}`
    );

    if (combinations.length > 1 || config.runs_per_combination > 1) {
      console.log(
        '🔧 [DEBUG] Matrix testing detected - creating shared server for better isolation...'
      );
      const { createScenarioServer } = await import('./runtime-factory');

      try {
        console.log(
          `🔧 [DEBUG] Calling createScenarioServer(null, 3000)... (using fixed port 3000 for MessageBusService compatibility)`
        );
        const serverResult = await createScenarioServer(null, 3000);
        sharedServer = {
          server: serverResult.server,
          port: serverResult.port,
        };
        console.log(
          `🔧 [DEBUG] ✅ Shared server created successfully on port ${sharedServer.port}`
        );
        console.log(
          `🔧 [DEBUG] ✅ Server result details: port=${serverResult.port}, createdServer=${serverResult.createdServer}`
        );
      } catch (error) {
        console.log(
          `🔧 [DEBUG] ❌ Failed to create shared server, falling back to individual servers: ${error}`
        );
        sharedServer = null;
      }
    }

    // Execute all combinations
    let runCounter = 0;
    console.log(`🔧 [DEBUG] Total combinations to execute: ${combinations.length}`);

    console.log('🔧 [DEBUG] About to start execution loop');
    for (const combination of combinations) {
      console.log(`🔧 [DEBUG] Processing combination: ${combination.id}`);
      const combinationResults: MatrixRunResult[] = [];
      console.log(
        `🔧 [DEBUG] About to process ${config.runs_per_combination} runs for this combination`
      );

      // Execute all runs for this combination
      console.log('🔧 [DEBUG] About to start processing runs for this combination');
      for (let runIndex = 0; runIndex < config.runs_per_combination; runIndex++) {
        console.log(
          `🔧 [DEBUG] About to process run ${runIndex + 1} of ${config.runs_per_combination}`
        );
        console.log(`🔧 [DEBUG] Current active runs count: ${activeRuns.size}`);
        console.log(`🔧 [DEBUG] Max parallel execution: ${maxParallel}`);
        const memoryUsage = process.memoryUsage();
        console.log(`🔧 [DEBUG] Current memory usage: ${memoryUsage.heapUsed / 1024 / 1024} MB`);
        console.log(`🔧 [DEBUG] Total memory usage: ${memoryUsage.heapTotal / 1024 / 1024} MB`);

        // Check if memory usage is too high and force cleanup
        if (memoryUsage.heapUsed > 500 * 1024 * 1024) {
          // 500MB threshold
          console.log(`🔧 [DEBUG] High memory usage detected, forcing cleanup...`);
          if (global.gc) {
            global.gc();
            console.log(`🔧 [DEBUG] Forced garbage collection due to high memory usage`);
          }
        }

        runCounter++;
        const runId = generateRunFilename(runCounter);
        console.log(`🔧 [DEBUG] Generated runId: ${runId}`);
        console.log(
          `🔧 [DEBUG] Combination parameters:`,
          JSON.stringify(combination.parameters, null, 2)
        );

        // Wait for available slot if we're at max parallelism
        console.log(
          `🔧 [DEBUG] Waiting for available slot... (active runs: ${activeRuns.size}/${maxParallel})`
        );
        await waitForAvailableSlot(activeRuns, maxParallel);
        console.log(`🔧 [DEBUG] Slot available, about to start the run ${runId}`);
        console.log(`🔧 [DEBUG] About to call executeIndividualRun with timeout: ${runTimeout}ms`);

        // Start the run (with optional shared server)
        const runPromise = executeIndividualRun(
          runId,
          combination,
          baseScenario,
          outputDir,
          progressTracker,
          resourceMonitor,
          runTimeout,
          sharedServer ?? undefined, // Pass shared server if available
          finalPlugins // Pass dynamic plugins from scenario configuration
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
                console.log(
                  `🔧 [DEBUG] Context cleanup failed for runId: ${runId}: ${cleanupError}`
                );
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

            // Capture actual resource usage even for failed runs
            let resourceMetrics = {
              memoryUsage: 0,
              diskUsage: 0,
              tokenCount: 0,
              cpuUsage: 0,
            };

            try {
              const resourcesAfter = await getResourceSnapshot();
              const activeRun = activeRuns.get(runId);
              if (activeRun) {
                resourceMetrics = {
                  memoryUsage: resourcesAfter.memoryUsage,
                  diskUsage: await calculateRunDiskUsage(activeRun.context.tempDir),
                  tokenCount: 0, // No scenario result to estimate from
                  cpuUsage: resourcesAfter.cpuUsage,
                };
              }
            } catch (metricsError) {
              console.log(
                `🔧 [DEBUG] Failed to capture metrics for failed run ${runId}: ${metricsError}`
              );
            }

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
              metrics: resourceMetrics,
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
                console.log(
                  `🔧 [DEBUG] Failed run context cleanup failed for runId: ${runId}: ${cleanupError}`
                );
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
    // Cleanup shared server if it was created
    if (sharedServer) {
      console.log(`🔧 [DEBUG] Shutting down shared server on port ${sharedServer.port}...`);
      try {
        const { shutdownScenarioServer } = await import('./runtime-factory');
        await shutdownScenarioServer(sharedServer.server, sharedServer.port);
        console.log(`🔧 [DEBUG] ✅ Shared server shutdown completed`);
      } catch (error) {
        console.log(`🔧 [DEBUG] ❌ Failed to shutdown shared server: ${error}`);
      }
    }

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
  baseScenario: Scenario,
  outputDir: string,
  progressTracker: ProgressTracker,
  _resourceMonitor: ResourceMonitor,
  timeout: number,
  sharedServer?: { server: AgentServer; port: number }, // Optional shared server for matrix testing
  dynamicPlugins?: string[] // Plugins extracted from scenario configuration
): Promise<MatrixRunResult> {
  console.log(
    `🔧 [DEBUG] executeIndividualRun started for runId: ${runId} with timeout: ${timeout}ms`
  );
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

    console.log(
      `🔧 [DEBUG] executeIndividualRun: About to create isolated environment for runId: ${runId}`
    );
    // Create isolated environment
    const context = await createIsolatedEnvironment(runId, outputDir);
    console.log(
      `🔧 [DEBUG] executeIndividualRun: Isolated environment created successfully for runId: ${runId}`
    );

    try {
      console.log(
        `🔧 [DEBUG] executeIndividualRun: About to write temporary scenario for runId: ${runId}`
      );
      // Apply parameter overrides and write temporary scenario
      await writeTemporaryScenario(context.scenarioPath, baseScenario, combination.parameters);
      console.log(
        `🔧 [DEBUG] executeIndividualRun: Temporary scenario written successfully for runId: ${runId}`
      );

      console.log(
        `🔧 [DEBUG] executeIndividualRun: About to get resource snapshot before run for runId: ${runId}`
      );
      // Monitor resources before run
      const resourcesBefore = await getResourceSnapshot();
      console.log(
        `🔧 [DEBUG] executeIndividualRun: Resource snapshot before run completed for runId: ${runId}`
      );

      console.log(
        `🔧 [DEBUG] executeIndividualRun: About to execute scenario with timeout for runId: ${runId}, timeout: ${timeout}ms`
      );
      // Execute scenario with timeout and race against timeout wrapper
      const scenarioResult = await Promise.race([
        executeScenarioWithTimeout(
          context.scenarioPath,
          context,
          timeout,
          (progress, status) => {
            progressTracker.updateRunProgress(runId, progress, status);
          },
          sharedServer, // Pass shared server if available
          runId, // Pass runId for unique agent naming
          dynamicPlugins // Pass dynamic plugins from scenario configuration
        ),
        timeoutPromise,
      ]);
      console.log(
        `🔧 [DEBUG] executeIndividualRun: Scenario execution completed successfully for runId: ${runId}`
      );

      console.log(
        `🔧 [DEBUG] executeIndividualRun: About to get resource snapshot after run for runId: ${runId}`
      );
      // Monitor resources after run
      const resourcesAfter = await getResourceSnapshot();
      console.log(
        `🔧 [DEBUG] executeIndividualRun: Resource snapshot after run completed for runId: ${runId}`
      );

      console.log(
        `🔧 [DEBUG] executeIndividualRun: About to calculate metrics for runId: ${runId}`
      );
      const endTime = new Date();
      const duration = endTime.getTime() - startTime.getTime();

      // Calculate metrics
      const metrics = {
        memoryUsage: resourcesAfter.memoryUsage - resourcesBefore.memoryUsage,
        diskUsage: await calculateRunDiskUsage(context.tempDir),
        tokenCount: (scenarioResult as any).tokenCount || 0,
        cpuUsage: resourcesAfter.cpuUsage,
      };

      console.log(
        `🔧 [DEBUG] executeIndividualRun: About to mark run as completed for runId: ${runId}`
      );
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
      console.log(
        `🔧 [DEBUG] executeIndividualRun: About to cleanup isolated environment for runId: ${runId}`
      );
      // Always cleanup isolated environment
      await context.cleanup();
      console.log(
        `🔧 [DEBUG] executeIndividualRun: Isolated environment cleanup completed for runId: ${runId}`
      );
    }
  } catch (error) {
    console.log(
      `🔧 [DEBUG] executeIndividualRun: Error occurred for runId: ${runId}, error: ${error}`
    );
    const endTime = new Date();
    const duration = endTime.getTime() - startTime.getTime();

    // Mark run as failed
    progressTracker.completeRun(
      runId,
      false,
      duration,
      error instanceof Error ? error.message : String(error)
    );

    // Try to capture actual resource usage even for failed runs
    let resourceMetrics = {
      memoryUsage: 0,
      diskUsage: 0,
      tokenCount: 0,
      cpuUsage: 0,
    };

    try {
      const resourcesAfter = await getResourceSnapshot();
      resourceMetrics = {
        memoryUsage: resourcesAfter.memoryUsage,
        diskUsage: 0, // Can't measure temp dir if context cleanup failed
        tokenCount: 0,
        cpuUsage: resourcesAfter.cpuUsage,
      };
    } catch (metricsError) {
      console.log(`🔧 [DEBUG] Failed to capture metrics for failed run ${runId}: ${metricsError}`);
    }

    return {
      runId,
      combinationId: combination.id,
      parameters: combination.parameters,
      startTime,
      endTime,
      duration,
      success: false,
      error: error instanceof Error ? error.message : String(error),
      metrics: resourceMetrics,
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
  onProgress: (progress: number, status: string) => void,
  sharedServer?: { server: AgentServer; port: number }, // Optional shared server for matrix testing
  runId?: string, // Optional run ID for unique agent naming
  dynamicPlugins?: string[] // Plugins extracted from scenario configuration
): Promise<ExecutionResult> {
  return new Promise(async (resolve, reject) => {
    const scenarioStartTime = Date.now();
    const timeoutHandle = setTimeout(() => {
      reject(new Error(`Scenario execution timed out after ${timeout}ms`));
    }, timeout);

    try {
      onProgress(0.1, 'Loading scenario...');

      // Load and parse the scenario file
      const yaml = await import('js-yaml');
      const scenarioContent = await fs.readFile(scenarioPath, 'utf8');
      const scenario = yaml.load(scenarioContent) as Scenario;

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
      const {
        createScenarioServerAndAgent,
        // createScenarioServer, // unused
        createScenarioAgent,
        shutdownScenarioServer,
      } = await import('./runtime-factory');

      // Override environment variables for isolation
      const originalEnv = process.env;
      // Set up isolated environment variables
      process.env = {
        ...originalEnv,
        ELIZAOS_DB_PATH: context.dbPath,
        ELIZAOS_LOG_PATH: context.logPath,
        ELIZAOS_TEMP_DIR: context.tempDir,
      };

      try {
        onProgress(0.4, 'Initializing agent runtime...');

        let server: AgentServer;
        let runtime: IAgentRuntime;
        let agentId: UUID;
        let port: number;
        let serverCreated = false;

        if (sharedServer) {
          // Use shared server pattern for matrix testing
          console.log(
            `🔧 [DEBUG] Using shared server on port ${sharedServer.port} for agent creation`
          );
          console.log(`🔧 [DEBUG] Dynamic plugins for agent: ${JSON.stringify(dynamicPlugins)}`);
          server = sharedServer.server;
          port = sharedServer.port;

          // Ensure SERVER_PORT is set for shared server scenarios
          process.env.SERVER_PORT = port.toString();
          console.log(
            `🔧 [DEBUG] Set SERVER_PORT environment variable to ${port} for shared server`
          );

          // Create new agent on shared server (with unique ID for isolation)
          const uniqueAgentName = `scenario-agent-${runId}`;
          console.log(`🔧 [DEBUG] Creating unique agent: ${uniqueAgentName} for run: ${runId}`);
          const agentResult = await createScenarioAgent(
            server,
            uniqueAgentName, // Unique agent name per run
            dynamicPlugins || [
              '@elizaos/plugin-sql',
              '@elizaos/plugin-openai',
              '@elizaos/plugin-bootstrap',
            ] // Use dynamic or fallback plugins
          );
          runtime = agentResult.runtime;
          agentId = agentResult.agentId;
          serverCreated = false; // We didn't create the server, so don't shut it down
          console.log(
            `🔧 [DEBUG] Agent ${agentId} created successfully on shared server port ${port}`
          );
        } else {
          // Single scenario pattern (backward compatibility) - use unique agent name
          const uniqueAgentName = `scenario-agent-${runId}`;
          console.log(
            `🔧 [DEBUG] Creating single scenario with unique agent: ${uniqueAgentName} for run: ${runId}`
          );
          console.log(
            `🔧 [DEBUG] Dynamic plugins for single scenario: ${JSON.stringify(dynamicPlugins)}`
          );
          const result = await createScenarioServerAndAgent(
            null,
            3000, // Use fixed port 3000 for MessageBusService compatibility
            dynamicPlugins || [
              '@elizaos/plugin-sql',
              '@elizaos/plugin-openai',
              '@elizaos/plugin-bootstrap',
            ], // Use dynamic or fallback plugins
            uniqueAgentName // Pass unique agent name
          );
          server = result.server;
          runtime = result.runtime;
          agentId = result.agentId;
          port = result.port;
          serverCreated = result.createdServer;
        }

        console.log(`🔧 [DEBUG] Creating LocalEnvironmentProvider with port: ${port}`);
        const provider = new LocalEnvironmentProvider(server, agentId, runtime as any, port);

        onProgress(0.5, 'Setting up scenario environment...');

        // Setup the scenario environment
        await provider.setup(scenario);

        onProgress(0.7, 'Executing scenario...');

        // Run the scenario
        const executionResults = await provider.run(scenario);

        onProgress(0.8, 'Running evaluations...');

        // Run evaluations for each run step (similar to regular scenario runner)
        const { EvaluationEngine } = await import('./EvaluationEngine');
        const evaluationEngine = new EvaluationEngine(runtime as any);

        const evaluationResults = [];
        if (scenario.run && Array.isArray(scenario.run)) {
          for (let i = 0; i < scenario.run.length && i < executionResults.length; i++) {
            const step = scenario.run[i];
            const executionResult = executionResults[i];

            if (step.evaluations && step.evaluations.length > 0) {
              console.log(
                `🔧 [DEBUG] Running ${step.evaluations.length} evaluations for step ${i}`
              );
              try {
                const stepEvaluations = await evaluationEngine.runEnhancedEvaluations(
                  step.evaluations,
                  executionResult
                );
                evaluationResults.push(...stepEvaluations);
                console.log(
                  `🔧 [DEBUG] Step ${i} evaluations completed: ${stepEvaluations.length} results`
                );
              } catch (evaluationError) {
                console.log(`🔧 [DEBUG] Step ${i} evaluations failed: ${evaluationError}`);
                // Still add a failed evaluation result
                evaluationResults.push({
                  evaluator_type: 'step_evaluation_failed',
                  success: false,
                  summary: `Step ${i} evaluations failed: ${evaluationError instanceof Error ? evaluationError.message : String(evaluationError)}`,
                  details: { step: i, error: String(evaluationError) },
                });
              }
            }
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

        // Cleanup: Only shut down server if we created it (single scenario mode)
        // For shared server mode, we only clean up the agent
        if (serverCreated) {
          console.log(`🔧 [DEBUG] Shutting down individual scenario server on port ${port}`);
          await shutdownScenarioServer(server, port);
        } else {
          console.log(
            `🔧 [DEBUG] Stopping agent ${agentId} on shared server (keeping server running)`
          );
          // Stop the agent but keep the server running
          if (server && typeof server.unregisterAgent === 'function') {
            console.log(`🔧 [DEBUG] Calling server.unregisterAgent(${agentId})`);
            server.unregisterAgent(agentId);
            console.log(`🔧 [DEBUG] ✅ Agent ${agentId} unregistered successfully`);
          } else {
            console.log(`🔧 [DEBUG] ⚠️  Server missing unregisterAgent method`);
          }
        }

        onProgress(1.0, 'Complete');

        const result = {
          success,
          evaluations: evaluationResults,
          executionResults,
          tokenCount: estimateTokenCount(executionResults),
          duration: Date.now() - scenarioStartTime, // Actual execution duration in ms
        };

        clearTimeout(timeoutHandle);
        resolve(result as any);
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
 * Estimates token count from execution results using actual trajectory data.
 */
interface ExecutionResult {
  stdout?: string;
  stderr?: string;
  trajectory?: Array<{
    content: string | Record<string, unknown>;
  }>;
}

function estimateTokenCount(executionResults: ExecutionResult[]): number {
  let tokenCount = 0;

  for (const result of executionResults) {
    // Count tokens from stdout (agent's response)
    if (result.stdout) {
      tokenCount += Math.ceil(result.stdout.length / 4);
    }

    // Count tokens from stderr if present
    if (result.stderr) {
      tokenCount += Math.ceil(result.stderr.length / 4);
    }

    // Count tokens from trajectory steps (thoughts, actions, observations)
    if (result.trajectory && Array.isArray(result.trajectory)) {
      for (const step of result.trajectory) {
        if (step.content) {
          if (typeof step.content === 'string') {
            tokenCount += Math.ceil(step.content.length / 4);
          } else if (typeof step.content === 'object') {
            // For action content, count the stringified version
            tokenCount += Math.ceil(JSON.stringify(step.content).length / 4);
          }
        }
      }
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
    console.log(
      `🔧 [DEBUG] Waiting for slot... activeRuns.size=${activeRuns.size}, maxParallel=${maxParallel}`
    );

    // Wait for at least one run to complete
    const promises = Array.from(activeRuns.values()).map((run) => run.promise);
    if (promises.length === 0) {
      console.log(`🔧 [DEBUG] No active promises found, breaking out of wait loop`);
      break;
    }

    console.log(`🔧 [DEBUG] Waiting for one of ${promises.length} promises to complete...`);
    try {
      await Promise.race(promises);
      console.log(`🔧 [DEBUG] A promise completed, checking for cleanup...`);

      // Give the promise handlers time to clean up
      await new Promise((resolve) => setTimeout(resolve, 100));
      console.log(`🔧 [DEBUG] After cleanup wait, activeRuns.size=${activeRuns.size}`);
    } catch (error) {
      console.log(`🔧 [DEBUG] Promise race failed: ${error}`);
      break;
    }
  }
  console.log(`🔧 [DEBUG] Available slot found! activeRuns.size=${activeRuns.size}`);
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
    const context: IsolationContext = {
      tempDir,
      runId: '',
      scenarioPath: '',
      dbPath: '',
      logPath: '',
      cleanup: async () => {},
    };
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
  _config: MatrixConfig,
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
