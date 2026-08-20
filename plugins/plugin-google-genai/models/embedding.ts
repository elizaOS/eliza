/**
 * `TEXT_EMBEDDING` handler backed by Google's embedding model (default
 * `gemini-embedding-001`; overridable via `GOOGLE_EMBEDDING_MODEL`).
 * A `null`/empty-object input is treated as an initialization probe and answered
 * with a fixed 768-length marker vector so the runtime can size its embedding
 * column without a network call; real text is truncated to the model's
 * documented input token limit (2,048 for the default `gemini-embedding-001`,
 * 8,192 for the larger-window `gemini-embedding-2`) via
 * `getEmbeddingInputTokenLimit`, embedded, and reported via
 * `emitModelUsageEvent` as soon as the billed provider call returns. Real requests
 * pin `outputDimensionality` to the same 768 width as the probe and L2-normalize
 * the result, because the default `gemini-embedding-001` otherwise emits its
 * 3072-dim default and every write would fail the probe-sized column (#22010).
 * Throws on empty text, on an empty API response, and on a width that disagrees
 * with the probe rather than fabricating or misfitting a vector.
 *
 * A 404 / NOT_FOUND from the provider (e.g. a decommissioned model id like
 * `text-embedding-004` on the current `v1beta` route) fails CLOSED with one
 * clear, model-named error instead of surfacing the raw SDK 404 on every call.
 * The runtime treats a thrown probe as "this provider cannot embed" and advances
 * to the next TEXT_EMBEDDING provider (or disables embedding generation), so a
 * misconfigured model id can no longer produce an infinite 404 retry spam.
 */

import type { IAgentRuntime, TextEmbeddingParams } from "@elizaos/core";
import * as ElizaCore from "@elizaos/core";
import { ElizaError, logger } from "@elizaos/core";
import type { GoogleGenAI } from "@google/genai";
import {
  createGoogleGenAI,
  getEmbeddingInputTokenLimit,
  getEmbeddingModel,
} from "../utils/config";
import { emitModelUsageEvent } from "../utils/events";

const TEXT_EMBEDDING_MODEL_TYPE = ((
  ElizaCore as { ModelType?: Record<string, string> }
).ModelType?.TEXT_EMBEDDING ?? "TEXT_EMBEDDING") as string;

/**
 * Target embedding width for both the init probe and every real write. Chosen
 * to match the historical/native default so an existing 768-wide pgvector
 * column keeps working after the default model moved to `gemini-embedding-001`
 * (which otherwise emits 3072). `gemini-embedding-001` accepts an
 * `outputDimensionality` in {768, 1536, 3072}; 768 is Google's supported
 * reduced width.
 */
const EMBEDDING_DIMENSIONS = 768;

function createInitProbeVector(): number[] {
  const vector = Array(EMBEDDING_DIMENSIONS).fill(0);
  vector[0] = 0.1;
  return vector;
}

/**
 * L2-normalize an embedding so its Euclidean norm is 1. Google returns
 * sub-3072 `outputDimensionality` vectors un-normalized, so callers that expect
 * cosine-comparable unit vectors (as the native 768-dim `text-embedding-004`
 * produced) must renormalize. Three inputs cannot yield a unit vector and are
 * each rejected here with a typed error rather than returning a silently-corrupt
 * embedding a downstream store could persist: a non-finite component (a
 * `NaN`/`±Infinity` slipping through a transport/SDK bug), a norm that overflows
 * to a non-finite value (a huge or accumulating magnitude whose squares exceed
 * `Number.MAX_VALUE` even though every component is finite — dividing by it
 * would yield an all-zero "unit" vector), and a zero-magnitude vector.
 */
function l2Normalize(vector: number[]): number[] {
  let sumSquares = 0;
  for (let index = 0; index < vector.length; index++) {
    const value = vector[index];
    if (!Number.isFinite(value)) {
      throw new ElizaError(
        "Google GenAI API returned a non-finite embedding component that cannot be normalized",
        {
          code: "EMBEDDING_NON_FINITE",
          context: { dimensions: vector.length, index },
        },
      );
    }
    sumSquares += value * value;
  }
  const norm = Math.sqrt(sumSquares);
  if (!Number.isFinite(norm)) {
    // Every component is finite but their squared sum overflowed the double
    // range, so `norm` is `Infinity` and `value / norm` would be all zeros —
    // a silent all-zero "unit" vector. Fail closed like the other classes.
    throw new ElizaError(
      "Google GenAI API returned an embedding whose magnitude overflowed to a non-finite value and cannot be normalized",
      {
        code: "EMBEDDING_NORM_OVERFLOW",
        context: { dimensions: vector.length },
      },
    );
  }
  if (norm === 0) {
    throw new ElizaError(
      "Google GenAI API returned a zero-magnitude embedding that cannot be normalized",
      {
        code: "EMBEDDING_ZERO_MAGNITUDE",
        context: { dimensions: vector.length },
      },
    );
  }
  return vector.map((value) => value / norm);
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

async function providerTokenCount(
  genAI: GoogleGenAI,
  model: string,
  contents: string,
): Promise<number> {
  let response: Awaited<ReturnType<GoogleGenAI["models"]["countTokens"]>>;
  try {
    response = await genAI.models.countTokens({ model, contents });
  } catch (error) {
    // error-policy:J2 context-adding rethrow — token counting is the provider
    // safety boundary, so transport/auth/model failures must remain typed and
    // attributable instead of falling through as an unrelated embedding error.
    throw new ElizaError(
      `Google token counting failed for embedding model "${model}"`,
      {
        code: "EMBEDDING_TOKEN_COUNT_FAILED",
        context: { model, inputCodeUnits: contents.length },
        cause: error,
      },
    );
  }
  const total = response.totalTokens;
  if (
    typeof total !== "number" ||
    !Number.isSafeInteger(total) ||
    total < 0 ||
    (contents.length > 0 && total === 0)
  ) {
    throw new ElizaError("Google token counter returned an invalid total", {
      code: "EMBEDDING_TOKEN_COUNT_INVALID",
      context: { model, totalTokens: total },
    });
  }
  return total;
}

async function truncateToEmbeddingTokenLimit(
  genAI: GoogleGenAI,
  model: string,
  text: string,
  limit: number,
): Promise<{ text: string; tokens: number; truncated: boolean }> {
  const fullTokens = await providerTokenCount(genAI, model, text);
  if (fullTokens <= limit) {
    return { text, tokens: fullTokens, truncated: false };
  }

  const boundaries = [0];
  for (let index = 0; index < text.length; ) {
    const point = text.codePointAt(index);
    index += point !== undefined && point > 0xffff ? 2 : 1;
    boundaries.push(index);
  }

  let low = 0;
  let high = boundaries.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const candidate = text.slice(0, boundaries[middle]);
    const tokens = await providerTokenCount(genAI, model, candidate);
    if (tokens <= limit) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }

  const truncatedText = text.slice(0, boundaries[low]);
  // Prefix token counts are not a mathematically monotone contract for a
  // subword tokenizer: appending text can retokenize the preceding suffix.
  // Binary search is therefore only a fast way to find a conservative
  // candidate, not proof of maximality. Re-measure the exact returned prefix
  // so tokenizer changes or a non-monotone/mock implementation can never let
  // an over-limit request reach embedContent.
  const verifiedTokens = await providerTokenCount(genAI, model, truncatedText);
  if (verifiedTokens > limit || !truncatedText.trim()) {
    throw new ElizaError(
      "Google tokenizer could not produce a non-empty embedding prefix within the model limit",
      {
        code: "EMBEDDING_TOKEN_LIMIT_UNSATISFIABLE",
        context: {
          model,
          limit,
          candidateTokens: verifiedTokens,
          candidateCodePoints: low,
        },
      },
    );
  }
  return { text: truncatedText, tokens: verifiedTokens, truncated: true };
}

/** Report an already-billed call without allowing telemetry to decide its outcome. */
async function reportEmbeddingUsage(
  runtime: IAgentRuntime,
  text: string,
  embeddingModelName: string,
  promptTokens: number,
): Promise<void> {
  try {
    await emitModelUsageEvent(runtime, TEXT_EMBEDDING_MODEL_TYPE, text, {
      promptTokens,
      completionTokens: 0,
      totalTokens: promptTokens,
    });
  } catch (error) {
    // error-policy:J7 diagnostics must not kill the loop — a telemetry failure
    // cannot mask the embedding result or later validation.
    runtime.reportError(
      "GoogleGenAI.embeddingUsage",
      error instanceof Error ? error : new Error(String(error)),
      { model: embeddingModelName },
    );
  }
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

  const tokenLimit = getEmbeddingInputTokenLimit(embeddingModelName);

  try {
    const bounded = await truncateToEmbeddingTokenLimit(
      genAI,
      embeddingModelName,
      text,
      tokenLimit,
    );
    if (bounded.truncated) {
      logger.warn(
        `[Google GenAI] Embedding input has more than ${tokenLimit} tokens for model "${embeddingModelName}"; truncated with the provider tokenizer to ${bounded.tokens} tokens`,
      );
    }
    text = bounded.text;

    const response = await genAI.models.embedContent({
      model: embeddingModelName,
      contents: text,
      // Pin the output width to the same size as the init probe so the value
      // written matches the pgvector column the runtime sized from the probe.
      // Without this, `gemini-embedding-001` returns its 3072-dim default and
      // every write fails against the 768-wide column (#22010).
      config: { outputDimensionality: EMBEDDING_DIMENSIONS },
    });

    // The provider billed this call when it returned. Reuse the exact token
    // count already required for the input-limit gate, before validation can
    // reject the returned vector (#22102).
    await reportEmbeddingUsage(
      runtime,
      text,
      embeddingModelName,
      bounded.tokens,
    );

    const rawEmbedding = response.embeddings?.[0]?.values || [];
    if (rawEmbedding.length === 0) {
      throw new Error("Google GenAI API returned no embedding");
    }

    // Fail CLOSED on a width that disagrees with the probe rather than writing a
    // mismatched vector into a column the runtime already sized from the probe.
    if (rawEmbedding.length !== EMBEDDING_DIMENSIONS) {
      throw new ElizaError(
        `Google embedding model "${embeddingModelName}" returned ${rawEmbedding.length} dimensions, ` +
          `but the init probe pinned the embedding width to ${EMBEDDING_DIMENSIONS}. ` +
          `Set GOOGLE_EMBEDDING_MODEL to a model whose output matches the ${EMBEDDING_DIMENSIONS}-dim probe.`,
        {
          code: "EMBEDDING_DIMENSION_MISMATCH",
          context: {
            model: embeddingModelName,
            returnedDimensions: rawEmbedding.length,
            expectedDimensions: EMBEDDING_DIMENSIONS,
          },
        },
      );
    }

    // Google does not pre-normalize sub-3072 outputs; renormalize so the vector
    // is unit-length and cosine-comparable like the native 768-dim model.
    const embedding = l2Normalize(rawEmbedding);

    logger.log(`Got embedding with length ${embedding.length}`);
    return embedding;
  } catch (error) {
    // error-policy:J2 context-adding rethrow — never fabricate a vector; the
    // provider failure surfaces to the caller (#9324: throw, never fabricate).
    // Our own typed failures (width mismatch, non-finite/zero magnitude) are
    // already actionable — rethrow them as-is so a value like a "returned 404
    // dimensions" mismatch is never re-bucketed by the 404 message probe below.
    if (error instanceof ElizaError) {
      logger.error(`Error generating embedding: ${error.message}`);
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    // Fail CLOSED on a 404 / NOT_FOUND with one clear, model-named error rather
    // than propagating the raw SDK 404 on every subsequent call. This is the
    // "invalid model id for the API version" case (e.g. text-embedding-004 on
    // v1beta): retrying can never succeed, so surface an actionable message once
    // and let the runtime advance to the next provider / disable embeddings
    // instead of spamming 404s.
    if (/\b404\b|NOT_FOUND|not found/i.test(message)) {
      const failClosed = new Error(
        `Google embedding model "${embeddingModelName}" is not available on the current API version (404 NOT_FOUND). ` +
          `Set GOOGLE_EMBEDDING_MODEL to a supported id (e.g. gemini-embedding-001), or disable the Google embedding provider. Original error: ${message}`,
      );
      logger.error(`Error generating embedding: ${failClosed.message}`);
      throw failClosed;
    }
    logger.error(`Error generating embedding: ${message}`);
    throw error instanceof Error ? error : new Error(String(error));
  }
}
