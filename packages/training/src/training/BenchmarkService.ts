/**
 * Training Benchmark Service
 *
 * Handles model benchmarking during the training pipeline.
 *
 * **Purpose:** Evaluate models as part of continuous training
 * **Used by:** AutomationPipeline, continuous training scripts
 * **Storage:** trainedModel.evalMetrics (JSON field)
 * **Focus:** Training pipeline integration, deployment decisions
 *
 * **Note:** For HuggingFace upload benchmarking, see ModelBenchmarkService
 *
 * @see ModelBenchmarkService - For HuggingFace upload evaluation
 */

import fs from "node:fs/promises";
import path from "node:path";
import { getTrainingDataAdapter, type JsonValue } from "../adapter";
import { BenchmarkRunner } from "../benchmark/BenchmarkRunner";
import { getAgentRuntimeManager } from "../dependencies";
import { logger } from "../utils/logger";

export interface BenchmarkResults {
  modelId: string;
  benchmarkScore: number; // Overall composite score
  pnl: number;
  accuracy: number;
  optimality: number;
  perpTrades: number;
  correctPredictions: number;
  totalPositions: number;
  duration: number;
  timestamp: Date;
}

export interface ComparisonResults {
  newModel: string;
  previousModel: string | null;
  newScore: number;
  previousScore: number | null;
  improvement: number | null; // Percentage improvement
  shouldDeploy: boolean;
  reason: string;
}

export class BenchmarkService {
  private readonly DEPLOYMENT_THRESHOLD = 0.95; // Deploy if new model >= 95% of best
  // Use the 1-week benchmark we generated for comprehensive evaluation
  private readonly DEFAULT_BENCHMARK_PATH = path.resolve(
    process.cwd(),
    "benchmarks/benchmark-week-10080-60-10-5-8-12345.json",
  );
  private readonly RESULTS_DIR = path.resolve(
    process.cwd(),
    "benchmark-results/models",
  );

  /**
   * Get benchmark path with fallback to first available benchmark
   *
   * Attempts to use the default benchmark file, falling back to any
   * available benchmark file if the default is not found.
   *
   * @returns Path to benchmark JSON file
   * @throws Error if no benchmark files are found
   */
  private async getBenchmarkPath(): Promise<string> {
    // Try default first
    try {
      await fs.access(this.DEFAULT_BENCHMARK_PATH);
      return this.DEFAULT_BENCHMARK_PATH;
    } catch {
      // Fallback: find any benchmark file
      const benchmarkDir = path.resolve(process.cwd(), "benchmarks");
      const files = await fs.readdir(benchmarkDir);
      const benchmarkFiles = files.filter(
        (f) => f.startsWith("benchmark-") && f.endsWith(".json"),
      );

      if (benchmarkFiles.length > 0) {
        const firstFile = benchmarkFiles[0];
        if (!firstFile) throw new Error("Benchmark files array empty");
        const fallbackPath = path.join(benchmarkDir, firstFile);
        logger.warn(
          `Default benchmark not found, using: ${fallbackPath}`,
          undefined,
          "BenchmarkService",
        );
        return fallbackPath;
      }
    }

    throw new Error(
      "No benchmark files found. Generate benchmark data before running evaluation.",
    );
  }

  /**
   * Run benchmark on a trained model
   *
   * Executes a full benchmark run using the BenchmarkRunner, evaluates
   * the model's performance, and stores results in the database.
   *
   * @param modelId - Unique identifier for the trained model
   * @param benchmarkPath - Optional path to benchmark file (uses default if not provided)
   * @returns BenchmarkResults with comprehensive performance metrics
   * @throws Error if model not found or benchmark fails
   *
   * @example
   * ```typescript
   * const results = await benchmarkService.benchmarkModel('model-123');
   * console.log(`Score: ${results.benchmarkScore}`);
   * console.log(`Accuracy: ${results.accuracy}`);
   * ```
   */
  async benchmarkModel(
    modelId: string,
    benchmarkPath?: string,
  ): Promise<BenchmarkResults> {
    logger.info(
      `Benchmarking model: ${modelId}`,
      undefined,
      "BenchmarkService",
    );

    const startTime = Date.now();

    // Get benchmark file (with fallback logic)
    const bmPath = benchmarkPath || (await this.getBenchmarkPath());

    // Get test agent
    const agent = await this.getTestAgent();

    // Create output directory
    const outputDir = path.join(
      this.RESULTS_DIR,
      modelId,
      Date.now().toString(),
    );
    await fs.mkdir(outputDir, { recursive: true });

    // Get agent runtime
    const runtime = await getAgentRuntimeManager().getRuntime(agent.id);

    // Force the runtime to use the specific model we're benchmarking
    // by temporarily overriding the model selection
    const model = await getTrainingDataAdapter().getModelById(modelId);

    if (!model) {
      throw new Error(`Model not found: ${modelId}`);
    }

    // Validate and get model identifier for inference
    const modelIdentifier = this.getValidModelIdentifier(model);

    // Run benchmark
    logger.info(
      "Running benchmark...",
      {
        modelId,
        modelIdentifier,
        agent: agent.username,
      },
      "BenchmarkService",
    );

    const result = await BenchmarkRunner.runSingle({
      benchmarkPath: bmPath,
      agentRuntime: runtime,
      agentUserId: agent.id,
      saveTrajectory: true,
      outputDir,
      forceModel: modelIdentifier, // Use validated W&B model ID
    });

    const duration = Date.now() - startTime;

    // Calculate composite benchmark score
    // Formula: 0.4 * normalized_pnl + 0.3 * accuracy + 0.3 * optimality
    const normalizedPnl = this.normalizePnl(result.metrics.totalPnl);
    const benchmarkScore =
      0.4 * normalizedPnl +
      0.3 * result.metrics.predictionMetrics.accuracy +
      0.3 * (result.metrics.optimalityScore / 100);

    const benchmarkResults: BenchmarkResults = {
      modelId,
      benchmarkScore,
      pnl: result.metrics.totalPnl,
      accuracy: result.metrics.predictionMetrics.accuracy,
      optimality: result.metrics.optimalityScore,
      perpTrades: result.metrics.perpMetrics.totalTrades,
      correctPredictions: result.metrics.predictionMetrics.correctPredictions,
      totalPositions: result.metrics.predictionMetrics.totalPositions,
      duration,
      timestamp: new Date(),
    };

    logger.info(
      "Benchmark complete",
      {
        modelId,
        score: benchmarkScore.toFixed(3),
        pnl: result.metrics.totalPnl.toFixed(2),
        accuracy: `${(result.metrics.predictionMetrics.accuracy * 100).toFixed(1)}%`,
        optimality: `${result.metrics.optimalityScore.toFixed(1)}%`,
        duration: `${(duration / 1000).toFixed(1)}s`,
      },
      "BenchmarkService",
    );

    // Store results
    await this.storeBenchmarkResults(modelId, benchmarkResults);

    return benchmarkResults;
  }

  /**
   * Compare new model performance against previous best
   *
   * Evaluates whether a new model should be deployed based on its benchmark
   * score compared to the previous best model. Uses a configurable threshold.
   *
   * @param newModelId - Unique identifier for the new model to compare
   * @param threshold - Deployment threshold (default: 0.95, meaning 95% of best)
   * @returns ComparisonResults with deployment recommendation
   * @throws Error if model not found or not benchmarked
   *
   * @example
   * ```typescript
   * const comparison = await benchmarkService.compareModels('model-123');
   * if (comparison.shouldDeploy) {
   *   console.log(`Deploying: ${comparison.reason}`);
   * }
   * ```
   */
  async compareModels(
    newModelId: string,
    threshold: number = this.DEPLOYMENT_THRESHOLD,
  ): Promise<ComparisonResults> {
    logger.info(
      `Comparing model: ${newModelId}`,
      undefined,
      "BenchmarkService",
    );

    // Get new model's benchmark results
    const newModel = await getTrainingDataAdapter().getModelById(newModelId);

    if (!newModel) {
      throw new Error(`Model not found: ${newModelId}`);
    }

    if (newModel.benchmarkScore === null) {
      throw new Error(`Model has not been benchmarked: ${newModelId}`);
    }

    const newScore = newModel.benchmarkScore;

    // Get previous best model (excluding the new one)
    const previousBest =
      await getTrainingDataAdapter().getBestBenchmarkedModel(newModelId);

    // If no previous model, always deploy
    if (!previousBest) {
      logger.info(
        "No previous model to compare - will deploy",
        { newScore },
        "BenchmarkService",
      );
      return {
        newModel: newModelId,
        previousModel: null,
        newScore,
        previousScore: null,
        improvement: null,
        shouldDeploy: true,
        reason: "First model - no comparison available",
      };
    }

    const previousScore = previousBest.benchmarkScore ?? 0;
    const improvement = ((newScore - previousScore) / previousScore) * 100;
    const thresholdScore = previousScore * threshold;
    const shouldDeploy = newScore >= thresholdScore;

    let reason = "";
    if (shouldDeploy) {
      if (newScore > previousScore) {
        reason = `Improved by ${improvement.toFixed(1)}% (${newScore.toFixed(3)} > ${previousScore.toFixed(3)})`;
      } else {
        reason = `Within acceptable range (${newScore.toFixed(3)} >= ${thresholdScore.toFixed(3)}, threshold: ${threshold * 100}%)`;
      }
    } else {
      reason = `Performance too low (${newScore.toFixed(3)} < ${thresholdScore.toFixed(3)}, need ${threshold * 100}% of best)`;
    }

    logger.info(
      "Model comparison complete",
      {
        newModel: newModelId,
        newScore: newScore.toFixed(3),
        previousModel: previousBest.modelId,
        previousScore: previousScore.toFixed(3),
        improvement: `${improvement.toFixed(1)}%`,
        shouldDeploy,
        reason,
      },
      "BenchmarkService",
    );

    return {
      newModel: newModelId,
      previousModel: previousBest.modelId,
      newScore,
      previousScore,
      improvement,
      shouldDeploy,
      reason,
    };
  }

  /**
   * Store benchmark results in database
   *
   * Saves benchmark metrics to the trainedModel record for tracking
   * and comparison purposes.
   *
   * @param modelId - Unique identifier for the trained model
   * @param results - Benchmark results to store
   * @throws Error if model not found or database update fails
   */
  async storeBenchmarkResults(
    modelId: string,
    results: BenchmarkResults,
  ): Promise<void> {
    await getTrainingDataAdapter().updateModelBenchmarkResults(modelId, {
      benchmarkScore: results.benchmarkScore,
      accuracy: results.accuracy,
      evalMetrics: {
        pnl: results.pnl,
        accuracy: results.accuracy,
        optimality: results.optimality,
        perpTrades: results.perpTrades,
        correctPredictions: results.correctPredictions,
        totalPositions: results.totalPositions,
        duration: results.duration,
        benchmarkedAt: results.timestamp.toISOString(),
      } as JsonValue,
    });

    logger.info(
      "Stored benchmark results",
      { modelId, score: results.benchmarkScore },
      "BenchmarkService",
    );
  }

  /**
   * Determine if model should be deployed based on performance
   *
   * Convenience wrapper around compareModels() that returns only
   * the deployment decision boolean.
   *
   * @param modelId - Unique identifier for the model to evaluate
   * @param threshold - Deployment threshold (default: 0.95)
   * @returns True if model should be deployed, false otherwise
   * @throws Error if model not found or not benchmarked
   */
  async shouldDeploy(
    modelId: string,
    threshold: number = this.DEPLOYMENT_THRESHOLD,
  ): Promise<boolean> {
    const comparison = await this.compareModels(modelId, threshold);
    return comparison.shouldDeploy;
  }

  /**
   * Validate and get model identifier for inference
   *
   * Ensures storagePath is a valid W&B model ID or HuggingFace path.
   * Falls back to modelId or baseModel if storagePath is invalid.
   *
   * @param model - Model object with storagePath, modelId, and baseModel
   * @returns Valid model identifier string for inference
   *
   * @remarks
   * Valid formats:
   * - W&B: "entity/project/model-name:version"
   * - HuggingFace: "org/model-name"
   * - Falls back to baseModel if none valid
   */
  private getValidModelIdentifier(model: {
    storagePath: string;
    modelId: string;
    baseModel: string;
  }): string {
    const storagePath = model.storagePath;

    // Validate storagePath format (should be W&B model ID or HuggingFace path)
    // W&B format: entity/project/model-name:version or entity/project/model-name:stepN
    // HuggingFace: org/model-name

    if (storagePath && storagePath.trim().length > 0) {
      // Check if it looks like a valid model ID
      if (storagePath.includes("/") || storagePath.includes(":")) {
        return storagePath;
      }

      // StoragePath is invalid, log warning
      logger.warn(
        `Invalid storagePath format: ${storagePath}, falling back to modelId`,
        { modelId: model.modelId },
        "BenchmarkService",
      );
    }

    // Fallback to base model if modelId also doesn't look valid
    if (model.modelId.includes("/")) {
      return model.modelId;
    }

    // Last resort: use base model from training
    logger.warn(
      `No valid model identifier found, using baseModel`,
      { modelId: model.modelId, baseModel: model.baseModel },
      "BenchmarkService",
    );
    return model.baseModel;
  }

  /**
   * Get test agent for benchmarking
   *
   * Finds a suitable test agent for running benchmarks.
   * Prefers specific test agents, falls back to any agent if none found.
   *
   * @returns User record for the test agent
   * @throws Error if no agents found in database
   */
  private async getTestAgent() {
    const adapter = getTrainingDataAdapter();
    const allAgents = await adapter.getAgentUsers();

    // Try to find a specific test agent
    const preferredUsernames = [
      "trader-aggressive",
      "test-agent",
      "benchmark-agent",
    ];
    let agent = allAgents.find(
      (a) => a.username && preferredUsernames.includes(a.username),
    );

    // Fall back to any agent
    if (!agent) {
      agent = allAgents[0];
    }

    if (!agent) {
      throw new Error("No test agent available for benchmarking");
    }

    return agent;
  }

  /**
   * Normalize P&L to 0-1 scale
   * Assumes typical range of -5000 to +5000
   */
  private normalizePnl(pnl: number): number {
    const min = -5000;
    const max = 5000;
    const normalized = (pnl - min) / (max - min);
    return Math.max(0, Math.min(1, normalized)); // Clamp to [0, 1]
  }

  /**
   * Get benchmark summary for monitoring
   */
  async getBenchmarkSummary() {
    const models = await getTrainingDataAdapter().getBenchmarkedModels(10);

    const summary = models.map((m: (typeof models)[number]) => ({
      modelId: m.modelId,
      version: m.version,
      score: m.benchmarkScore,
      accuracy: m.accuracy,
      status: m.status,
      createdAt: m.createdAt,
    }));

    return {
      totalBenchmarked: models.length,
      topModels: summary.slice(0, 5),
      recentModels: summary
        .sort(
          (a: (typeof summary)[number], b: (typeof summary)[number]) =>
            b.createdAt.getTime() - a.createdAt.getTime(),
        )
        .slice(0, 5),
    };
  }

  /**
   * Run benchmark on multiple models for comparison
   */
  async benchmarkMultipleModels(
    modelIds: string[],
    benchmarkPath?: string,
  ): Promise<Record<string, BenchmarkResults>> {
    const results: Record<string, BenchmarkResults> = {};

    for (const modelId of modelIds) {
      const result = await this.benchmarkModel(modelId, benchmarkPath);
      results[modelId] = result;
    }

    return results;
  }
}

// Export singleton instance
export const benchmarkService = new BenchmarkService();
