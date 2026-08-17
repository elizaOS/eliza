/**
 * `handleTextEmbedding`: calls the OpenAI embeddings endpoint and validates the
 * returned vector dimension against the canonical gte-small/384 contract.
 * Cerebras serves no embeddings, so a Cerebras text configuration without an
 * explicit embedding endpoint fails closed and lets the runtime select the
 * local gte-small provider. It never fabricates hash vectors.
 */
import type { IAgentRuntime, TextEmbeddingParams } from "@elizaos/core";
import {
  assertCanonicalEmbeddingConfig,
  logger,
  ModelType,
  toWellFormedUnicode,
  truncateWellFormed,
  VECTOR_DIMS,
} from "@elizaos/core";

import type { OpenAIEmbeddingResponse } from "../types";
import {
  getAuthHeader,
  getEmbeddingBaseURL,
  getEmbeddingDimensions,
  getEmbeddingModel,
  getSetting,
  isBrowser,
} from "../utils/config";
import { emitModelUsageEvent } from "../utils/events";

type VectorDimension = (typeof VECTOR_DIMS)[keyof typeof VECTOR_DIMS];

function validateDimension(dimension: number): VectorDimension {
  const validDimensions = Object.values(VECTOR_DIMS) as number[];
  if (!validDimensions.includes(dimension)) {
    throw new Error(
      `Invalid embedding dimension: ${dimension}. Must be one of: ${validDimensions.join(", ")}`
    );
  }
  return dimension as VectorDimension;
}

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

function extractSignal(params: TextEmbeddingParams | string | null): AbortSignal | undefined {
  return typeof params === "object" && params !== null ? params.signal : undefined;
}

function hasExplicitEmbeddingEndpoint(runtime: IAgentRuntime): boolean {
  const key = isBrowser() ? "OPENAI_BROWSER_EMBEDDING_URL" : "OPENAI_EMBEDDING_URL";
  const value = getSetting(runtime, key);
  return typeof value === "string" && value.trim().length > 0;
}

function hasExplicitEmbeddingDimensions(runtime: IAgentRuntime): boolean {
  const value = getSetting(runtime, "OPENAI_EMBEDDING_DIMENSIONS");
  return typeof value === "string" && value.trim().length > 0;
}

export async function handleTextEmbedding(
  runtime: IAgentRuntime,
  params: TextEmbeddingParams | string | null
): Promise<number[]> {
  const embeddingModel = getEmbeddingModel(runtime);
  const embeddingDimension = validateDimension(getEmbeddingDimensions(runtime));
  assertCanonicalEmbeddingConfig(embeddingModel, embeddingDimension, "OPENAI_EMBEDDING_*");
  if (!hasExplicitEmbeddingEndpoint(runtime)) {
    throw new Error(
      "OPENAI_EMBEDDING_URL is required for canonical gte-small embeddings. " +
        "Cerebras/OpenAI text credentials are not embedding providers; configure the local or sidecar endpoint."
    );
  }
  const signal = extractSignal(params);

  const text = extractText(params);
  if (text === null) {
    logger.debug("[OpenAI] Creating test embedding for initialization");
    const testVector = new Array(embeddingDimension).fill(0);
    testVector[0] = 0.1;
    return testVector;
  }

  let trimmedText = text.trim();
  if (trimmedText.length === 0) {
    throw new Error("Cannot generate embedding for empty text");
  }

  // Truncate to stay within embedding model token limits.
  // OpenAI embedding models support up to 8191 tokens per input;
  // 8000 tokens provides a safe buffer (~4 chars per token).
  const maxChars = 8_000 * 4;
  if (trimmedText.length > maxChars) {
    logger.warn(
      `[OpenAI] Embedding input too long (~${Math.ceil(trimmedText.length / 4)} tokens), truncating to ~8000 tokens`
    );
    trimmedText = truncateWellFormed(trimmedText, maxChars);
  }
  // Wire-boundary guarantee: lone surrogates in the JSON body 400 on strict
  // provider parsers (#18025).
  trimmedText = toWellFormedUnicode(trimmedText);

  const baseURL = getEmbeddingBaseURL(runtime);
  const url = `${baseURL}/embeddings`;

  logger.debug(`[OpenAI] Generating embedding with model: ${embeddingModel}`);

  // @trajectory-allow Embeddings return numeric retrieval vectors, not generative LLM text.
  const response = await fetch(url, {
    method: "POST",
    headers: {
      ...getAuthHeader(runtime, true),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: embeddingModel,
      input: trimmedText,
      ...(hasExplicitEmbeddingDimensions(runtime) ? { dimensions: embeddingDimension } : {}),
    }),
    ...(signal ? { signal } : {}),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "Unknown error");
    throw new Error(
      `OpenAI embedding API error: ${response.status} ${response.statusText} - ${errorText}`
    );
  }

  const data = (await response.json()) as OpenAIEmbeddingResponse;

  const firstResult = Array.isArray(data.data) ? data.data[0] : undefined;
  if (!firstResult?.embedding) {
    throw new Error("OpenAI API returned invalid embedding response structure");
  }

  const embedding = firstResult.embedding;

  if (embedding.length !== embeddingDimension) {
    throw new Error(
      `Embedding dimension mismatch: got ${embedding.length}, expected ${embeddingDimension}. ` +
        `Check OPENAI_EMBEDDING_DIMENSIONS setting.`
    );
  }

  if (data.usage) {
    emitModelUsageEvent(
      runtime,
      ModelType.TEXT_EMBEDDING,
      trimmedText,
      {
        promptTokens: data.usage.prompt_tokens,
        completionTokens: 0,
        totalTokens: data.usage.total_tokens,
      },
      embeddingModel
    );
  }

  logger.debug(`[OpenAI] Generated embedding with ${embedding.length} dimensions`);
  return embedding;
}
