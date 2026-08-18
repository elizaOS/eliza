/**
 * `handleTextEmbedding`: calls the OpenAI embeddings endpoint and validates the
 * returned vector against the canonical BGE-small/384/CLS/L2 contract.
 */
import type { IAgentRuntime, TextEmbeddingParams } from "@elizaos/core";
import {
  assertCanonicalEmbeddingConfig,
  CANONICAL_EMBEDDING_POOLING,
  CANONICAL_EMBEDDING_SPACE_FINGERPRINT,
  logger,
  ModelType,
  normalizeCanonicalEmbedding,
  prepareCanonicalEmbeddingInput,
} from "@elizaos/core";

import type { OpenAIEmbeddingResponse } from "../types";
import {
  allowUnsafeUnattestedOpenAIEmbeddingResponse,
  getAuthHeader,
  getEmbeddingBaseURL,
  getEmbeddingDimensions,
  getEmbeddingModel,
  getSetting,
  isBrowser,
} from "../utils/config";
import { emitModelUsageEvent } from "../utils/events";

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
  const embeddingDimension = getEmbeddingDimensions(runtime);
  assertCanonicalEmbeddingConfig(embeddingModel, embeddingDimension, CANONICAL_EMBEDDING_POOLING);
  const signal = extractSignal(params);

  const text = extractText(params);
  if (text === null) {
    logger.debug("[OpenAI] Creating test embedding for initialization");
    const testVector = new Array(embeddingDimension).fill(0);
    testVector[0] = 0.1;
    return testVector;
  }

  const preparedText = prepareCanonicalEmbeddingInput(text);

  if (!hasExplicitEmbeddingEndpoint(runtime)) {
    throw new Error(
      "OPENAI_EMBEDDING_URL is required for canonical BGE-small embeddings (use OPENAI_BROWSER_EMBEDDING_URL in browser builds). Chat-provider endpoints and synthetic fallbacks are not embedding-compatible."
    );
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
      input: preparedText,
      pooling: CANONICAL_EMBEDDING_POOLING,
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

  if (data.model !== embeddingModel) {
    throw new Error(
      `Embedding model mismatch: endpoint returned ${JSON.stringify(data.model)}, expected ${JSON.stringify(embeddingModel)}`
    );
  }
  if (data.pooling !== undefined && data.pooling !== CANONICAL_EMBEDDING_POOLING) {
    throw new Error(
      `Embedding pooling mismatch: endpoint returned ${JSON.stringify(data.pooling)}, expected ${JSON.stringify(CANONICAL_EMBEDDING_POOLING)}`
    );
  }
  if (
    data.embedding_space_fingerprint !== undefined &&
    data.embedding_space_fingerprint !== CANONICAL_EMBEDDING_SPACE_FINGERPRINT
  ) {
    throw new Error(
      `Embedding space mismatch: endpoint returned ${JSON.stringify(data.embedding_space_fingerprint)}, expected ${JSON.stringify(CANONICAL_EMBEDDING_SPACE_FINGERPRINT)}`
    );
  }
  if (
    !allowUnsafeUnattestedOpenAIEmbeddingResponse(runtime) &&
    (data.pooling !== CANONICAL_EMBEDDING_POOLING ||
      data.embedding_space_fingerprint !== CANONICAL_EMBEDDING_SPACE_FINGERPRINT)
  ) {
    throw new Error(
      `Embedding response is unattested: exact pooling=${JSON.stringify(CANONICAL_EMBEDDING_POOLING)} and embedding_space_fingerprint=${JSON.stringify(CANONICAL_EMBEDDING_SPACE_FINGERPRINT)} are required`
    );
  }

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
      preparedText,
      {
        promptTokens: data.usage.prompt_tokens,
        completionTokens: 0,
        totalTokens: data.usage.total_tokens,
      },
      embeddingModel
    );
  }

  logger.debug(`[OpenAI] Generated embedding with ${embedding.length} dimensions`);
  return normalizeCanonicalEmbedding(embedding);
}
