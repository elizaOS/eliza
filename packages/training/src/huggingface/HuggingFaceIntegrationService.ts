/**
 * HuggingFace Integration Service
 *
 * Orchestrates the complete HuggingFace integration pipeline.
 * Main entry point for all HuggingFace operations.
 */

import { getTrainingDataAdapter } from "../adapter";
import { ModelBenchmarkService } from "../benchmark/ModelBenchmarkService";
import { getExportToHuggingFace } from "../dependencies";
import { logger } from "../utils";
import { HuggingFaceDatasetUploader } from "./HuggingFaceDatasetUploader";
import { HuggingFaceModelUploader } from "./HuggingFaceModelUploader";
import { getHuggingFaceToken } from "./shared/HuggingFaceUploadUtil";

export interface WeeklyUploadResult {
  success: boolean;
  datasets: {
    benchmarks: { success: boolean; url?: string; error?: string };
    trajectories: { success: boolean; url?: string; error?: string };
  };
  models: {
    processed: number;
    benchmarked: number;
    uploaded: number;
  };
  errors: string[];
  duration: number;
}

export interface DatasetUploadOptions {
  datasetName?: string;
  trajectoryDatasetName?: string;
  modelNamePrefix?: string;
  modelDescriptionPrefix?: string;
  dryRun?: boolean;
}

export class HuggingFaceIntegrationService {
  private datasetUploader: HuggingFaceDatasetUploader;
  private modelUploader: HuggingFaceModelUploader;

  constructor() {
    this.datasetUploader = new HuggingFaceDatasetUploader();
    this.modelUploader = new HuggingFaceModelUploader();
  }

  /**
   * Execute complete weekly upload pipeline
   */
  async executeWeeklyUpload(
    options: DatasetUploadOptions = {},
  ): Promise<WeeklyUploadResult> {
    const startTime = Date.now();
    logger.info(
      "Starting weekly upload pipeline",
      options,
      "HuggingFaceIntegration",
    );

    const result: WeeklyUploadResult = {
      success: false,
      datasets: {
        benchmarks: { success: false },
        trajectories: { success: false },
      },
      models: {
        processed: 0,
        benchmarked: 0,
        uploaded: 0,
      },
      errors: [],
      duration: 0,
    };

    try {
      // Step 1: Upload benchmark dataset
      if (!options.dryRun) {
        logger.info(
          "Step 1: Uploading benchmark dataset",
          undefined,
          "HuggingFaceIntegration",
        );
        const benchmarkResult = await this.datasetUploader.uploadDataset({
          datasetName:
            options.datasetName ||
            process.env.HF_DATASET_NAME ||
            "elizaos/agent-benchmarks",
          description: "Weekly benchmark results for autonomous ElizaOS agents",
        });

        result.datasets.benchmarks = {
          success: benchmarkResult.success,
          url: benchmarkResult.datasetUrl,
          error: benchmarkResult.error,
        };

        if (!benchmarkResult.success) {
          result.errors.push(
            `Benchmark dataset upload: ${benchmarkResult.error}`,
          );
        }
      } else {
        logger.info(
          "DRY RUN: Skipping benchmark dataset upload",
          undefined,
          "HuggingFaceIntegration",
        );
        result.datasets.benchmarks.success = true;
      }

      // Step 2: Upload trajectory dataset
      if (!options.dryRun) {
        logger.info(
          "Step 2: Uploading trajectory dataset",
          undefined,
          "HuggingFaceIntegration",
        );
        const exportToHuggingFace = getExportToHuggingFace();
        const trajectoryResult = await exportToHuggingFace({
          datasetName:
            options.trajectoryDatasetName ||
            process.env.HF_TRAJECTORY_DATASET_NAME ||
            "elizaos/agent-trajectories",
          format: "jsonl",
        });

        result.datasets.trajectories = {
          success: trajectoryResult.success,
          url: trajectoryResult.url,
          error: trajectoryResult.error,
        };

        if (!trajectoryResult.success) {
          result.errors.push(
            `Trajectory dataset upload: ${trajectoryResult.error}`,
          );
        }
      } else {
        logger.info(
          "DRY RUN: Skipping trajectory dataset upload",
          undefined,
          "HuggingFaceIntegration",
        );
        result.datasets.trajectories.success = true;
      }

      // Step 3: Process models
      const unbenchmarkedModels =
        await ModelBenchmarkService.getUnbenchmarkedModels();
      result.models.processed = unbenchmarkedModels.length;

      logger.info(
        `Step 3: Found ${unbenchmarkedModels.length} unbenchmarked models`,
        undefined,
        "HuggingFaceIntegration",
      );

      if (unbenchmarkedModels.length > 0) {
        const standardBenchmarks =
          await ModelBenchmarkService.getStandardBenchmarkPaths();

        if (standardBenchmarks.length === 0) {
          const error = "No standard benchmarks available for model evaluation";
          logger.error(error, undefined, "HuggingFaceIntegration");
          result.errors.push(error);
        } else {
          for (const modelId of unbenchmarkedModels) {
            try {
              // Benchmark model
              logger.info(
                `Benchmarking model: ${modelId}`,
                undefined,
                "HuggingFaceIntegration",
              );
              await ModelBenchmarkService.benchmarkModel({
                modelId,
                benchmarkPaths: standardBenchmarks,
                saveResults: true,
              });
              result.models.benchmarked++;

              // Compare to baseline
              const comparison =
                await ModelBenchmarkService.compareToBaseline(modelId);

              // Upload if improved
              if (comparison.recommendation === "deploy" && !options.dryRun) {
                logger.info(
                  `Model ${modelId} improved, uploading`,
                  undefined,
                  "HuggingFaceIntegration",
                );

                const model =
                  await getTrainingDataAdapter().getModelById(modelId);

                if (model) {
                  const modelName = options.modelNamePrefix
                    ? `${options.modelNamePrefix}-${model.version}`
                    : process.env.HF_MODEL_NAME
                      ? `${process.env.HF_MODEL_NAME}-${model.version}`
                      : `elizaos/agent-${model.version}`;

                  const modelDescription =
                    options.modelDescriptionPrefix ||
                    process.env.HF_MODEL_DESCRIPTION_PREFIX ||
                    "Autonomous ElizaOS agent";

                  const uploadResult = await this.modelUploader.uploadModel({
                    modelId,
                    modelName,
                    description: `${modelDescription} - v${model.version}`,
                    includeWeights: true,
                  });

                  if (uploadResult.success) {
                    result.models.uploaded++;

                    // Update model with HuggingFace repo
                    await getTrainingDataAdapter().updateModelHuggingFaceRepo(
                      modelId,
                      modelName,
                    );
                  } else {
                    result.errors.push(
                      `Model upload ${modelId}: ${uploadResult.error}`,
                    );
                  }
                }
              } else {
                logger.info(
                  `Model ${modelId} not ready for deployment: ${comparison.recommendation}`,
                  undefined,
                  "HuggingFaceIntegration",
                );
              }
            } catch (error) {
              const errorMsg =
                error instanceof Error ? error.message : String(error);
              logger.error(
                `Failed to process model ${modelId}`,
                { error },
                "HuggingFaceIntegration",
              );
              result.errors.push(`Model ${modelId}: ${errorMsg}`);
            }
          }
        }
      }

      result.success = result.errors.length === 0;
      result.duration = Date.now() - startTime;

      logger.info(
        "Weekly upload pipeline complete",
        {
          success: result.success,
          benchmarkDataset: result.datasets.benchmarks.success,
          trajectoryDataset: result.datasets.trajectories.success,
          modelsProcessed: result.models.processed,
          modelsBenchmarked: result.models.benchmarked,
          modelsUploaded: result.models.uploaded,
          errors: result.errors.length,
          duration: result.duration,
        },
        "HuggingFaceIntegration",
      );

      return result;
    } catch (error) {
      result.duration = Date.now() - startTime;
      result.errors.push(
        error instanceof Error ? error.message : String(error),
      );
      logger.error(
        "Weekly upload pipeline failed",
        { error },
        "HuggingFaceIntegration",
      );
      return result;
    }
  }

  /**
   * Check if new data is available for upload
   */
  async hasNewDataToUpload(): Promise<{
    hasNewBenchmarks: boolean;
    hasNewTrajectories: boolean;
    hasUnbenchmarkedModels: boolean;
    details: {
      newBenchmarksSince?: Date;
      newTrajectoriesCount: number;
      unbenchmarkedModels: number;
    };
  }> {
    const adapter = getTrainingDataAdapter();

    // Get last upload time from database
    const lastUploadTime =
      (await adapter.getLastDeployedModelDate()) || new Date(0);

    // Check for new benchmarks since last upload
    const newBenchmarksCount =
      await adapter.countBenchmarksSince(lastUploadTime);

    // Check for new trajectories since last upload
    const newTrajectoriesCount =
      await adapter.countTrajectoriesSince(lastUploadTime);

    // Check for unbenchmarked models
    const unbenchmarkedModels =
      await ModelBenchmarkService.getUnbenchmarkedModels();

    return {
      hasNewBenchmarks: newBenchmarksCount > 0,
      hasNewTrajectories: newTrajectoriesCount > 0,
      hasUnbenchmarkedModels: unbenchmarkedModels.length > 0,
      details: {
        newBenchmarksSince: lastUploadTime,
        newTrajectoriesCount,
        unbenchmarkedModels: unbenchmarkedModels.length,
      },
    };
  }

  /**
   * Validate system is ready for HuggingFace operations
   */
  async validateSystemReadiness(): Promise<{
    ready: boolean;
    issues: string[];
    warnings: string[];
  }> {
    const issues: string[] = [];
    const warnings: string[] = [];

    // Check HuggingFace token
    if (!getHuggingFaceToken()) {
      issues.push(
        "HUGGING_FACE_TOKEN or HF_TOKEN environment variable not set",
      );
    }

    const adapter = getTrainingDataAdapter();

    // Check database connection
    try {
      const healthy = await adapter.healthCheck();
      if (!healthy) {
        issues.push("Cannot connect to database");
      }
    } catch {
      issues.push("Cannot connect to database");
    }

    // Check for standard benchmarks
    const standardBenchmarks =
      await ModelBenchmarkService.getStandardBenchmarkPaths();
    if (standardBenchmarks.length === 0) {
      warnings.push(
        "No standard benchmarks found. Generate benchmark fixtures before upload.",
      );
    }

    // Check for data using training statistics
    try {
      const stats = await adapter.getTrainingStatistics();

      if (stats.benchmarkCount === 0) {
        warnings.push(
          "No benchmark results in database. Run some benchmarks first.",
        );
      }

      if (stats.trajectoryTraining === 0) {
        warnings.push(
          "No training trajectories in database. Generate with agents or test data.",
        );
      }

      if (stats.modelTotal === 0) {
        warnings.push("No trained models in database.");
      }
    } catch {
      issues.push("Could not retrieve training statistics");
    }

    return {
      ready: issues.length === 0,
      issues,
      warnings,
    };
  }

  /**
   * Get integration statistics
   */
  async getStatistics(): Promise<{
    benchmarks: { total: number; lastUpload?: Date };
    trajectories: { total: number; training: number };
    models: { total: number; benchmarked: number; deployed: number };
    huggingface: { datasetsPublished: number; modelsPublished: number };
  }> {
    const stats = await getTrainingDataAdapter().getTrainingStatistics();

    return {
      benchmarks: {
        total: stats.benchmarkCount,
        lastUpload: stats.lastBenchmarkDate ?? undefined,
      },
      trajectories: {
        total: stats.trajectoryTotal,
        training: stats.trajectoryTraining,
      },
      models: {
        total: stats.modelTotal,
        benchmarked: stats.modelBenchmarked,
        deployed: stats.modelDeployed,
      },
      huggingface: {
        datasetsPublished:
          (stats.benchmarkCount > 0 ? 1 : 0) +
          (stats.trajectoryTraining > 0 ? 1 : 0),
        modelsPublished: stats.publishedRepoCount,
      },
    };
  }
}

export const huggingFaceIntegration = new HuggingFaceIntegrationService();
