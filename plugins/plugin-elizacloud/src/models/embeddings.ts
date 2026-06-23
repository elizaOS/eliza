import type { IAgentRuntime, TextEmbeddingParams } from "@elizaos/core";
import {
  logger,
  ModelType,
  timeInferenceSpan,
  VECTOR_DIMS,
} from "@elizaos/core";
import { getSetting } from "../utils/config";
import { emitModelUsageEvent } from "../utils/events";
import { createCloudApiClient } from "../utils/sdk-client";

const MAX_BATCH_SIZE = 100;

// ── Bounded retry/backoff for the /embeddings round-trip ──────────────────
// Embeddings are off the turn's critical path (queueEmbeddingGeneration is
// fire-and-forget), so a stall here delays the embedding QUEUE, not a reply.
// The old behaviour — one blind 30s (or full retry-after) sleep then a single
// retry — could park the queue for 30s+ on a transient 429. Replaced with
// bounded exponential backoff + jitter, a CAP on any single wait (so a large
// server retry-after can't stall the queue indefinitely), and a per-request
// client-side timeout (the endpoint had none, so a hung gateway hung the
// queue forever).
//
// Handler retries are deliberately SMALL: the EmbeddingGenerationService
// BatchQueue already wraps generateEmbedding in its own multi-attempt backoff,
// so this layer absorbs only a single transient burst (one quick retry) and
// defers sustained pressure to the queue — otherwise the two backoffs compound.
const EMBED_MAX_ATTEMPTS = 2;
const EMBED_BACKOFF_BASE_MS = 1_000;
export const EMBED_BACKOFF_CAP_MS = 8_000;
const EMBED_REQUEST_TIMEOUT_MS = 60_000;

/**
 * Backoff before the next embedding attempt. Exponential (base·2^attempt) as a
 * floor, honoring the server's `retry-after` when present, but never longer
 * than {@link EMBED_BACKOFF_CAP_MS}; ±25% jitter spreads retries from a burst.
 */
export function embeddingBackoffMs(attempt: number, retryAfterSec?: number): number {
  const exp = EMBED_BACKOFF_BASE_MS * 2 ** attempt;
  const serverHint =
    typeof retryAfterSec === "number" && retryAfterSec > 0
      ? retryAfterSec * 1000
      : 0;
  const base = Math.min(EMBED_BACKOFF_CAP_MS, Math.max(exp, serverHint));
  return Math.round(base * (1 + Math.random() * 0.25));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractRateLimitInfo(response: Response): {
  remainingRequests?: number;
  remainingTokens?: number;
  limitRequests?: number;
  limitTokens?: number;
  resetRequests?: string;
  resetTokens?: string;
  retryAfter?: number;
} {
  return {
    remainingRequests:
      parseInt(response.headers.get("x-ratelimit-remaining-requests") || "", 10) || undefined,
    remainingTokens:
      parseInt(response.headers.get("x-ratelimit-remaining-tokens") || "", 10) || undefined,
    limitRequests:
      parseInt(response.headers.get("x-ratelimit-limit-requests") || "", 10) || undefined,
    limitTokens: parseInt(response.headers.get("x-ratelimit-limit-tokens") || "", 10) || undefined,
    resetRequests: response.headers.get("x-ratelimit-reset-requests") || undefined,
    resetTokens: response.headers.get("x-ratelimit-reset-tokens") || undefined,
    retryAfter: parseInt(response.headers.get("retry-after") || "", 10) || undefined,
  };
}

function getEmbeddingConfig(runtime: IAgentRuntime) {
  const embeddingModelName = getSetting(
    runtime,
    "ELIZAOS_CLOUD_EMBEDDING_MODEL",
    "text-embedding-3-small"
  );
  const embeddingDimension = Number.parseInt(
    getSetting(runtime, "ELIZAOS_CLOUD_EMBEDDING_DIMENSIONS", "1536") || "1536",
    10
  ) as (typeof VECTOR_DIMS)[keyof typeof VECTOR_DIMS];

  if (!Object.values(VECTOR_DIMS).includes(embeddingDimension)) {
    const errorMsg = `Invalid embedding dimension: ${embeddingDimension}. Must be one of: ${Object.values(VECTOR_DIMS).join(", ")}`;
    logger.error(errorMsg);
    throw new Error(errorMsg);
  }

  return { embeddingModelName, embeddingDimension };
}

/**
 * The init probe vector. `runtime.ensureEmbeddingDimension()` calls the handler
 * with `null` purely to learn the vector length; it only inspects `.length`, so
 * a deterministic non-zero[0] marker vector is the correct, legitimate response.
 * This is the ONLY place a synthetic vector is returned — every real failure
 * throws so it can never be persisted as a corrupt embedding (Commandment 8).
 */
function createInitProbeVector(dimension: number): number[] {
  const vector = Array(dimension).fill(0);
  vector[0] = 0.1;
  return vector;
}

export interface BatchEmbeddingParams {
  texts: string[];
}

export async function handleTextEmbedding(
  runtime: IAgentRuntime,
  params: TextEmbeddingParams | string | null
): Promise<number[]> {
  const { embeddingDimension } = getEmbeddingConfig(runtime);

  if (params === null) {
    logger.debug("Creating test embedding for initialization");
    return createInitProbeVector(embeddingDimension);
  }

  let text: string;
  if (typeof params === "string") {
    text = params;
  } else if (typeof params === "object" && params.text) {
    text = params.text;
  } else {
    // A malformed request is a programming error, not a recoverable runtime
    // state. Throw instead of returning a marker vector that would silently
    // corrupt the embedding store (Commandment 8).
    throw new Error("Invalid input format for embedding: expected string or { text: string }");
  }

  if (!text.trim()) {
    throw new Error("Cannot generate embedding for empty text");
  }

  const results = await handleBatchTextEmbedding(runtime, [text]);
  return results[0];
}

export interface BatchEmbeddingResult {
  embedding: number[];
  index: number;
  success: boolean;
  error?: string;
}

export async function handleBatchTextEmbedding(
  runtime: IAgentRuntime,
  texts: string[]
): Promise<number[][]> {
  const { embeddingModelName, embeddingDimension } = getEmbeddingConfig(runtime);
  const client = createCloudApiClient(runtime, true);

  if (!texts || texts.length === 0) {
    return [];
  }

  // Every text must be non-empty: an empty input cannot produce a meaningful
  // vector, and a marker/zero vector would silently corrupt the store. Surface
  // the bad input to the caller (Commandment 8) instead of papering over it.
  const validTexts: { text: string; originalIndex: number }[] = [];
  for (let i = 0; i < texts.length; i++) {
    const text = texts[i]?.trim();
    if (!text) {
      throw new Error(`Cannot generate embedding for empty text at index ${i}`);
    }
    validTexts.push({ text, originalIndex: i });
  }

  const results: number[][] = new Array(texts.length);

  for (let batchStart = 0; batchStart < validTexts.length; batchStart += MAX_BATCH_SIZE) {
    const batchEnd = Math.min(batchStart + MAX_BATCH_SIZE, validTexts.length);
    const batch = validTexts.slice(batchStart, batchEnd);
    const batchTexts = batch.map((b) => b.text);

    logger.info(
      `[BatchEmbeddings] Processing batch ${Math.floor(batchStart / MAX_BATCH_SIZE) + 1}/${Math.ceil(validTexts.length / MAX_BATCH_SIZE)}: ${batch.length} texts`
    );

    try {
      // Records a `cloud.embedding` span on the active per-turn timer when an
      // embedding happens to be on a turn's critical path (most are queued /
      // detached, so this is a no-op there — which is exactly what proves they
      // don't add to turn latency). Retries transient throttling/5xx with
      // bounded exponential backoff (see EMBED_* constants) instead of a single
      // 30s blind sleep.
      let response: Response | null = null;
      for (let attempt = 0; attempt < EMBED_MAX_ATTEMPTS; attempt++) {
        const resp = await timeInferenceSpan(
          "cloud.embedding",
          () =>
            client.requestRaw("POST", "/embeddings", {
              json: {
                model: embeddingModelName,
                input: batchTexts,
                // Pin the output width to the agent's configured dimension
                // (text-embedding-3-* honor `dimensions`). Without it the
                // gateway returns the model's native width — e.g. 1536 for a
                // 384-configured agent — which the store then silently drops as
                // a dimension mismatch (#8769). Asking for the exact width makes
                // the contract explicit and the width-check below authoritative.
                dimensions: embeddingDimension,
              },
              timeoutMs: EMBED_REQUEST_TIMEOUT_MS,
            }),
          { batch: batchTexts.length, attempt }
        );

        const rateLimitInfo = extractRateLimitInfo(resp);
        if (
          rateLimitInfo.remainingRequests !== undefined &&
          rateLimitInfo.remainingRequests < 50
        ) {
          logger.warn(
            `[BatchEmbeddings] Rate limit: ${rateLimitInfo.remainingRequests}/${rateLimitInfo.limitRequests} requests remaining`
          );
        }

        const transient =
          resp.status === 429 ||
          resp.status === 502 ||
          resp.status === 503 ||
          resp.status === 504;
        if (transient && attempt < EMBED_MAX_ATTEMPTS - 1) {
          const delay = embeddingBackoffMs(attempt, rateLimitInfo.retryAfter);
          logger.warn(
            `[BatchEmbeddings] ${resp.status} (attempt ${attempt + 1}/${EMBED_MAX_ATTEMPTS}) — backing off ${delay}ms`
          );
          // Drain the body so the underlying connection can be reused.
          await resp.text().catch(() => undefined);
          await sleep(delay);
          continue;
        }
        response = resp;
        break;
      }

      // Type guard: the loop assigns `response` on its final iteration, so this
      // is unreachable in practice.
      if (!response) {
        throw new Error("[BatchEmbeddings] No response after retry loop");
      }

      if (!response.ok) {
        // Auth errors (401/403) are non-recoverable with the current key.
        // Every other non-OK status is just as fatal for this batch — neither
        // can produce real vectors. Throw in both cases so the router falls
        // through to the next provider (e.g. local inference) instead of
        // silently persisting marker/zero vectors that corrupt the embedding
        // store. Commandment 8: don't hide broken pipelines behind fallbacks.
        if (response.status === 401 || response.status === 403) {
          throw new Error(
            `[BatchEmbeddings] Authentication failed (${response.status}). ` +
              `Check ELIZAOS_CLOUD_API_KEY or ELIZAOS_CLOUD_EMBEDDING_API_KEY — ` +
              `the current key is not authorized for the embedding endpoint.`
          );
        }
        // A terminal 429 means the bounded retries were exhausted and the
        // gateway is still rate-limiting us — surface that distinctly. Any
        // other terminal status (incl. a 503/504 that followed an earlier 429)
        // reports its own status, since that is the failure the caller hit.
        if (response.status === 429) {
          throw new Error(
            `[BatchEmbeddings] Rate-limit retry exhausted: API error: ${response.status} ${response.statusText}`
          );
        }
        throw new Error(
          `[BatchEmbeddings] API error: ${response.status} ${response.statusText}`
        );
      }

      const data = (await response.json()) as {
        data?: Array<{ embedding: number[]; index: number }>;
        usage?: { prompt_tokens: number; total_tokens: number };
      };

      if (!data?.data || !Array.isArray(data.data)) {
        throw new Error("[BatchEmbeddings] API returned invalid response structure");
      }

      // A partial response (fewer vectors than inputs) would leave `undefined`
      // holes in `results` that escape as a non-array "embedding" to the runtime
      // and silently corrupt the store. Demand one vector per input (Commandment
      // 8: fail loudly, never return holes).
      if (data.data.length !== batch.length) {
        throw new Error(
          `[BatchEmbeddings] expected ${batch.length} embeddings, got ${data.data.length}`
        );
      }

      for (const item of data.data) {
        // The response `index` addresses this batch slice. A malformed/duplicated
        // or cross-batch (absolute) index would make `batch[item.index]` undefined
        // and crash on `.originalIndex`; guard it explicitly.
        const slot =
          typeof item.index === "number" ? batch[item.index] : undefined;
        if (!slot) {
          throw new Error(
            `[BatchEmbeddings] response index out of range: ${String(item.index)} (batch size ${batch.length})`
          );
        }
        // Width must match the configured dimension exactly. A wrong width is the
        // root of the "Skipping embedding insert: dimension mismatch" (#8769)
        // silent drop downstream — surface it here so the router can fall through.
        if (!Array.isArray(item.embedding) || item.embedding.length !== embeddingDimension) {
          throw new Error(
            `[BatchEmbeddings] dimension mismatch: model returned ${
              Array.isArray(item.embedding) ? item.embedding.length : "non-array"
            }d but agent is configured for ${embeddingDimension}d`
          );
        }
        results[slot.originalIndex] = item.embedding;
      }

      if (data.usage) {
        const usage = {
          inputTokens: data.usage.prompt_tokens,
          outputTokens: 0,
          totalTokens: data.usage.total_tokens,
        };
        emitModelUsageEvent(runtime, ModelType.TEXT_EMBEDDING, `batch:${batch.length}`, usage);
      }

      logger.debug(
        `[BatchEmbeddings] Got ${batch.length} embeddings (${embeddingDimension}d)`
      );
    } catch (error) {
      // Any failure in this batch (HTTP error, transport error, malformed body)
      // means we have no real vectors for it. Log context and re-throw so the
      // router can fall through to another provider; never persist marker/zero
      // vectors that would corrupt the embedding store (Commandment 8).
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`[BatchEmbeddings] Batch failed: ${message}`);
      throw error instanceof Error ? error : new Error(message);
    }
  }

  return results;
}
