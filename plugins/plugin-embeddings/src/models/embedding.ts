/**
 * TEXT_EMBEDDING and TEXT_EMBEDDING_BATCH handlers: POST to an OpenAI-compatible
 * `${EMBEDDING_BASE_URL}/embeddings` with raw fetch (no @ai-sdk), optionally
 * retry one configured fallback endpoint, validate the returned vector width
 * against the configured VECTOR_DIMS dimension, and emit a MODEL_USED event.
 * Input is capped at MAX_EMBEDDING_CHARS. Registered by the plugin in
 * ../index.ts; see the package CLAUDE.md for the routing priority.
 */
import type { IAgentRuntime, TextEmbeddingParams } from "@elizaos/core";
import { logger, ModelType, VECTOR_DIMS } from "@elizaos/core";

import {
  getEmbeddingApiKey,
  getEmbeddingBaseURL,
  getEmbeddingDimensions,
  getEmbeddingFallbackApiKey,
  getEmbeddingFallbackBaseURL,
  getEmbeddingFallbackModel,
  getEmbeddingModel,
  getEndpointAuthHeader,
  getSetting,
} from "../utils/config";
import { emitModelUsageEvent } from "../utils/events";

type VectorDimension = (typeof VECTOR_DIMS)[keyof typeof VECTOR_DIMS];
type EmbeddingEndpoint = {
  role: "primary" | "fallback";
  baseURL: string;
  apiKey: string | undefined;
  model: string;
};

// OpenAI embedding models support up to 8191 tokens per input; 8000 provides a
// safe buffer at the conventional ~4 chars/token estimate.
const MAX_EMBEDDING_CHARS = 8_000 * 4;

export function validateEmbeddingDimension(dimension: number): VectorDimension {
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

function getEmbeddingEndpoints(runtime: IAgentRuntime): EmbeddingEndpoint[] {
  const primary: EmbeddingEndpoint = {
    role: "primary",
    baseURL: requireBaseURL(runtime),
    apiKey: getEmbeddingApiKey(runtime),
    model: getEmbeddingModel(runtime),
  };
  const fallbackBaseURL = getEmbeddingFallbackBaseURL(runtime);
  if (!fallbackBaseURL) {
    return [primary];
  }
  return [
    primary,
    {
      role: "fallback",
      baseURL: fallbackBaseURL.replace(/\/+$/, ""),
      apiKey: getEmbeddingFallbackApiKey(runtime),
      model: getEmbeddingFallbackModel(runtime),
    },
  ];
}

function truncate(text: string): string {
  if (text.length <= MAX_EMBEDDING_CHARS) {
    return text;
  }
  logger.warn(
    `[Embeddings] Input too long (~${Math.ceil(text.length / 4)} tokens), truncating to ~8000 tokens`
  );
  // Never cut between the halves of a surrogate pair: a trailing lone high
  // surrogate is not valid Unicode, so it reaches the endpoint as U+FFFD (or a
  // hard reject on strict JSON parsers) and corrupts the embedded text.
  const lastKept = text.charCodeAt(MAX_EMBEDDING_CHARS - 1);
  const end =
    lastKept >= 0xd800 && lastKept <= 0xdbff ? MAX_EMBEDDING_CHARS - 1 : MAX_EMBEDDING_CHARS;
  return text.slice(0, end);
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
  embeddingDimension: VectorDimension,
  signal?: AbortSignal
): Promise<number[][]> {
  const endpoints = getEmbeddingEndpoints(runtime);
  const expectedCount = Array.isArray(input) ? input.length : 1;
  const failures: string[] = [];

  for (const endpoint of endpoints) {
    try {
      return await requestEmbeddingsFromEndpoint(
        runtime,
        endpoint,
        input,
        embeddingDimension,
        expectedCount,
        signal
      );
    } catch (error) {
      if (signal?.aborted) {
        throw error;
      }
      failures.push(`${endpoint.role} ${endpoint.baseURL}: ${formatFailure(error)}`);
      if (endpoint.role === "primary" && endpoints.length > 1) {
        logger.warn(
          { error },
          "[Embeddings] Primary embedding endpoint failed; retrying fallback endpoint"
        );
        continue;
      }
      const label = endpoints.length > 1 ? "Embedding endpoints failed" : "Embedding API error";
      throw new Error(`${label}: ${failures.join(" | ")}`, { cause: error });
    }
  }

  throw new Error(`Embedding endpoints failed: ${failures.join(" | ")}`);
}

function formatFailure(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function requestEmbeddingsFromEndpoint(
  runtime: IAgentRuntime,
  endpoint: EmbeddingEndpoint,
  input: string | string[],
  embeddingDimension: VectorDimension,
  expectedCount: number,
  signal?: AbortSignal
): Promise<number[][]> {
  const url = `${endpoint.baseURL}/embeddings`;

  logger.debug(`[Embeddings] POST ${url} model=${endpoint.model} role=${endpoint.role}`);

  // @trajectory-allow Embeddings return numeric retrieval vectors, not generative LLM text.
  const response = await fetch(url, {
    method: "POST",
    headers: {
      ...getEndpointAuthHeader(runtime, endpoint.apiKey),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: endpoint.model,
      input,
      ...(hasExplicitDimensions(runtime) ? { dimensions: embeddingDimension } : {}),
    }),
    ...(signal ? { signal } : {}),
  });

  if (!response.ok) {
    let errorText: string;
    try {
      errorText = await response.text();
    } catch (cause) {
      // error-policy:J2 preserve both the HTTP failure and the body-read cause.
      throw new Error(
        `${endpoint.role} embedding API HTTP ${response.status} ${response.statusText}; error body could not be read`,
        { cause }
      );
    }
    throw new Error(
      `${endpoint.role} embedding API HTTP ${response.status} ${response.statusText} - ${errorText}`
    );
  }

  const data: unknown = await response.json();

  if (!isRecord(data) || !Array.isArray(data.data) || data.data.length !== expectedCount) {
    throw new Error(
      `${endpoint.role} embedding API returned ${
        isRecord(data) && Array.isArray(data.data) ? data.data.length : "non-array"
      } vectors, expected ${expectedCount}`
    );
  }

  // The response `index` field addresses the input order; honor it so a
  // reordered response still maps back to the right input slot.
  const vectors: number[][] = new Array(expectedCount);
  for (const item of data.data) {
    if (!isRecord(item)) {
      throw new Error(`${endpoint.role} embedding API returned a non-object vector entry`);
    }
    const idx = typeof item.index === "number" ? item.index : undefined;
    if (idx === undefined || !Number.isInteger(idx) || idx < 0 || idx >= expectedCount) {
      throw new Error(
        `${endpoint.role} embedding API returned out-of-range index ${String(
          item.index
        )} (expected 0..${expectedCount - 1})`
      );
    }
    // A repeated index passes the count check above yet leaves another slot as
    // a hole, which the batch path would otherwise silently return (Commandment
    // 8: throw, never hand back a fabricated/undefined vector).
    if (vectors[idx] !== undefined) {
      throw new Error(
        `${endpoint.role} embedding API returned duplicate index ${idx}; a vector slot would be left unfilled`
      );
    }
    if (!Array.isArray(item.embedding) || item.embedding.length !== embeddingDimension) {
      throw new Error(
        `${endpoint.role} embedding dimension mismatch: got ${
          Array.isArray(item.embedding) ? item.embedding.length : "non-array"
        }, expected ${embeddingDimension}. Check EMBEDDING_DIMENSIONS / EMBEDDING_MODEL.`
      );
    }
    const validatedEmbedding: number[] = [];
    for (const [offset, value] of item.embedding.entries()) {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new Error(
          `${endpoint.role} embedding API returned a non-finite numeric value at vector ${idx}, offset ${offset}`
        );
      }
      validatedEmbedding.push(value);
    }
    vectors[idx] = validatedEmbedding;
  }

  if (data.usage !== undefined) {
    if (
      !isRecord(data.usage) ||
      !isNonNegativeInteger(data.usage.prompt_tokens) ||
      !isNonNegativeInteger(data.usage.total_tokens)
    ) {
      throw new Error(`${endpoint.role} embedding API returned invalid token usage telemetry`);
    }
    const promptText = Array.isArray(input) ? `batch:${input.length}` : input;
    emitModelUsageEvent(runtime, ModelType.TEXT_EMBEDDING, promptText, {
      promptTokens: data.usage.prompt_tokens,
      completionTokens: 0,
      totalTokens: data.usage.total_tokens,
    });
  }

  return vectors;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/**
 * `TEXT_EMBEDDING` handler. Returns one vector for the given text.
 *
 * Output width is declared through model registration metadata, so every
 * successful call returns an embedding produced by the configured provider.
 */
export async function handleTextEmbedding(
  runtime: IAgentRuntime,
  params: TextEmbeddingParams | string | null
): Promise<number[]> {
  const embeddingDimension = validateEmbeddingDimension(getEmbeddingDimensions(runtime));
  const signal = extractSignal(params);

  const text = extractText(params);
  if (text === null) {
    throw new Error(
      "TEXT_EMBEDDING requires real input; output width is declared in model registration metadata"
    );
  }

  const trimmed = text.trim();
  if (trimmed.length === 0) {
    throw new Error("Cannot generate embedding for empty text");
  }

  const vectors = await requestEmbeddings(runtime, truncate(trimmed), embeddingDimension, signal);
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

  const embeddingDimension = validateEmbeddingDimension(getEmbeddingDimensions(runtime));

  const prepared = texts.map((text, i) => {
    if (typeof text !== "string" || text.trim().length === 0) {
      throw new Error(`Cannot generate embedding for empty text at index ${i}`);
    }
    return truncate(text.trim());
  });

  return requestEmbeddings(runtime, prepared, embeddingDimension);
}
