/**
 * Embeddings via mlx-lm.server's OpenAI-compatible `/v1/embeddings` endpoint.
 *
 * `mlx-lm.server` only exposes embeddings when an embedding-capable model is
 * loaded. If `MLX_EMBEDDING_MODEL` is not set and the server has no embedding
 * model loaded, this handler returns a zero vector with a logged warning — the
 * runtime stays alive but the agent's recall quality degrades until the
 * operator configures one.
 *
 * Why a zero vector instead of throwing: parity with `plugin-ollama` and
 * `plugin-lmstudio`. The embedding path is hit during message persistence;
 * throwing would crash every inbound message when the local server is
 * configured for text-only.
 */

import type { IAgentRuntime, TextEmbeddingParams } from "@elizaos/core";
import { logger, ModelType } from "@elizaos/core";
import { type EmbeddingModel, embed } from "ai";
import { createMlxClient } from "../utils/client";
import { getEmbeddingModel } from "../utils/config";
import { emitModelUsed, estimateEmbeddingUsage, normalizeTokenUsage } from "../utils/model-usage";

const DEFAULT_ZERO_VECTOR_DIM = 1536;

function extractText(params: TextEmbeddingParams | string | null): string {
  if (params === null) {
    return "";
  }
  if (typeof params === "string") {
    return params;
  }
  if (typeof params === "object" && typeof params.text === "string") {
    return params.text;
  }
  return "";
}

export async function handleTextEmbedding(
  runtime: IAgentRuntime,
  params: TextEmbeddingParams | string | null
): Promise<number[]> {
  const modelName = getEmbeddingModel(runtime);

  if (!modelName) {
    logger.warn(
      "[MLX] MLX_EMBEDDING_MODEL not set — returning zero vector. Set it to an embedding model served by mlx_lm.server."
    );
    return new Array<number>(DEFAULT_ZERO_VECTOR_DIM).fill(0);
  }

  let text = extractText(params);
  // Stay within typical embedding context windows (~8k tokens / 4 chars per token).
  const maxChars = 8_000 * 4;
  if (text.length > maxChars) {
    logger.warn(
      `[MLX] Embedding input too long (~${Math.ceil(
        text.length / 4
      )} tokens), truncating to ~8000 tokens`
    );
    text = text.slice(0, maxChars);
  }

  const embeddingText = text || "test";

  try {
    const client = createMlxClient(runtime);
    const { embedding, usage } = await embed({
      model: client.textEmbeddingModel(modelName) as EmbeddingModel,
      value: embeddingText,
    });

    emitModelUsed(
      runtime,
      ModelType.TEXT_EMBEDDING,
      modelName,
      normalizeTokenUsage(usage) ?? estimateEmbeddingUsage(embeddingText)
    );
    return embedding;
  } catch (error) {
    logger.error({ error }, "[MLX] Error generating embedding");
    return new Array<number>(DEFAULT_ZERO_VECTOR_DIM).fill(0);
  }
}
