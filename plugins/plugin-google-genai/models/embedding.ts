import type { IAgentRuntime, TextEmbeddingParams } from "@elizaos/core";
import * as ElizaCore from "@elizaos/core";
import { logger } from "@elizaos/core";
import { createGoogleGenAI, getEmbeddingModel } from "../utils/config";
import { emitModelUsageEvent } from "../utils/events";
import { countTokens } from "../utils/tokenization";

const TEXT_EMBEDDING_MODEL_TYPE = ((
  ElizaCore as { ModelType?: Record<string, string> }
).ModelType?.TEXT_EMBEDDING ?? "TEXT_EMBEDDING") as string;

export async function handleTextEmbedding(
  runtime: IAgentRuntime,
  params: TextEmbeddingParams | string | null,
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

  let text =
    typeof params === "string"
      ? params
      : typeof params === "object" && params.text
        ? params.text
        : "";

  if (!text.trim()) {
    logger.warn("Empty text for embedding");
    return Array(768).fill(0) as number[];
  }

  // Truncate to stay within embedding model token limits (~4 chars per token)
  const maxChars = 8_192 * 4;
  if (text.length > maxChars) {
    logger.warn(
      `[Google GenAI] Embedding input too long (~${Math.ceil(text.length / 4)} tokens), truncating to ~8192 tokens`,
    );
    text = text.slice(0, maxChars);
  }

  try {
    const response = await genAI.models.embedContent({
      model: embeddingModelName,
      contents: text,
    });

    const embedding = response.embeddings?.[0]?.values || [];

    const promptTokens = await countTokens(text);

    emitModelUsageEvent(runtime, TEXT_EMBEDDING_MODEL_TYPE, text, {
      promptTokens,
      completionTokens: 0,
      totalTokens: promptTokens,
    });

    logger.log(`Got embedding with length ${embedding.length}`);
    return embedding;
  } catch (error) {
    logger.error(
      `Error generating embedding: ${error instanceof Error ? error.message : String(error)}`,
    );
    return Array(768).fill(0) as number[];
  }
}
