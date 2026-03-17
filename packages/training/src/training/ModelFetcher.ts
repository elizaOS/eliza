/**
 * Model Fetcher
 *
 * Fetches trained RL models from the database for inference.
 */

import { getTrainingDataAdapter } from "../adapter";
import { logger } from "../utils/logger";

export interface ModelArtifact {
  version: string;
  modelId: string;
  modelPath: string;
  metadata: {
    avgReward?: number;
    benchmarkScore?: number;
    baseModel: string;
    trainedAt: Date;
  };
}

/**
 * Get the latest RL model from database
 */
export async function getLatestRLModel(): Promise<ModelArtifact | null> {
  // Adapter returns the most recently created model.
  // Original query filtered to status IN ('ready', 'deployed').
  const adapter = getTrainingDataAdapter();
  const model = await adapter.getLatestModel();

  if (!model) {
    return null;
  }

  // Skip models that aren't ready or deployed
  if (model.status !== "ready" && model.status !== "deployed") {
    return null;
  }

  const rlModelId = model.storagePath || model.modelId;

  if (!rlModelId || rlModelId.trim().length === 0) {
    logger.error(
      "Model has no storagePath or modelId",
      {
        modelId: model.modelId,
        storagePath: model.storagePath,
      },
      "ModelFetcher",
    );
    return null;
  }

  if (!model.baseModel || model.baseModel.trim().length === 0) {
    logger.error(
      "Model has no baseModel",
      {
        modelId: model.modelId,
      },
      "ModelFetcher",
    );
    return null;
  }

  return {
    version: model.version,
    modelId: rlModelId,
    modelPath: rlModelId,
    metadata: {
      avgReward: model.avgReward ?? undefined,
      benchmarkScore: model.benchmarkScore ?? undefined,
      baseModel: model.baseModel,
      trainedAt: model.createdAt,
    },
  };
}
