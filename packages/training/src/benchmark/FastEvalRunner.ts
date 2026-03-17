/**
 * Fast Evaluation Runner
 *
 * Provides efficient evaluation of agents on benchmarks with:
 * - Fast-forward mode (skip waiting)
 * - Batch processing
 * - Parallel execution
 * - Progress tracking
 */

import { logger } from "../utils/logger";
import { type BenchmarkRunConfig, BenchmarkRunner } from "./BenchmarkRunner";
import type { SimulationResult } from "./SimulationEngine";

export interface FastEvalConfig {
  /** Benchmark file path */
  benchmarkPath: string;

  /** Agent runtime to test */
  agentRuntime: BenchmarkRunConfig["agentRuntime"];

  /** Agent user ID */
  agentUserId: string;

  /** Number of parallel runs */
  parallelRuns?: number;

  /** Number of iterations per run */
  iterations?: number;

  /** Save trajectory data */
  saveTrajectory?: boolean;

  /** Output directory */
  outputDir: string;

  /** Fast-forward mode (default: true) */
  fastForward?: boolean; // Not used directly, passed to BenchmarkRunner

  /** Progress callback */
  onProgress?: (progress: {
    completed: number;
    total: number;
    currentRun?: string;
  }) => void;
}

export interface FastEvalResult {
  /** All run results */
  results: SimulationResult[];

  /** Summary statistics */
  summary: {
    avgPnl: number;
    avgAccuracy: number;
    avgOptimality: number;
    totalDuration: number;
    runsCompleted: number;
  };

  /** Best and worst runs */
  bestRun: SimulationResult;
  worstRun: SimulationResult;
}

// biome-ignore lint/complexity/noStaticOnlyClass: Runner namespace - run/runWithProgress are logically grouped
export class FastEvalRunner {
  /**
   * Run fast evaluation
   *
   * Executes efficient batch evaluation of an agent on a benchmark with
   * parallel runs and progress tracking. Optimized for speed and throughput.
   *
   * @param config - Fast evaluation configuration
   * @returns FastEvalResult with all run results and summary statistics
   * @throws Error if evaluation fails
   *
   * @remarks
   * - Runs multiple iterations in parallel batches
   * - Provides progress callbacks for monitoring
   * - Calculates aggregate statistics across all runs
   * - Identifies best and worst performing runs
   *
   * @example
   * ```typescript
   * const result = await FastEvalRunner.run({
   *   benchmarkPath: './benchmarks/test.json',
   *   agentRuntime: runtime,
   *   agentUserId: 'agent-123',
   *   parallelRuns: 3,
   *   iterations: 10,
   *   outputDir: './results'
   * });
   * console.log(`Average P&L: ${result.summary.avgPnl}`);
   * ```
   */
  static async run(config: FastEvalConfig): Promise<FastEvalResult> {
    const startTime = Date.now();
    const iterations = config.iterations || 1;
    const parallelRuns = config.parallelRuns || 1;

    logger.info("Starting fast evaluation", {
      benchmarkPath: config.benchmarkPath,
      agentUserId: config.agentUserId,
      iterations,
      parallelRuns,
    });

    const results: SimulationResult[] = [];
    let completed = 0;

    // Run iterations in batches
    for (
      let batchStart = 0;
      batchStart < iterations;
      batchStart += parallelRuns
    ) {
      const batchEnd = Math.min(batchStart + parallelRuns, iterations);
      const batchSize = batchEnd - batchStart;

      logger.info(
        `Running batch ${batchStart + 1}-${batchEnd} of ${iterations}`,
      );

      // Run batch in parallel
      const batchPromises = Array.from({ length: batchSize }, (_, i) => {
        const runIndex = batchStart + i;
        const runOutputDir = `${config.outputDir}/run-${runIndex + 1}`;

        return BenchmarkRunner.runSingle({
          benchmarkPath: config.benchmarkPath,
          agentRuntime: config.agentRuntime,
          agentUserId: config.agentUserId,
          saveTrajectory: config.saveTrajectory ?? false,
          outputDir: runOutputDir,
        }).then((result) => {
          completed++;
          if (config.onProgress) {
            config.onProgress({
              completed,
              total: iterations,
              currentRun: `run-${runIndex + 1}`,
            });
          }
          return result;
        });
      });

      const batchResults = await Promise.all(batchPromises);
      results.push(...batchResults);
    }

    const totalDuration = Date.now() - startTime;

    // Calculate summary
    const avgPnl =
      results.reduce((sum, r) => sum + r.metrics.totalPnl, 0) / results.length;
    const avgAccuracy =
      results.reduce(
        (sum, r) => sum + r.metrics.predictionMetrics.accuracy,
        0,
      ) / results.length;
    const avgOptimality =
      results.reduce((sum, r) => sum + r.metrics.optimalityScore, 0) /
      results.length;

    const bestRun = results.reduce((best, current) =>
      current.metrics.totalPnl > best.metrics.totalPnl ? current : best,
    );

    const worstRun = results.reduce((worst, current) =>
      current.metrics.totalPnl < worst.metrics.totalPnl ? current : worst,
    );

    const summary = {
      avgPnl,
      avgAccuracy,
      avgOptimality,
      totalDuration,
      runsCompleted: results.length,
    };

    logger.info("Fast evaluation completed", summary);

    return {
      results,
      summary,
      bestRun,
      worstRun,
    };
  }

  /**
   * Run evaluation with progress bar
   */
  static async runWithProgress(
    config: FastEvalConfig,
  ): Promise<FastEvalResult> {
    let lastProgress = 0;

    return FastEvalRunner.run({
      ...config,
      onProgress: (progress) => {
        const percent = Math.round((progress.completed / progress.total) * 100);
        if (percent !== lastProgress) {
          const barLength = 40;
          const filled = Math.round(
            (progress.completed / progress.total) * barLength,
          );
          const bar = "█".repeat(filled) + "░".repeat(barLength - filled);
          process.stdout.write(
            `\r[${bar}] ${percent}% (${progress.completed}/${progress.total})`,
          );
          lastProgress = percent;
        }

        if (config.onProgress) {
          config.onProgress(progress);
        }
      },
    }).then((result) => {
      process.stdout.write("\n");
      return result;
    });
  }
}
