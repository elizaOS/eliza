/**
 * Run batch of instances
 * Converted from sweagent/run/run_batch.py
 */

import path from 'path';
import fs from 'fs';
import { z } from 'zod';
import { AgentConfig, getAgentFromConfig } from '../agent/agents';
import { SWEEnv } from '../environment/swe-env';
import { BatchInstance, createInstanceSource } from './batch-instances';
import { RunHook } from './hooks';
import { getLogger, AgentLogger } from '../utils/log';
import { loadEnvironmentVariables } from '../utils/config';
import { AgentRunResult } from '../types';
import { savePredictions } from './common';
import { RunBatchConfig } from './types';
export { RunBatchConfig } from './types';

/**
 * Configuration schema
 */
export const RunBatchConfigSchema = z.object({
  instances: z.any(),
  agent: z.any(),
  outputDir: z.string().default('DEFAULT'),
  suffix: z.string().default(''),
  raiseExceptions: z.boolean().default(false),
  redoExisting: z.boolean().default(false),
  envVarPath: z.string().optional(),
  numWorkers: z.number().default(1),
  randomDelayMultiplier: z.number().default(0.3),
  progressBar: z.boolean().default(true),
});

/**
 * Progress manager for batch runs
 */
class BatchProgressManager {
  private totalInstances: number;
  private completedInstances: number = 0;
  private instanceStatuses: Map<string, string> = new Map();
  private logger: AgentLogger;

  constructor(numInstances: number) {
    this.totalInstances = numInstances;
    this.logger = getLogger('progress', '📊');
  }

  onInstanceStart(instanceId: string): void {
    this.instanceStatuses.set(instanceId, 'running');
    this.logger.info(`Starting instance ${instanceId} (${this.completedInstances}/${this.totalInstances} completed)`);
  }

  onInstanceEnd(instanceId: string, exitStatus: string): void {
    this.completedInstances++;
    this.instanceStatuses.set(instanceId, exitStatus);
    this.logger.info(
      `Completed instance ${instanceId} with status: ${exitStatus} (${this.completedInstances}/${this.totalInstances})`,
    );
  }

  onUncaughtException(instanceId: string, error: Error): void {
    this.logger.error(`Uncaught exception in instance ${instanceId}: ${error.message}`);
    this.onInstanceEnd(instanceId, 'error');
  }

  printReport(): void {
    this.logger.info(`\n${'='.repeat(50)}`);
    this.logger.info('BATCH RUN SUMMARY');
    this.logger.info(`${'='.repeat(50)}`);
    this.logger.info(`Total instances: ${this.totalInstances}`);
    this.logger.info(`Completed: ${this.completedInstances}`);

    // Count by status
    const statusCounts = new Map<string, number>();
    for (const status of this.instanceStatuses.values()) {
      statusCounts.set(status, (statusCounts.get(status) || 0) + 1);
    }

    this.logger.info('\nStatus breakdown:');
    for (const [status, count] of statusCounts) {
      this.logger.info(`  ${status}: ${count}`);
    }
    this.logger.info(`${'='.repeat(50)}\n`);
  }
}

/**
 * Run batch of instances
 */
export class RunBatch {
  private instances: BatchInstance[];
  private agentConfig: AgentConfig;
  private outputDir: string;
  private hooks: RunHook[];
  private raiseExceptions: boolean;
  private redoExisting: boolean;
  private numWorkers: number;
  // @ts-ignore - This field is reserved for future use (progress bar display)
  private _progressBar: boolean;
  private randomDelayMultiplier: number;
  private logger: AgentLogger;
  private progressManager: BatchProgressManager;

  constructor(config: {
    instances: BatchInstance[];
    agentConfig: AgentConfig;
    outputDir?: string;
    hooks?: RunHook[];
    raiseExceptions?: boolean;
    redoExisting?: boolean;
    numWorkers?: number;
    progressBar?: boolean;
    randomDelayMultiplier?: number;
  }) {
    this.instances = config.instances;
    this.agentConfig = config.agentConfig;
    this.outputDir = config.outputDir || '.';
    this.hooks = config.hooks || [];
    this.raiseExceptions = config.raiseExceptions || false;
    this.redoExisting = config.redoExisting || false;
    this.numWorkers = config.numWorkers || 1;
    this._progressBar = config.progressBar || true;
    this.randomDelayMultiplier = config.randomDelayMultiplier || 0.3;
    this.logger = getLogger('run-batch', '🏃');
    this.progressManager = new BatchProgressManager(this.instances.length);
  }

  static fromConfig(config: RunBatchConfig): RunBatch {
    // Load environment variables
    if (config.envVarPath) {
      loadEnvironmentVariables(config.envVarPath);
    }

    // Get instances
    const instanceSource = createInstanceSource(config.instances);
    const instances = instanceSource.getInstanceConfigs();

    // Set default output directory
    if (config.outputDir === 'DEFAULT') {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const suffix = config.suffix ? `_${config.suffix}` : '';
      config.outputDir = path.join('trajectories', `batch_${timestamp}${suffix}`);
    }

    return new RunBatch({
      instances,
      agentConfig: config.agent,
      outputDir: config.outputDir,
      raiseExceptions: config.raiseExceptions,
      redoExisting: config.redoExisting,
      numWorkers: config.numWorkers,
      progressBar: config.progressBar,
      randomDelayMultiplier: config.randomDelayMultiplier,
    });
  }

  addHook(hook: RunHook): void {
    this.hooks.push(hook);
  }

  async main(): Promise<void> {
    this.logger.info(`Starting batch run with ${this.instances.length} instances`);

    // Create output directory
    fs.mkdirSync(this.outputDir, { recursive: true });

    if (this.numWorkers === 1) {
      await this.mainSingleWorker();
    } else {
      await this.mainMultiWorker();
    }

    this.progressManager.printReport();
  }

  private async mainSingleWorker(): Promise<void> {
    for (const instance of this.instances) {
      if (!this.shouldSkip(instance)) {
        await this.runInstance(instance);
      }
    }
  }

  private async mainMultiWorker(): Promise<void> {
    this.logger.info(`Running with ${this.numWorkers} workers`);

    // Create a queue of instances
    const queue = [...this.instances];
    const workers: Promise<void>[] = [];

    // Start workers
    for (let i = 0; i < this.numWorkers; i++) {
      workers.push(this.worker(queue, i));
    }

    // Wait for all workers to complete
    await Promise.all(workers);
  }

  private async worker(queue: BatchInstance[], _workerId: number): Promise<void> {
    while (queue.length > 0) {
      const instance = queue.shift();
      if (!instance) {
        break;
      }

      // Random delay to avoid race conditions
      if (this.randomDelayMultiplier > 0) {
        const delay = Math.random() * this.randomDelayMultiplier * this.numWorkers * 1000;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }

      if (!this.shouldSkip(instance)) {
        await this.runInstance(instance);
      }
    }
  }

  async runInstance(instance: BatchInstance): Promise<void> {
    const instanceId = (instance.problemStatement as { id?: string }).id || 'unknown';

    this.progressManager.onInstanceStart(instanceId);

    try {
      const result = await this._runInstance(instance);

      // Save predictions
      savePredictions(this.outputDir, instanceId, result);

      const exitStatus = result.info.exitStatus || 'unknown';
      this.progressManager.onInstanceEnd(instanceId, exitStatus);
    } catch (error) {
      this.logger.error(`Error running instance ${instanceId}: ${error}`);

      if (this.raiseExceptions) {
        throw error;
      }

      this.progressManager.onUncaughtException(instanceId, error as Error);
    }
  }

  private async _runInstance(instance: BatchInstance): Promise<AgentRunResult> {
    // Create environment
    const env = SWEEnv.fromConfig(instance.env);

    // Create agent
    const agent = await getAgentFromConfig(this.agentConfig);

    // Add hooks (RunHooks are different from AgentHooks)
    // TODO: Convert RunHooks to AgentHooks if needed
    // for (const hook of this.hooks) {
    //   agent.addHook(hook);
    // }

    // Start environment
    await env.start();

    try {
      // Run agent - cast env to any to avoid type issues
      const result = await agent.run(env as any, instance.problemStatement, this.outputDir);

      return result;
    } finally {
      // Clean up environment
      await env.close();
    }
  }

  shouldSkip(instance: BatchInstance): boolean {
    if (this.redoExisting) {
      return false;
    }

    const instanceId = (instance.problemStatement as { id?: string }).id || 'unknown';
    const trajPath = path.join(this.outputDir, `${instanceId}.traj`);

    if (fs.existsSync(trajPath)) {
      try {
        const content = fs.readFileSync(trajPath, 'utf-8');
        const data = JSON.parse(content);

        if (data.info?.exitStatus) {
          this.logger.info(`Skipping ${instanceId} - already completed`);
          return true;
        }
      } catch {
        // If we can't parse the file, re-run the instance
      }
    }

    return false;
  }
}

/**
 * Run from configuration
 */
export async function runBatchFromConfig(config: RunBatchConfig): Promise<void> {
  const runner = RunBatch.fromConfig(config);
  await runner.main();
}
