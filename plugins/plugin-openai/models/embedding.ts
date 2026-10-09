/**
 * Calls a configured embeddings endpoint and validates its returned dimension.
 * Text-only providers must configure a real embedding endpoint explicitly.
 */
import type { IAgentRuntime, TextEmbeddingParams } from "@elizaos/core";
import { ElizaError, logger, ModelType, toWellFormedUnicode, VECTOR_DIMS } from "@elizaos/core";

import type { OpenAIEmbeddingResponse } from "../types";
import {
  getAuthHeader,
  getEmbeddingBaseURL,
  getEmbeddingDimensions,
  getEmbeddingModel,
  getSetting,
  isCerebrasMode,
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
  const key = "OPENAI_EMBEDDING_URL";
  const value = getSetting(runtime, key);
  return typeof value === "string" && value.trim().length > 0;
}

function hasExplicitEmbeddingDimensions(runtime: IAgentRuntime): boolean {
  const value = getSetting(runtime, "OPENAI_EMBEDDING_DIMENSIONS");
  return typeof value === "string" && value.trim().length > 0;
}

const TEXT_EMBEDDING_TIMEOUT_MS = 30_000;

export async function handleTextEmbedding(
  runtime: IAgentRuntime,
  params: TextEmbeddingParams | string | null
): Promise<number[]> {
  const embeddingModel = getEmbeddingModel(runtime);
  const embeddingDimension = validateDimension(getEmbeddingDimensions(runtime));
  const callerSignal = extractSignal(params);

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

  // Wire-boundary guarantee: lone surrogates in the JSON body 400 on strict
  // provider parsers (#18025).
  trimmedText = toWellFormedUnicode(trimmedText);

  if (isCerebrasMode(runtime) && !hasExplicitEmbeddingEndpoint(runtime)) {
    throw new ElizaError(
      "Cerebras does not provide embeddings. Configure OPENAI_EMBEDDING_URL or select a real embedding provider.",
      { code: "EMBEDDING_PROVIDER_UNAVAILABLE" }
    );
  }

  const baseURL = getEmbeddingBaseURL(runtime);
  const url = `${baseURL}/embeddings`;
  const timeoutSignal = AbortSignal.timeout(TEXT_EMBEDDING_TIMEOUT_MS);
  const signal = callerSignal ? AbortSignal.any([callerSignal, timeoutSignal]) : timeoutSignal;

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
    signal,
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
