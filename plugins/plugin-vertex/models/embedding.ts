import type { IAgentRuntime, TextEmbeddingParams } from "@elizaos/core";
import { logger, ModelType } from "@elizaos/core";
import { embed } from "ai";
import { createGoogleClient } from "../providers";
import {
  emitModelUsed,
  estimateEmbeddingUsage,
  normalizeTokenUsage,
} from "../utils/modelUsage";
import { executeWithRetry } from "../utils/retry";

const DEFAULT_EMBEDDING_MODEL = "text-embedding-005";

function getEmbeddingModel(runtime: IAgentRuntime): string {
  const setting = runtime.getSetting("VERTEX_EMBEDDING_MODEL");
  if (typeof setting === "string" && setting.length > 0) return setting;
  return process.env.VERTEX_EMBEDDING_MODEL ?? DEFAULT_EMBEDDING_MODEL;
}

export async function handleTextEmbedding(
  runtime: IAgentRuntime,
  params: TextEmbeddingParams | string | null,
): Promise<number[]> {
  // The runtime probes this handler at startup with `null` params to measure
  // the embedding dimension (`ensureEmbeddingDimension`). Returning an empty
  // array fails that init step, so we embed a single-space sentinel for
  // null/empty inputs to surface a valid dimension.
  const text =
    typeof params === "string" && params.length > 0
      ? params
      : (params && typeof params === "object" && params.text) || " ";

  const modelName = getEmbeddingModel(runtime);
  const vertex = createGoogleClient(runtime);

  logger.debug(`[Vertex] Embedding using ${modelName}`);

  const dimensionSetting = runtime.getSetting("VERTEX_EMBEDDING_DIMENSIONS");
  const outputDimensionality =
    typeof dimensionSetting === "number"
      ? dimensionSetting
      : typeof dimensionSetting === "string"
        ? parseInt(dimensionSetting, 10)
        : undefined;

  const { embedding, usage } = await executeWithRetry("embedding request", () =>
    embed({
      model: vertex.textEmbeddingModel(modelName),
      value: text,
      ...(outputDimensionality
        ? {
            providerOptions: {
              google: { outputDimensionality },
            },
          }
        : {}),
    }),
  );
  emitModelUsed(
    runtime,
    ModelType.TEXT_EMBEDDING,
    modelName,
    normalizeTokenUsage(usage) ?? estimateEmbeddingUsage(text),
    "google",
  );

  return embedding;
}
