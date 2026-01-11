/**
 * Text embedding model handler
 *
 * Generates embeddings for text using OpenAI's embedding models.
 */

import type { IAgentRuntime, TextEmbeddingParams } from "@elizaos/core";
import { logger, ModelType, VECTOR_DIMS } from "@elizaos/core";
import type { OpenAIEmbeddingResponse } from "../types";
import {
  getAuthHeader,
  getEmbeddingBaseURL,
  getEmbeddingDimensions,
  getEmbeddingModel,
} from "../utils/config";
import { emitModelUsageEvent } from "../utils/events";

// ============================================================================
// Types
// ============================================================================

/**
 * Valid vector dimensions from core
 */
type VectorDimension = (typeof VECTOR_DIMS)[keyof typeof VECTOR_DIMS];

// ============================================================================
// Validation
// ============================================================================

/**
 * Validates embedding dimension against allowed values.
 */
function validateDimension(dimension: number): VectorDimension {
  const validDimensions = Object.values(VECTOR_DIMS) as number[];
  if (!validDimensions.includes(dimension)) {
    throw new Error(
      `Invalid embedding dimension: ${dimension}. Must be one of: ${validDimensions.join(", ")}`
    );
  }
  return dimension as VectorDimension;
}

/**
 * Extracts text from embedding params.
 */
function extractText(params: TextEmbeddingParams | string | null): string | null {
  if (params === null) {
    return null;
  }

  if (typeof params === "string") {
    return params;
  }

  if (typeof params === "object" && typeof params.text === "string") {
    return params.text;
  }

  throw new Error("Invalid embedding params: expected string, { text: string }, or null");
}

// ============================================================================
// Public Functions
// ============================================================================

/**
 * Generates text embeddings using OpenAI's embedding API.
 *
 * @param runtime - The agent runtime
 * @param params - Embedding parameters or raw text
 * @returns Array of embedding values
 * @throws Error if API call fails or returns invalid data
 */
export async function handleTextEmbedding(
  runtime: IAgentRuntime,
  params: TextEmbeddingParams | string | null
): Promise<number[]> {
  const embeddingModel = getEmbeddingModel(runtime);
  const embeddingDimension = validateDimension(getEmbeddingDimensions(runtime));

  // Handle null case - return test vector for initialization
  const text = extractText(params);
  if (text === null) {
    logger.debug("[OpenAI] Creating test embedding for initialization");
    const testVector = new Array(embeddingDimension).fill(0);
    testVector[0] = 0.1;
    return testVector;
  }

  // Validate non-empty text
  const trimmedText = text.trim();
  if (trimmedText.length === 0) {
    throw new Error("Cannot generate embedding for empty text");
  }

  const baseURL = getEmbeddingBaseURL(runtime);
  const url = `${baseURL}/embeddings`;

  logger.debug(`[OpenAI] Generating embedding with model: ${embeddingModel}`);

  const response = await fetch(url, {
    method: "POST",
    headers: {
      ...getAuthHeader(runtime, true),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: embeddingModel,
      input: trimmedText,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "Unknown error");
    throw new Error(
      `OpenAI embedding API error: ${response.status} ${response.statusText} - ${errorText}`
    );
  }

  const data = (await response.json()) as OpenAIEmbeddingResponse;

  // Validate response structure
  const firstResult = data?.data?.[0];
  if (!firstResult || !firstResult.embedding) {
    throw new Error("OpenAI API returned invalid embedding response structure");
  }

  const embedding = firstResult.embedding;

  // Validate embedding dimensions
  if (embedding.length !== embeddingDimension) {
    throw new Error(
      `Embedding dimension mismatch: got ${embedding.length}, expected ${embeddingDimension}. ` +
        `Check OPENAI_EMBEDDING_DIMENSIONS setting.`
    );
  }

  // Emit usage event if usage data is available
  if (data.usage) {
    emitModelUsageEvent(runtime, ModelType.TEXT_EMBEDDING, trimmedText, {
      promptTokens: data.usage.prompt_tokens,
      completionTokens: 0,
      totalTokens: data.usage.total_tokens,
    });
  }

  logger.debug(`[OpenAI] Generated embedding with ${embedding.length} dimensions`);
  return embedding;
}
