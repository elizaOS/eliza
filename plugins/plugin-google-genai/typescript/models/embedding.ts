import type { IAgentRuntime, TextEmbeddingParams } from "@elizaos/core";
import { logger, ModelType } from "@elizaos/core";
import { createGoogleGenAI, getEmbeddingModel } from "../utils/config";
import { emitModelUsageEvent } from "../utils/events";
import { countTokens } from "../utils/tokenization";

export async function handleTextEmbedding(
  runtime: IAgentRuntime,
  params: TextEmbeddingParams | string | null
): Promise<number[]> {
  const genAI = createGoogleGenAI(runtime);
  if (!genAI) {
    throw new Error("Google Generative AI client not initialized");
  }

  const embeddingModelName = getEmbeddingModel(runtime);
  logger.debug(`[TEXT_EMBEDDING] Using model: ${embeddingModelName}`);

  if (params === null) {
    return Array(768).fill(0) as number[];
  }

  const text =
    typeof params === "string"
      ? params
      : typeof params === "object" && params.text
        ? params.text
        : "";

  if (!text.trim()) {
    logger.warn("Empty text for embedding");
    return Array(768).fill(0) as number[];
  }

  try {
    const response = await genAI.models.embedContent({
      model: embeddingModelName,
      contents: text,
    });

    const embedding = response.embeddings?.[0]?.values || [];

    const promptTokens = await countTokens(text);

    emitModelUsageEvent(runtime, ModelType.TEXT_EMBEDDING, text, {
      promptTokens,
      completionTokens: 0,
      totalTokens: promptTokens,
    });

    logger.log(`Got embedding with length ${embedding.length}`);
    return embedding;
  } catch (error) {
    logger.error(
      `Error generating embedding: ${error instanceof Error ? error.message : String(error)}`
    );
    return Array(768).fill(0) as number[];
  }
}
