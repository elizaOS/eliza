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
import { MatrixConfig } from './matrix-schema';
import { IAgentRuntime, UUID, logger } from '@elizaos/core';
import { AgentServer } from '@elizaos/server';
import { Scenario, EnhancedEvaluationResult } from './schema';
import { ExecutionResult } from './providers';

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
  const startTime = new Date();
  const results: MatrixRunResult[] = [];
  const activeRuns = new Map<string, ActiveRun>();

  // Declare shared server at function scope for cleanup
  let sharedServer: { server: AgentServer; port: number } | null = null;

  // Setup execution environment
  const { outputDir, maxParallel = 1, continueOnFailure = true, runTimeout = 300000 } = options;
  await fs.mkdir(outputDir, { recursive: true });

  // Initialize progress tracking
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
    let baseScenario: Scenario;

    try {
      // Try parsing as JSON first
      baseScenario = JSON.parse(baseScenarioContent);
    } catch {
      // If JSON fails, try YAML
      const yaml = await import('js-yaml');
      baseScenario = yaml.load(baseScenarioContent) as Scenario;
    }

    // Copy matrix configuration to output directory
    await saveMatrixConfiguration(config, outputDir);

    // Extract plugins from base scenario configuration
    const defaultPlugins = ['@elizaos/plugin-sql', '@elizaos/plugin-bootstrap'];
    const scenarioPlugins = Array.isArray(baseScenario.plugins)
      ? baseScenario.plugins
          .filter(
            (p: string | { name: string; enabled?: boolean }) =>
              typeof p === 'string' || p.enabled !== false
          )
          .map((p: string | { name: string }) => (typeof p === 'string' ? p : p.name))
      : [];
    const finalPlugins = Array.from(
      new Set([...scenarioPlugins, ...defaultPlugins, '@elizaos/plugin-openai'])
    );

    if (combinations.length > 1 || config.runs_per_combination > 1) {
      console.log(
        '🔧 [DEBUG] Matrix testing detected - creating shared server for better isolation...'
      );
      const { createScenarioServer } = await import('./runtime-factory');

      try {
        const serverResult = await createScenarioServer(null, 3000);
        sharedServer = {
          server: serverResult.server,
          port: serverResult.port,
        };
      } catch (error) {
        sharedServer = null;
      }
    }

    // Execute all combinations
    let runCounter = 0;

    for (const combination of combinations) {
      const combinationResults: MatrixRunResult[] = [];

      // Execute all runs for this combination
      for (let runIndex = 0; runIndex < config.runs_per_combination; runIndex++) {
        const memoryUsage = process.memoryUsage();

        // Check if memory usage is too high and force cleanup
        if (memoryUsage.heapUsed > 500 * 1024 * 1024) {
          // 500MB threshold
          if (global.gc) {
            global.gc();
          }
        }

        runCounter++;
        const runId = generateRunFilename(runCounter);

        // Wait for available slot if we're at max parallelism
        await waitForAvailableSlot(activeRuns, maxParallel);

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
              try {
                await activeRun.context.cleanup();
              } catch (cleanupError) {}
              activeRuns.delete(runId);

              // Force garbage collection if available
              if (global.gc) {
                global.gc();
              }
            }
          })
          .catch(async (error) => {
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
              // Metrics collection failed - use default values, don't fail the run
              logger.debug(
                {
                  src: 'cli',
                  command: 'scenario:matrix',
                  error:
                    metricsError instanceof Error ? metricsError.message : String(metricsError),
                },
                'Failed to collect resource metrics for failed run'
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
              try {
                await activeRun.context.cleanup();
              } catch (cleanupError) {
                // Cleanup failed - log but don't fail the run
                logger.debug(
                  {
                    src: 'cli',
                    command: 'scenario:matrix',
                    error:
                      cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
                  },
                  'Failed to cleanup context for failed run'
                );
              }
              activeRuns.delete(runId);

              // Force garbage collection if available
              if (global.gc) {
                global.gc();
              }
            }

            if (!continueOnFailure) {
              throw error;
            }
          });
      }

      // Wait for all runs in this combination to complete
      try {
        await waitForCombinationCompletion(combination.id, activeRuns);
      } catch (error) {
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
      try {
        const { shutdownScenarioServer } = await import('./runtime-factory');
        await shutdownScenarioServer(sharedServer.server, sharedServer.port);
      } catch (error) {}
    }

    // Cleanup
    resourceMonitor.stop();

    // Log final process state before cleanup
    const finalSummary = processManager.getSummary();
    if (finalSummary.total > 0) {
    }

    // Ensure all isolated environments are cleaned up
    for (const activeRun of activeRuns.values()) {
      try {
        await activeRun.context.cleanup();
      } catch (error) {}
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
  const startTime = new Date();

  // Add timeout wrapper to prevent hanging
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => {
      reject(new Error(`Run ${runId} timed out after ${timeout}ms`));
    }, timeout);
  });

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

    // Try to capture actual resource usage even for failed runs
    let resourceMetrics = {
      memoryUsage: 0,
      diskUsage: 0,
      tokenCount: 0,
      cpuUsage: 0,
    };

    const resourcesAfter = await getResourceSnapshot();
    resourceMetrics = {
      memoryUsage: resourcesAfter.memoryUsage,
      diskUsage: 0, // Can't measure temp dir if context cleanup failed
      tokenCount: 0,
      cpuUsage: resourcesAfter.cpuUsage,
    };

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
 * Result of executing a scenario with evaluations.
 */
interface ScenarioExecutionResult {
  success: boolean;
  evaluations: Array<
    | EnhancedEvaluationResult
    | {
        evaluator_type: string;
        success: boolean;
        summary: string;
        details: { step: number; error: string };
      }
  >;
  executionResults: ExecutionResult[];
  tokenCount: number;
  duration: number;
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
): Promise<ScenarioExecutionResult> {
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
      const { createScenarioServerAndAgent, createScenarioAgent, shutdownScenarioServer } =
        await import('./runtime-factory');

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
          server = sharedServer.server;
          port = sharedServer.port;

          // Ensure SERVER_PORT is set for shared server scenarios
          process.env.SERVER_PORT = port.toString();

          // Create new agent on shared server (with unique ID for isolation)
          const uniqueAgentName = `scenario-agent-${runId}`;
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
        } else {
          // Single scenario pattern (backward compatibility) - use unique agent name
          const uniqueAgentName = `scenario-agent-${runId}`;
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

        const provider = new LocalEnvironmentProvider(server, agentId, runtime, port);

        onProgress(0.5, 'Setting up scenario environment...');

        // Setup the scenario environment
        await provider.setup(scenario);

        onProgress(0.7, 'Executing scenario...');

        // Run the scenario
        const executionResults = await provider.run(scenario);

        onProgress(0.8, 'Running evaluations...');

        // Run evaluations for each run step (similar to regular scenario runner)
        const { EvaluationEngine } = await import('./EvaluationEngine');
        const evaluationEngine = new EvaluationEngine(runtime);

        const evaluationResults = [];
        if (scenario.run && Array.isArray(scenario.run)) {
          for (let i = 0; i < scenario.run.length && i < executionResults.length; i++) {
            const step = scenario.run[i];
            const executionResult = executionResults[i];

            if (step.evaluations && step.evaluations.length > 0) {
              try {
                const stepEvaluations = await evaluationEngine.runEnhancedEvaluations(
                  step.evaluations,
                  executionResult
                );
                evaluationResults.push(...stepEvaluations);
              } catch (evaluationError) {
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
          await shutdownScenarioServer(server, port);
        } else {
          // Stop the agent but keep the server running
          if (server && typeof server.unregisterAgent === 'function') {
            server.unregisterAgent(agentId);
          } else {
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
 * Estimates token count from execution results using actual trajectory data.
 */
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
    // Wait for at least one run to complete
    const promises = Array.from(activeRuns.values()).map((run) => run.promise);
    if (promises.length === 0) {
      break;
    }

    await Promise.race(promises);

    // Give the promise handlers time to clean up
    await new Promise((resolve) => setTimeout(resolve, 100));
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
