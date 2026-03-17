/**
 * Benchmark History Service
 *
 * Persists benchmark results to the database for historical tracking and analysis.
 */

import {
  type BenchmarkResultRecord,
  getTrainingDataAdapter,
  type JsonValue,
} from "../adapter";
import { logger } from "../utils/logger";
import { generateSnowflakeId } from "../utils/snowflake";
import type { SimulationMetrics } from "./SimulationEngine";

export interface BenchmarkResultInput {
  modelId: string;
  benchmarkId: string;
  benchmarkPath: string;
  metrics: SimulationMetrics;
  duration: number;
  baselineComparison?: {
    pnlDelta: number;
    accuracyDelta: number;
    improved: boolean;
  };
}

export interface BenchmarkHistoryQuery {
  modelId?: string;
  benchmarkId?: string;
  startDate?: Date;
  endDate?: Date;
  limit?: number;
}

export interface BenchmarkTrendData {
  modelId: string;
  dates: Date[];
  pnlHistory: number[];
  accuracyHistory: number[];
  optimalityHistory: number[];
}

/**
 * Service for managing benchmark result history
 */
// biome-ignore lint/complexity/noStaticOnlyClass: Service namespace - methods are logically grouped
export class BenchmarkHistoryService {
  /**
   * Save a benchmark result to the database
   */
  static async saveResult(
    input: BenchmarkResultInput,
  ): Promise<BenchmarkResultRecord> {
    const id = await generateSnowflakeId();
    const now = new Date();

    const insertData = {
      id,
      modelId: input.modelId,
      benchmarkId: input.benchmarkId,
      benchmarkPath: input.benchmarkPath,
      runAt: now,
      totalPnl: input.metrics.totalPnl,
      predictionAccuracy: input.metrics.predictionMetrics.accuracy,
      perpWinRate: input.metrics.perpMetrics.winRate,
      optimalityScore: input.metrics.optimalityScore,
      detailedMetrics: JSON.parse(JSON.stringify(input.metrics)) as JsonValue,
      baselinePnlDelta: input.baselineComparison?.pnlDelta ?? null,
      baselineAccuracyDelta: input.baselineComparison?.accuracyDelta ?? null,
      improved: input.baselineComparison?.improved ?? null,
      duration: input.duration,
    };

    await getTrainingDataAdapter().insertBenchmarkResult(insertData);

    logger.info("Saved benchmark result", {
      id,
      modelId: input.modelId,
      benchmarkId: input.benchmarkId,
      totalPnl: input.metrics.totalPnl,
    });

    return { ...insertData, createdAt: now };
  }

  /**
   * Get benchmark results by query
   */
  static async getResults(
    query: BenchmarkHistoryQuery,
  ): Promise<BenchmarkResultRecord[]> {
    return getTrainingDataAdapter().queryBenchmarkResults({
      modelId: query.modelId,
      benchmarkId: query.benchmarkId,
      startDate: query.startDate,
      endDate: query.endDate,
      limit: query.limit ?? 100,
    });
  }

  /**
   * Get the latest result for a model
   */
  static async getLatestResult(
    modelId: string,
  ): Promise<BenchmarkResultRecord | null> {
    const results = await getTrainingDataAdapter().queryBenchmarkResults({
      modelId,
      limit: 1,
    });
    return results[0] ?? null;
  }

  /**
   * Get trend data for a model
   */
  static async getTrendData(
    modelId: string,
    limit = 20,
  ): Promise<BenchmarkTrendData> {
    const results = await getTrainingDataAdapter().queryBenchmarkResults({
      modelId,
      limit,
    });

    // queryBenchmarkResults returns desc by runAt, reverse for chronological
    const chronological = results.reverse();

    return {
      modelId,
      dates: chronological.map((r) => r.runAt),
      pnlHistory: chronological.map((r) => r.totalPnl),
      accuracyHistory: chronological.map((r) => r.predictionAccuracy),
      optimalityHistory: chronological.map((r) => r.optimalityScore),
    };
  }

  /**
   * Get comparison data for multiple models
   */
  static async getModelComparison(
    modelIds: string[],
    benchmarkId?: string,
  ): Promise<Map<string, BenchmarkResultRecord[]>> {
    const adapter = getTrainingDataAdapter();
    const comparison = new Map<string, BenchmarkResultRecord[]>();

    for (const modelId of modelIds) {
      const results = await adapter.queryBenchmarkResults({
        modelId,
        benchmarkId,
        limit: 10,
      });
      comparison.set(modelId, results);
    }

    return comparison;
  }

  /**
   * Get summary statistics for all models
   */
  static async getModelSummary(): Promise<
    Array<{
      modelId: string;
      runCount: number;
      avgPnl: number;
      avgAccuracy: number;
      avgOptimality: number;
      bestPnl: number;
      latestRun: Date;
    }>
  > {
    return getTrainingDataAdapter().getBenchmarkModelSummary();
  }

  /**
   * Check if a model improved vs baseline
   */
  static async checkImprovement(
    modelId: string,
    baselineModelId: string,
    benchmarkId: string,
  ): Promise<{
    improved: boolean;
    modelPnl: number;
    baselinePnl: number;
    delta: number;
  } | null> {
    const adapter = getTrainingDataAdapter();

    const modelResults = await adapter.queryBenchmarkResults({
      modelId,
      benchmarkId,
      limit: 1,
    });

    const baselineResults = await adapter.queryBenchmarkResults({
      modelId: baselineModelId,
      benchmarkId,
      limit: 1,
    });

    const modelResult = modelResults[0];
    const baselineResult = baselineResults[0];

    if (!modelResult || !baselineResult) {
      return null;
    }

    const delta = modelResult.totalPnl - baselineResult.totalPnl;

    return {
      improved: delta > 0,
      modelPnl: modelResult.totalPnl,
      baselinePnl: baselineResult.totalPnl,
      delta,
    };
  }
}
