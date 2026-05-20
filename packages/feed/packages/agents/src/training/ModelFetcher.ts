/**
 * Model Fetcher
 *
 * Fetches trained RL models from the database for inference.
 */

import { db, desc, inArray, trainedModels } from '@feed/db';
import { logger } from '/shared';

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
  const modelResult = await db
    .select()
    .from(trainedModels)
    .where(inArray(trainedModels.status, ['ready', 'deployed']))
    .orderBy(desc(trainedModels.createdAt))
    .limit(1);

  const model = modelResult[0];

  if (!model) {
    return null;
  }

  const rlModelId = model.storagePath || model.modelId;

  if (!rlModelId || rlModelId.trim().length === 0) {
    logger.error(
      'Model has no storagePath or modelId',
      {
        modelId: model.modelId,
        storagePath: model.storagePath,
      },
      'ModelFetcher'
    );
    return null;
  }

  if (!model.baseModel || model.baseModel.trim().length === 0) {
    logger.error(
      'Model has no baseModel',
      {
        modelId: model.modelId,
      },
      'ModelFetcher'
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
