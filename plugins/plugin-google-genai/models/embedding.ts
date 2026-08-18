/**
 * `TEXT_EMBEDDING` handler backed by Google's embedding model (default
 * `gemini-embedding-001`; overridable via `GOOGLE_EMBEDDING_MODEL`).
 * A `null`/empty-object input is treated as an initialization probe and answered
 * with a fixed 768-length marker vector so the runtime can size its embedding
 * column without a network call; real text is truncated to the model's ~8192
 * token limit, embedded, and reported via `emitModelUsageEvent`. Real requests
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
import { logger } from "@elizaos/core";
import { createGoogleGenAI, getEmbeddingModel } from "../utils/config";
import { emitModelUsageEvent } from "../utils/events";
import { countTokens } from "../utils/tokenization";

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
 * produced) must renormalize. A zero vector cannot be normalized and is
 * rejected upstream as an empty/degenerate response.
 */
function l2Normalize(vector: number[]): number[] {
  let sumSquares = 0;
  for (const value of vector) {
    sumSquares += value * value;
  }
  const norm = Math.sqrt(sumSquares);
  if (norm === 0) {
    throw new Error(
      "Google GenAI API returned a zero-magnitude embedding that cannot be normalized",
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
      // Pin the output width to the same size as the init probe so the value
      // written matches the pgvector column the runtime sized from the probe.
      // Without this, `gemini-embedding-001` returns its 3072-dim default and
      // every write fails against the 768-wide column (#22010).
      config: { outputDimensionality: EMBEDDING_DIMENSIONS },
    });

    const rawEmbedding = response.embeddings?.[0]?.values || [];
    if (rawEmbedding.length === 0) {
      throw new Error("Google GenAI API returned no embedding");
    }

    // Fail CLOSED on a width that disagrees with the probe rather than writing a
    // mismatched vector into a column the runtime already sized from the probe.
    if (rawEmbedding.length !== EMBEDDING_DIMENSIONS) {
      throw new Error(
        `Google embedding model "${embeddingModelName}" returned ${rawEmbedding.length} dimensions, ` +
          `but the runtime sized its embedding column at ${EMBEDDING_DIMENSIONS} (the init-probe width). ` +
          `Set GOOGLE_EMBEDDING_MODEL to a model whose output matches, or align the requested outputDimensionality.`,
      );
    }

    // Google does not pre-normalize sub-3072 outputs; renormalize so the vector
    // is unit-length and cosine-comparable like the native 768-dim model.
    const embedding = l2Normalize(rawEmbedding);

    const promptTokens = await countTokens(text);

    emitModelUsageEvent(runtime, TEXT_EMBEDDING_MODEL_TYPE, text, {
      promptTokens,
      completionTokens: 0,
      totalTokens: promptTokens,
    });

    logger.log(`Got embedding with length ${embedding.length}`);
    return embedding;
  } catch (error) {
    // error-policy:J2 context-adding rethrow — never fabricate a vector; the
    // provider failure surfaces to the caller (#9324: throw, never fabricate).
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
