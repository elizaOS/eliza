/**
 * Model Selection Service
 *
 * Determines which base model to use for training based on:
 * 1. Number of available training bundles
 * 2. Existence of trained models
 * 3. Performance of previous models
 */

import { getTrainingDataAdapter } from "../adapter";
import { logger } from "../utils/logger";

export interface ModelSelectionResult {
  modelId: string;
  modelPath: string;
  strategy: "base" | "continue" | "force_first";
  reason: string;
  metadata?: {
    bundleCount?: number;
    bestModelScore?: number;
    baseModel?: string;
  };
}

export interface TrainingBundle {
  id: string;
  trajectoryCount: number;
  scenarioId: string | null;
  createdAt: Date;
}

export class ModelSelectionService {
  /** Default base model - uses Qwen3-4B-128K (4B params, 128K context). Scale up via MODEL_TIER or AVAILABLE_VRAM_GB env vars */
  private readonly BASE_MODEL =
    process.env.BASE_MODEL || "unsloth/Qwen3-4B-128K";
  private readonly BUNDLE_THRESHOLD = 1000;
  private readonly MIN_BUNDLES_FOR_TRAINING = 100;
  private readonly MAX_TRAINING_EXAMPLES = 2000;

  /**
   * Select base model for training
   *
   * Determines which model to use as the base for training based on available
   * training data and existing model performance.
   *
   * Decision tree:
   * 1. No models exist? → Force first model from base
   * 2. < 100 bundles? → Wait (not ready) - throws error
   * 3. < 1000 bundles? → Train from base model
   * 4. ≥ 1000 bundles? → Train from best performing model
   *
   * @returns ModelSelectionResult with selected model and strategy
   * @throws Error if insufficient training data (< 100 bundles)
   *
   * @example
   * ```typescript
   * const result = await modelSelectionService.selectBaseModel();
   * console.log(`Strategy: ${result.strategy}`);
   * console.log(`Model: ${result.modelPath}`);
   * ```
   */
  async selectBaseModel(): Promise<ModelSelectionResult> {
    logger.info(
      "Selecting base model for training...",
      undefined,
      "ModelSelectionService",
    );

    // Count available training bundles (always fetch for accurate metrics)
    const bundleCount = await this.countTrainingBundles();

    // Check if any models exist
    const forceFirst = await this.shouldForceFirstModel();

    if (forceFirst) {
      logger.info(
        "No models exist - forcing first model creation",
        undefined,
        "ModelSelectionService",
      );
      return {
        modelId: this.BASE_MODEL,
        modelPath: this.BASE_MODEL,
        strategy: "force_first",
        reason: "No trained models exist - creating first model from base",
        metadata: {
          baseModel: this.BASE_MODEL,
          bundleCount, // Use actual count, not 0
        },
      };
    }
    logger.info(
      `Found ${bundleCount} training bundles`,
      undefined,
      "ModelSelectionService",
    );

    // Not enough data yet
    if (bundleCount < this.MIN_BUNDLES_FOR_TRAINING) {
      throw new Error(
        `Insufficient training data: ${bundleCount} bundles ` +
          `(need ${this.MIN_BUNDLES_FOR_TRAINING} minimum)`,
      );
    }

    // Less than threshold: train from base model
    if (bundleCount < this.BUNDLE_THRESHOLD) {
      logger.info(
        `Bundle count ${bundleCount} < ${this.BUNDLE_THRESHOLD} - using base model`,
        undefined,
        "ModelSelectionService",
      );
      return {
        modelId: this.BASE_MODEL,
        modelPath: this.BASE_MODEL,
        strategy: "base",
        reason: `Training from base model (${bundleCount} bundles < ${this.BUNDLE_THRESHOLD} threshold)`,
        metadata: {
          bundleCount,
          baseModel: this.BASE_MODEL,
        },
      };
    }

    // Above threshold: train from best performing model
    const bestModel = await this.getBestPerformingModel();

    if (!bestModel) {
      logger.warn(
        "No best model found despite bundle threshold - using base model",
        undefined,
        "ModelSelectionService",
      );
      return {
        modelId: this.BASE_MODEL,
        modelPath: this.BASE_MODEL,
        strategy: "base",
        reason: "No previous models available - using base model",
        metadata: {
          bundleCount,
          baseModel: this.BASE_MODEL,
        },
      };
    }

    logger.info(
      `Bundle count ${bundleCount} ≥ ${this.BUNDLE_THRESHOLD} - continuing from best model`,
      {
        bestModelId: bestModel.modelId,
        bestScore: bestModel.benchmarkScore,
      },
      "ModelSelectionService",
    );

    // Use storagePath for model path (e.g., HuggingFace URL)
    const modelStoragePath = bestModel.storagePath || bestModel.modelId;

    return {
      modelId: bestModel.modelId,
      modelPath: modelStoragePath,
      strategy: "continue",
      reason: `Continuing from best model (score: ${bestModel.benchmarkScore?.toFixed(3) || "N/A"})`,
      metadata: {
        bundleCount,
        bestModelScore: bestModel.benchmarkScore || undefined,
        baseModel: bestModel.baseModel,
      },
    };
  }

  /**
   * Get best performing model based on benchmark scores
   *
   * Finds the trained model with the highest benchmark score that is
   * ready or deployed. Used for continuing training from a strong baseline.
   *
   * @returns Best performing model record, or null if none found
   *
   * @remarks
   * Only considers models with status 'ready' or 'deployed' and
   * non-null benchmark scores.
   */
  async getBestPerformingModel() {
    const model = await getTrainingDataAdapter().getBestBenchmarkedModel();

    if (!model) {
      logger.warn(
        "No benchmarked models found",
        undefined,
        "ModelSelectionService",
      );
      return null;
    }

    logger.info(
      "Found best performing model",
      {
        modelId: model.modelId,
        version: model.version,
        benchmarkScore: model.benchmarkScore,
        avgReward: model.avgReward,
      },
      "ModelSelectionService",
    );

    return model;
  }

  /**
   * Count available training bundles
   *
   * A "bundle" is a trajectory that:
   * - Is marked as training data
   * - Has been scored (aiJudgeReward IS NOT NULL)
   * - Has not been used in training yet
   * - Has valid steps data (not 'null' or '[]')
   *
   * @returns Number of available training bundles
   */
  async countTrainingBundles(): Promise<number> {
    return await getTrainingDataAdapter().countScoredTrajectoriesReady();
  }

  /**
   * Check if we should force first model creation
   *
   * Returns true if no trained models exist yet, indicating we should
   * create the first model from the base model.
   *
   * @returns True if no models exist, false otherwise
   */
  async shouldForceFirstModel(): Promise<boolean> {
    const modelCount = await this.countTrainedModels();
    return modelCount === 0;
  }

  /**
   * Count existing trained models
   */
  private async countTrainedModels(): Promise<number> {
    return await getTrainingDataAdapter().countActiveModels();
  }

  /**
   * Get training data limit based on bundle count
   *
   * Determines how many trajectories to use for training:
   * - < 1000 bundles: Use all available (returns null)
   * - ≥ 1000 bundles: Cap at 2000 most recent
   *
   * @returns Limit number (2000) or null to use all available
   */
  async getTrainingDataLimit(): Promise<number | null> {
    const bundleCount = await this.countTrainingBundles();

    if (bundleCount < this.BUNDLE_THRESHOLD) {
      return null; // Use all available
    }

    return this.MAX_TRAINING_EXAMPLES; // Cap at 2000
  }

  /**
   * Get trajectories for training (with optional limit)
   *
   * Retrieves scored trajectories that haven't been used in training yet.
   * Orders by most recent first to prioritize fresh data.
   *
   * @param limit - Optional limit on number of trajectories to return
   * @returns Array of training trajectories
   *
   * @remarks
   * Filters to only include:
   * - isTrainingData: true
   * - usedInTraining: false
   * - aiJudgeReward: not null
   * - Valid stepsJson (not 'null' or '[]')
   */
  async getTrainingTrajectories(limit?: number | null) {
    const result = await getTrainingDataAdapter().getTrainingTrajectories(
      limit ?? undefined,
    );

    logger.info(
      `Retrieved ${result.length} trajectories for training`,
      { limit, available: result.length },
      "ModelSelectionService",
    );

    return result;
  }

  /**
   * Get model selection summary for logging/monitoring
   *
   * Provides a comprehensive summary of the current model selection state,
   * including bundle counts, model availability, and recommendations.
   *
   * @returns Summary object with counts, best model info, and recommendation
   *
   * @example
   * ```typescript
   * const summary = await modelSelectionService.getSelectionSummary();
   * console.log(`Bundles: ${summary.bundleCount}`);
   * console.log(`Recommendation: ${summary.recommendation}`);
   * ```
   */
  async getSelectionSummary(): Promise<{
    bundleCount: number;
    trainedModelCount: number;
    bestModel: string | null;
    bestScore: number | null;
    recommendation: string;
  }> {
    const bundleCount = await this.countTrainingBundles();
    const trainedModelCount = await this.countTrainedModels();
    const bestModel = await this.getBestPerformingModel();

    let recommendation = "";
    if (trainedModelCount === 0) {
      recommendation = "Force first model creation";
    } else if (bundleCount < this.MIN_BUNDLES_FOR_TRAINING) {
      recommendation = "Not ready - need more data";
    } else if (bundleCount < this.BUNDLE_THRESHOLD) {
      recommendation = "Train from base model";
    } else {
      recommendation = "Train from best performing model";
    }

    return {
      bundleCount,
      trainedModelCount,
      bestModel: bestModel?.modelId || null,
      bestScore: bestModel?.benchmarkScore || null,
      recommendation,
    };
  }
}

// Export singleton instance
export const modelSelectionService = new ModelSelectionService();
