/**
 * SweBench evaluation hook.
 * Will be automatically added to `run_batch` if `SWEBenchInstances.evaluate` is set to true
 */

import * as path from 'path';
import * as fs from 'fs';
import { spawn, ChildProcess } from 'child_process';
import { AbstractRunHook } from './types';
import { AgentRunResult } from '../../types';
import { getLogger } from '../../utils/log';
import { mergePredictions } from '../merge-predictions';

const logger = getLogger('SB-evaluate', '😬');

/**
 * SweBench evaluation hook
 */
export class SweBenchEvaluate extends AbstractRunHook {
  private static readonly SUBSET_MAP: Record<string, string> = {
    lite: 'swe-bench_lite',
    verified: 'swe-bench_verified',
    multimodal: 'swe-bench_multimodal',
  };

  private outputDir: string;
  private subset: string;
  private split: string;
  private continuousSubmissionEvery: number;
  private mergeLock: boolean = false;
  private lastEvaluationTime: number;
  private evaluationInterval: number;
  private runningCalls: ChildProcess[] = [];
  private timeSuffix: string;

  constructor(params: { outputDir: string; subset: string; split: string; continuousSubmissionEvery?: number }) {
    super();
    this.outputDir = params.outputDir;
    this.subset = params.subset;
    this.split = params.split;
    this.continuousSubmissionEvery = params.continuousSubmissionEvery || 0;
    this.lastEvaluationTime = Date.now() / 1000;
    this.evaluationInterval = this.continuousSubmissionEvery;
    // We need to add a suffix to the run_id to avoid collisions when you reuse the name of your run
    this.timeSuffix = new Date()
      .toISOString()
      .replace(/[-:T.]/g, '')
      .slice(0, -1);
  }

  get runId(): string {
    return `${path.basename(this.outputDir)}_${this.timeSuffix}`;
  }

  getSbCall(predsPath: string, submitOnly: boolean = false): string[] {
    const args = [
      'sb-cli',
      'submit',
      SweBenchEvaluate.SUBSET_MAP[this.subset],
      this.split,
      '--predictions_path',
      predsPath,
      '--run_id',
      this.runId,
      '--output_dir',
      path.join(this.outputDir, 'sb-cli-reports'),
    ];

    if (submitOnly) {
      args.push('--wait_for_evaluation', '0', '--gen_report', '0', '--verify_submission', '0');
    }

    return args;
  }

  /**
   * Warn if one of the running calls failed
   */
  checkRunningCalls(): void {
    this.runningCalls = this.runningCalls.filter((call) => {
      if (call.exitCode !== null) {
        if (call.exitCode !== 0) {
          logger.error('Failed to submit results to SweBench eval');
        }
        return false;
      }
      return true;
    });
  }

  onInstanceCompleted(_params: { result: AgentRunResult }): void {
    if (this.evaluationInterval === 0) {
      return;
    }

    const currentTime = Date.now() / 1000;
    if (currentTime - this.lastEvaluationTime < this.evaluationInterval) {
      return;
    }

    // Use a simple lock mechanism
    if (this.mergeLock) {
      return;
    }

    this.mergeLock = true;
    try {
      mergePredictions([this.outputDir], path.join(this.outputDir, 'tmppreds.json'));
      this.lastEvaluationTime = currentTime;

      const sbCall = this.getSbCall(path.join(this.outputDir, 'tmppreds.json'), true);
      const child = spawn(sbCall[0], sbCall.slice(1), {
        stdio: 'pipe',
      });

      this.runningCalls.push(child);
    } finally {
      this.mergeLock = false;
    }
  }

  /**
   * Move report from `sb-cli-reports` to `results.json`
   */
  moveSbCliReport(): void {
    const outputDir = path.join(this.outputDir, 'sb-cli-reports');

    if (!fs.existsSync(outputDir)) {
      logger.warn(`No SweBench report found at ${outputDir}`);
      return;
    }

    const resultsPath = path.join(this.outputDir, 'results.json');
    if (fs.existsSync(resultsPath)) {
      fs.unlinkSync(resultsPath);
    }

    const reports = fs
      .readdirSync(outputDir)
      .filter((file) => file.endsWith('.json'))
      .map((file) => path.join(outputDir, file));

    if (reports.length !== 1) {
      logger.warn(`Expected 1 SweBench report at ${outputDir}, found ${reports.length}. Cannot rename.`);
      return;
    }

    fs.renameSync(reports[0], resultsPath);
  }

  onEnd(): void {
    logger.info('Submitting results to SWE-Bench');

    try {
      const sbCall = this.getSbCall(path.join(this.outputDir, 'preds.json'));
      const { spawnSync } = require('child_process');
      const result = spawnSync(sbCall[0], sbCall.slice(1), {
        stdio: 'inherit',
      });

      if (result.status !== 0) {
        throw new Error(`Failed with exit code ${result.status}`);
      }

      // Remove temporary predictions if they exist
      const tmpPredsPath = path.join(this.outputDir, 'tmppreds.json');
      if (fs.existsSync(tmpPredsPath)) {
        fs.unlinkSync(tmpPredsPath);
      }

      this.moveSbCliReport();
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(`Failed to submit results to SweBench eval: ${errorMessage}`);
    }
  }
}
