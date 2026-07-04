/**
 * TEXT_EMBEDDING and TEXT_EMBEDDING_BATCH handlers: POST to an OpenAI-compatible
 * `${EMBEDDING_BASE_URL}/embeddings` with raw fetch (no @ai-sdk), validate the
 * returned vector width against the configured VECTOR_DIMS dimension, and emit a
 * MODEL_USED event. Input is capped at MAX_EMBEDDING_CHARS. Registered by the
 * plugin in ../index.ts; see the package CLAUDE.md for the routing priority.
 */
import type { IAgentRuntime, TextEmbeddingParams } from "@elizaos/core";
import { logger, ModelType, VECTOR_DIMS } from "@elizaos/core";

import type { EmbeddingResponse } from "../types";
import {
  getAuthHeader,
  getEmbeddingBaseURL,
  getEmbeddingDimensions,
  getEmbeddingModel,
  getSetting,
} from "../utils/config";
import { emitModelUsageEvent } from "../utils/events";

type VectorDimension = (typeof VECTOR_DIMS)[keyof typeof VECTOR_DIMS];

// OpenAI embedding models support up to 8191 tokens per input; 8000 provides a
// safe buffer at the conventional ~4 chars/token estimate.
const MAX_EMBEDDING_CHARS = 8_000 * 4;

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

/**
 * True only when the operator set `EMBEDDING_DIMENSIONS` explicitly. When unset
 * we omit the `dimensions` request field entirely so the endpoint returns its
 * model-native width (some servers reject an unsupported `dimensions` value).
 */
function hasExplicitDimensions(runtime: IAgentRuntime): boolean {
  const value = getSetting(runtime, "EMBEDDING_DIMENSIONS");
  return typeof value === "string" && value.trim().length > 0;
}

function requireBaseURL(runtime: IAgentRuntime): string {
  const baseURL = getEmbeddingBaseURL(runtime);
  if (!baseURL) {
    // No silent default endpoint. Without a configured URL we cannot produce a
    // real vector — throw so the runtime falls through to another provider
    // instead of persisting a wrong/garbage vector (Commandment 8).
    throw new Error(
      "No embedding endpoint configured. Set EMBEDDING_BASE_URL " +
        "(or EMBEDDING_BROWSER_URL in a browser build)."
    );
  }
  return baseURL.replace(/\/+$/, "");
}

function truncate(text: string): string {
  if (text.length <= MAX_EMBEDDING_CHARS) {
    return text;
  }
  logger.warn(
    `[Embeddings] Input too long (~${Math.ceil(text.length / 4)} tokens), truncating to ~8000 tokens`
  );
  return text.slice(0, MAX_EMBEDDING_CHARS);
}

/**
 * Embed `input` (a single string or an array of strings) against the configured
 * OpenAI-compatible `/embeddings` endpoint. Returns one numeric vector per
 * input, in input order. Throws on any HTTP/config/shape error — never returns
 * a zero or fabricated vector (issue #9324, Commandment 8).
 */
async function requestEmbeddings(
  runtime: IAgentRuntime,
  input: string | string[],
  embeddingDimension: VectorDimension
): Promise<number[][]> {
  const baseURL = requireBaseURL(runtime);
  const embeddingModel = getEmbeddingModel(runtime);
  const url = `${baseURL}/embeddings`;
  const expectedCount = Array.isArray(input) ? input.length : 1;

  logger.debug(`[Embeddings] POST ${url} model=${embeddingModel}`);

  // @trajectory-allow Embeddings return numeric retrieval vectors, not generative LLM text.
  const response = await fetch(url, {
    method: "POST",
    headers: {
      ...getAuthHeader(runtime),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: embeddingModel,
      input,
      ...(hasExplicitDimensions(runtime) ? { dimensions: embeddingDimension } : {}),
    }),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "Unknown error");
    throw new Error(
      `Embedding API error: ${response.status} ${response.statusText} - ${errorText}`
    );
  }

  const data = (await response.json()) as EmbeddingResponse;

  if (!Array.isArray(data.data) || data.data.length !== expectedCount) {
    throw new Error(
      `Embedding API returned ${
        Array.isArray(data.data) ? data.data.length : "non-array"
      } vectors, expected ${expectedCount}`
    );
  }

  // The response `index` field addresses the input order; honor it so a
  // reordered response still maps back to the right input slot.
  const vectors: number[][] = new Array(expectedCount);
  for (const item of data.data) {
    const idx = typeof item.index === "number" ? item.index : undefined;
    if (idx === undefined || idx < 0 || idx >= expectedCount) {
      throw new Error(
        `Embedding API returned out-of-range index ${String(item.index)} (expected 0..${expectedCount - 1})`
      );
    }
    if (!Array.isArray(item.embedding) || item.embedding.length !== embeddingDimension) {
      throw new Error(
        `Embedding dimension mismatch: got ${
          Array.isArray(item.embedding) ? item.embedding.length : "non-array"
        }, expected ${embeddingDimension}. Check EMBEDDING_DIMENSIONS / EMBEDDING_MODEL.`
      );
    }
    vectors[idx] = item.embedding;
  }

  if (data.usage) {
    const promptText = Array.isArray(input) ? `batch:${input.length}` : input;
    emitModelUsageEvent(runtime, ModelType.TEXT_EMBEDDING, promptText, {
      promptTokens: data.usage.prompt_tokens,
      completionTokens: 0,
      totalTokens: data.usage.total_tokens,
    });
  }

  return vectors;
}

/**
 * `TEXT_EMBEDDING` handler. Returns one vector for the given text.
 *
 * The runtime boot dimension-probe calls this with `null` purely to learn the
 * vector length (it reads `.length`), so a correctly-sized marker vector is the
 * only legitimate synthetic return — every real failure throws.
 */
export async function handleTextEmbedding(
  runtime: IAgentRuntime,
  params: TextEmbeddingParams | string | null
): Promise<number[]> {
  const embeddingDimension = validateDimension(getEmbeddingDimensions(runtime));

  const text = extractText(params);
  if (text === null) {
    logger.debug("[Embeddings] Returning init-probe vector");
    const probe = new Array(embeddingDimension).fill(0);
    probe[0] = 0.1;
    return probe;
  }

  const trimmed = text.trim();
  if (trimmed.length === 0) {
    throw new Error("Cannot generate embedding for empty text");
  }

  const vectors = await requestEmbeddings(runtime, truncate(trimmed), embeddingDimension);
  const vector = vectors[0];
  if (!vector) {
    throw new Error("Embedding provider returned no vector for the input");
  }
  return vector;
}

/**
 * `TEXT_EMBEDDING_BATCH` handler. Embeds many texts in one request. Demands a
 * vector per input (no holes); throws on any failure so the runtime can fall
 * through to another provider instead of persisting corrupt vectors.
 */
export async function handleBatchTextEmbedding(
  runtime: IAgentRuntime,
  texts: string[]
): Promise<number[][]> {
  if (!Array.isArray(texts) || texts.length === 0) {
    return [];
  }

  const embeddingDimension = validateDimension(getEmbeddingDimensions(runtime));

  const prepared = texts.map((text, i) => {
    if (typeof text !== "string" || text.trim().length === 0) {
      throw new Error(`Cannot generate embedding for empty text at index ${i}`);
    }
    return truncate(text.trim());
  });

  return requestEmbeddings(runtime, prepared, embeddingDimension);
}
