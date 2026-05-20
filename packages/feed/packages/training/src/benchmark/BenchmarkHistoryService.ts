/**
 * Benchmark History Service
 *
 * Persists benchmark results to the database for historical tracking and analysis.
 */

import {
  type BenchmarkResult,
  benchmarkResults,
  db,
  type JsonValue,
  type NewBenchmarkResult,
} from '@babylon/db';
import { and, desc, eq, gte, lte, type SQL, sql } from 'drizzle-orm';
import { logger } from '../utils/logger';
import { generateSnowflakeId } from '../utils/snowflake';
import type { SimulationMetrics } from './SimulationEngine';

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
export class BenchmarkHistoryService {
  /**
   * Save a benchmark result to the database
   */
  static async saveResult(
    input: BenchmarkResultInput
  ): Promise<BenchmarkResult> {
    const id = await generateSnowflakeId();

    const record: NewBenchmarkResult = {
      id,
      modelId: input.modelId,
      benchmarkId: input.benchmarkId,
      benchmarkPath: input.benchmarkPath,
      runAt: new Date(),
      totalPnl: input.metrics.totalPnl,
      predictionAccuracy: input.metrics.predictionMetrics.accuracy,
      perpWinRate: input.metrics.perpMetrics.winRate,
      optimalityScore: input.metrics.optimalityScore,
      detailedMetrics: JSON.parse(JSON.stringify(input.metrics)) as JsonValue,
      baselinePnlDelta: input.baselineComparison?.pnlDelta ?? null,
      baselineAccuracyDelta: input.baselineComparison?.accuracyDelta ?? null,
      improved: input.baselineComparison?.improved ?? null,
      duration: input.duration,
      createdAt: new Date(),
    };

    const [result] = await db
      .insert(benchmarkResults)
      .values(record)
      .returning();

    logger.info('Saved benchmark result', {
      id: result?.id,
      modelId: input.modelId,
      benchmarkId: input.benchmarkId,
      totalPnl: input.metrics.totalPnl,
    });

    if (!result) {
      throw new Error('Failed to save benchmark result');
    }

    return result;
  }

  /**
   * Get benchmark results by query
   */
  static async getResults(
    query: BenchmarkHistoryQuery
  ): Promise<BenchmarkResult[]> {
    const conditions: SQL[] = [];

    if (query.modelId) {
      conditions.push(eq(benchmarkResults.modelId, query.modelId));
    }

    if (query.benchmarkId) {
      conditions.push(eq(benchmarkResults.benchmarkId, query.benchmarkId));
    }

    if (query.startDate) {
      conditions.push(gte(benchmarkResults.runAt, query.startDate));
    }

    if (query.endDate) {
      conditions.push(lte(benchmarkResults.runAt, query.endDate));
    }

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    const results = await db
      .select()
      .from(benchmarkResults)
      .where(whereClause)
      .orderBy(desc(benchmarkResults.runAt))
      .limit(query.limit ?? 100);

    return results;
  }

  /**
   * Get the latest result for a model
   */
  static async getLatestResult(
    modelId: string
  ): Promise<BenchmarkResult | null> {
    const [result] = await db
      .select()
      .from(benchmarkResults)
      .where(eq(benchmarkResults.modelId, modelId))
      .orderBy(desc(benchmarkResults.runAt))
      .limit(1);

    return result ?? null;
  }

  /**
   * Get trend data for a model
   */
  static async getTrendData(
    modelId: string,
    limit = 20
  ): Promise<BenchmarkTrendData> {
    const results = await db
      .select()
      .from(benchmarkResults)
      .where(eq(benchmarkResults.modelId, modelId))
      .orderBy(desc(benchmarkResults.runAt))
      .limit(limit);

    // Reverse to get chronological order
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
    benchmarkId?: string
  ): Promise<Map<string, BenchmarkResult[]>> {
    const comparison = new Map<string, BenchmarkResult[]>();

    for (const modelId of modelIds) {
      const conditions: SQL[] = [eq(benchmarkResults.modelId, modelId)];

      if (benchmarkId) {
        conditions.push(eq(benchmarkResults.benchmarkId, benchmarkId));
      }

      const results = await db
        .select()
        .from(benchmarkResults)
        .where(and(...conditions))
        .orderBy(desc(benchmarkResults.runAt))
        .limit(10);

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
    const results = await db
      .select({
        modelId: benchmarkResults.modelId,
        runCount: sql<number>`count(*)::int`,
        avgPnl: sql<number>`avg(${benchmarkResults.totalPnl})`,
        avgAccuracy: sql<number>`avg(${benchmarkResults.predictionAccuracy})`,
        avgOptimality: sql<number>`avg(${benchmarkResults.optimalityScore})`,
        bestPnl: sql<number>`max(${benchmarkResults.totalPnl})`,
        latestRun: sql<Date>`max(${benchmarkResults.runAt})`,
      })
      .from(benchmarkResults)
      .groupBy(benchmarkResults.modelId)
      .orderBy(desc(sql`avg(${benchmarkResults.totalPnl})`));

    return results;
  }

  /**
   * Check if a model improved vs baseline
   */
  static async checkImprovement(
    modelId: string,
    baselineModelId: string,
    benchmarkId: string
  ): Promise<{
    improved: boolean;
    modelPnl: number;
    baselinePnl: number;
    delta: number;
  } | null> {
    const [modelResult] = await db
      .select()
      .from(benchmarkResults)
      .where(
        and(
          eq(benchmarkResults.modelId, modelId),
          eq(benchmarkResults.benchmarkId, benchmarkId)
        )
      )
      .orderBy(desc(benchmarkResults.runAt))
      .limit(1);

    const [baselineResult] = await db
      .select()
      .from(benchmarkResults)
      .where(
        and(
          eq(benchmarkResults.modelId, baselineModelId),
          eq(benchmarkResults.benchmarkId, benchmarkId)
        )
      )
      .orderBy(desc(benchmarkResults.runAt))
      .limit(1);

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
