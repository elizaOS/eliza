/**
 * `TEXT_EMBEDDING` handler backed by Google's `text-embedding-004` (768-dim).
 * A `null`/empty-object input is treated as an initialization probe and answered
 * with a fixed 768-length marker vector so the runtime can size its embedding
 * column without a network call; real text is truncated to the model's ~8192
 * token limit, embedded, and reported via `emitModelUsageEvent`. Throws on empty
 * text and on an empty API response rather than fabricating a vector.
 */
import type { IAgentRuntime, TextEmbeddingParams } from "@elizaos/core";
import * as ElizaCore from "@elizaos/core";
import { logger } from "@elizaos/core";
import { createGoogleGenAI, getEmbeddingModel } from "../utils/config";
import { emitModelUsageEvent } from "../utils/events";
import { countTokens } from "../utils/tokenization";

const TEXT_EMBEDDING_MODEL_TYPE = ((
  ElizaCore as { ModelType?: Record<string, string> }
).ModelType?.TEXT_EMBEDDING ?? "TEXT_EMBEDDING") as string;

function createInitProbeVector(): number[] {
  const vector = Array(768).fill(0);
  vector[0] = 0.1;
  return vector;
}

function extractText(
  params: TextEmbeddingParams | string | null,
): string | null {
  if (params === null) {
    return null;
  }
  if (typeof params === "string") {
    return params;
  }
  if (typeof params === "object" && typeof params.text === "string") {
    return params.text;
  }
  throw new Error(
    "Invalid input format for embedding: expected string or { text: string }",
  );
}

export async function handleTextEmbedding(
  runtime: IAgentRuntime,
  params: TextEmbeddingParams | string | null,
): Promise<number[]> {
  if (params === null) {
    return createInitProbeVector();
  }

  let text = extractText(params);
  if (text === null) {
    return createInitProbeVector();
  }

  if (!text.trim()) {
    throw new Error("Cannot generate embedding for empty text");
  }

  const genAI = createGoogleGenAI(runtime);
  if (!genAI) {
    throw new Error("Google Generative AI client not initialized");
  }

  const embeddingModelName = getEmbeddingModel(runtime);
  logger.debug(`[TEXT_EMBEDDING] Using model: ${embeddingModelName}`);

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
    if (embedding.length === 0) {
      throw new Error("Google GenAI API returned no embedding");
    }

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
    throw error instanceof Error ? error : new Error(String(error));
  }
}
