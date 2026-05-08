import type { IAgentRuntime, TextEmbeddingParams } from "@elizaos/core";
import { logger, ModelType, VECTOR_DIMS } from "@elizaos/core";

import type { OpenAIEmbeddingResponse } from "../types";
import {
  getAuthHeader,
  getEmbeddingBaseURL,
  getEmbeddingDimensions,
  getEmbeddingModel,
  getSetting,
  isBrowser,
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

function hasExplicitEmbeddingEndpoint(runtime: IAgentRuntime): boolean {
  const key = isBrowser() ? "OPENAI_BROWSER_EMBEDDING_URL" : "OPENAI_EMBEDDING_URL";
  const value = getSetting(runtime, key);
  return typeof value === "string" && value.trim().length > 0;
}

function shouldUseLocalEmbeddingFallback(runtime: IAgentRuntime): boolean {
  return isCerebrasMode(runtime) && !hasExplicitEmbeddingEndpoint(runtime);
}

function hashFeature(feature: string): number {
  let hash = 2166136261;
  for (let i = 0; i < feature.length; i += 1) {
    hash ^= feature.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function createDeterministicEmbedding(text: string, dimension: VectorDimension): number[] {
  const vector = new Array(dimension).fill(0);
  const normalized = text.toLowerCase();
  const tokens = normalized.match(/[a-z0-9]+(?:[_-][a-z0-9]+)*/g) ?? [normalized];

  const addFeature = (feature: string, weight: number): void => {
    const hash = hashFeature(feature);
    const idx = hash % dimension;
    const sign = (hash & 1) === 0 ? 1 : -1;
    vector[idx] += sign * weight;

    const secondHash = hashFeature(`b:${feature}`);
    const secondIdx = secondHash % dimension;
    const secondSign = (secondHash & 1) === 0 ? 1 : -1;
    vector[secondIdx] += secondSign * weight * 0.5;
  };

  tokens.forEach((token, index) => {
    addFeature(token, 1);
    if (index > 0) {
      addFeature(`${tokens[index - 1]} ${token}`, 0.35);
    }
  });
  addFeature(normalized.slice(0, 512), 0.15);

  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (norm === 0) {
    vector[0] = 1;
    return vector;
  }
  return vector.map((value) => value / norm);
}

export async function handleTextEmbedding(
  runtime: IAgentRuntime,
  params: TextEmbeddingParams | string | null
): Promise<number[]> {
  const embeddingModel = getEmbeddingModel(runtime);
  const embeddingDimension = validateDimension(getEmbeddingDimensions(runtime));

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
    trimmedText = trimmedText.slice(0, maxChars);
  }

  if (shouldUseLocalEmbeddingFallback(runtime)) {
    logger.debug("[OpenAI] Using deterministic local embedding fallback for Cerebras mode");
    return createDeterministicEmbedding(trimmedText, embeddingDimension);
  }

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
    }),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "Unknown error");
    throw new Error(
      `OpenAI embedding API error: ${response.status} ${response.statusText} - ${errorText}`
    );
  }

  const data = (await response.json()) as OpenAIEmbeddingResponse;

  const firstResult = data?.data?.[0];
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
    emitModelUsageEvent(runtime, ModelType.TEXT_EMBEDDING, trimmedText, {
      promptTokens: data.usage.prompt_tokens,
      completionTokens: 0,
      totalTokens: data.usage.total_tokens,
    });
  }

  logger.debug(`[OpenAI] Generated embedding with ${embedding.length} dimensions`);
  return embedding;
}
