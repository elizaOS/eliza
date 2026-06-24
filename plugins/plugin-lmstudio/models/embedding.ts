/**
 * Embeddings via LM Studio's OpenAI-compatible `/v1/embeddings` endpoint.
 *
 * LM Studio only exposes embeddings when the user explicitly loads an embedding-capable
 * model (e.g. `nomic-embed-text-v1.5-Q4_K_M`). When `LMSTUDIO_EMBEDDING_MODEL` is unset
 * (no embedding model configured at all), this handler returns a zero vector with a
 * logged warning so a text-only deployment stays alive — embeddings are simply absent,
 * not failing.
 *
 * A real embed failure is different: when the provider is configured but the request
 * errors, this throws (matching `plugin-openai`/`plugin-ollama`/`plugin-elizacloud`).
 * Fabricating a zero vector on error silently poisons the vector store and degrades RAG
 * with no signal — see #9324. Recall callers fail open to keyword search on the throw.
 */

import type { IAgentRuntime, TextEmbeddingParams } from "@elizaos/core";
import { logger, ModelType } from "@elizaos/core";
import { type EmbeddingModel, embed } from "ai";
import { createLMStudioClient } from "../utils/client";
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
      "[LMStudio] LMSTUDIO_EMBEDDING_MODEL not set — returning zero vector. Set it to a loaded embedding model in LM Studio."
    );
    return new Array<number>(DEFAULT_ZERO_VECTOR_DIM).fill(0);
  }

  let text = extractText(params);
  // Stay within typical embedding context windows (~8k tokens / 4 chars per token).
  const maxChars = 8_000 * 4;
  if (text.length > maxChars) {
    logger.warn(
      `[LMStudio] Embedding input too long (~${Math.ceil(
        text.length / 4
      )} tokens), truncating to ~8000 tokens`
    );
    text = text.slice(0, maxChars);
  }

  const embeddingText = text || "test";

  try {
    const client = createLMStudioClient(runtime);
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
    logger.error({ error }, "[LMStudio] Error generating embedding");
    throw error;
  }
}
