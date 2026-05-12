/**
 * Embeddings via Ollama + AI SDK `embed`.
 *
 * **Why v2 provider:** `createOllama` from `ollama-ai-provider-v2` registers embedding models on
 * the same supported AI SDK surface as chat (`models/text.ts`). Mixed v1/v2 providers in one
 * agent were a common source of `Unsupported model version v1` during dependency bumps.
 */
import type { IAgentRuntime, TextEmbeddingParams } from "@elizaos/core";
import { logger, ModelType } from "@elizaos/core";
import { type EmbeddingModel, embed } from "ai";
import { createOllama } from "ollama-ai-provider-v2";

import { getBaseURL, getEmbeddingModel } from "../utils/config";
import { emitModelUsed, estimateEmbeddingUsage, normalizeTokenUsage } from "../utils/modelUsage";
import { ensureModelAvailable } from "./availability";

export async function handleTextEmbedding(
  runtime: IAgentRuntime,
  params: TextEmbeddingParams | string | null
): Promise<number[]> {
  try {
    const baseURL = getBaseURL(runtime);
    const customFetch = runtime.fetch ?? undefined;
    const ollama = createOllama({
      fetch: customFetch,
      baseURL,
    });

    const modelName = getEmbeddingModel(runtime);
    logger.log(`[Ollama] Using TEXT_EMBEDDING model: ${modelName}`);
    await ensureModelAvailable(modelName, baseURL, customFetch);

    let text =
      typeof params === "string"
        ? params
        : params
          ? (params as TextEmbeddingParams).text || ""
          : "";

    // Truncate to stay within embedding model token limits (~4 chars per token)
    const maxChars = 8_000 * 4;
    if (text.length > maxChars) {
      logger.warn(
        `[Ollama] Embedding input too long (~${Math.ceil(text.length / 4)} tokens), truncating to ~8000 tokens`
      );
      text = text.slice(0, maxChars);
    }

    const embeddingText = text || "test";

    try {
      const embedParams = {
        model: ollama.embedding(modelName) as EmbeddingModel,
        value: embeddingText,
      };

      const { embedding, usage } = await embed(embedParams);
      emitModelUsed(
        runtime,
        ModelType.TEXT_EMBEDDING,
        modelName,
        normalizeTokenUsage(usage) ?? estimateEmbeddingUsage(embeddingText)
      );
      return embedding;
    } catch (embeddingError) {
      logger.error({ error: embeddingError }, "Error generating embedding");
      return Array(1536).fill(0);
    }
  } catch (error) {
    logger.error({ error }, "Error in TEXT_EMBEDDING model");
    return Array(1536).fill(0);
  }
}
