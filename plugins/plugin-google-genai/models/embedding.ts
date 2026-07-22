/**
 * `TEXT_EMBEDDING` handler backed by Google's embedding model (default
 * `gemini-embedding-001`; overridable via `GOOGLE_EMBEDDING_MODEL`).
 * A `null`/empty-object input is treated as an initialization probe and answered
 * with a fixed 768-length marker vector so the runtime can size its embedding
 * column without a network call; real text is truncated to the model's ~8192
 * token limit, embedded, and reported via `emitModelUsageEvent`. Throws on empty
 * text and on an empty API response rather than fabricating a vector.
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

function createInitProbeVector(): number[] {
  const vector = Array(768).fill(0);
  vector[0] = 0.1;
  return vector;
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
    });

    const embedding = response.embeddings?.[0]?.values || [];
    if (embedding.length === 0) {
      throw new Error("Google GenAI API returned no embedding");
    }

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
