import type { IAgentRuntime, TextEmbeddingParams } from "@elizaos/core";
import { logger, ModelType, VECTOR_DIMS } from "@elizaos/core";
import {
  getAuthHeader,
  getEmbeddingBaseURL,
  getSetting,
} from "../utils/config";
import { emitModelUsageEvent } from "../utils/events";

// Maximum texts per batch (OpenAI limit is 2048, but we use smaller for safety)
const MAX_BATCH_SIZE = 100;

/**
 * Extract rate limit info from response headers
 */
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
      parseInt(
        response.headers.get("x-ratelimit-remaining-requests") || "",
        10,
      ) || undefined,
    remainingTokens:
      parseInt(
        response.headers.get("x-ratelimit-remaining-tokens") || "",
        10,
      ) || undefined,
    limitRequests:
      parseInt(response.headers.get("x-ratelimit-limit-requests") || "", 10) ||
      undefined,
    limitTokens:
      parseInt(response.headers.get("x-ratelimit-limit-tokens") || "", 10) ||
      undefined,
    resetRequests:
      response.headers.get("x-ratelimit-reset-requests") || undefined,
    resetTokens: response.headers.get("x-ratelimit-reset-tokens") || undefined,
    retryAfter:
      parseInt(response.headers.get("retry-after") || "", 10) || undefined,
  };
}

/**
 * Get embedding configuration from runtime
 */
function getEmbeddingConfig(runtime: IAgentRuntime) {
  const embeddingModelName = getSetting(
    runtime,
    "ELIZAOS_CLOUD_EMBEDDING_MODEL",
    "text-embedding-3-small",
  );
  const embeddingDimension = Number.parseInt(
    getSetting(runtime, "ELIZAOS_CLOUD_EMBEDDING_DIMENSIONS", "1536") || "1536",
    10,
  ) as (typeof VECTOR_DIMS)[keyof typeof VECTOR_DIMS];

  if (!Object.values(VECTOR_DIMS).includes(embeddingDimension)) {
    const errorMsg = `Invalid embedding dimension: ${embeddingDimension}. Must be one of: ${Object.values(VECTOR_DIMS).join(", ")}`;
    logger.error(errorMsg);
    throw new Error(errorMsg);
  }

  return { embeddingModelName, embeddingDimension };
}

/**
 * Create a zero/error vector with a marker value
 */
function createErrorVector(dimension: number, marker: number): number[] {
  const vector = Array(dimension).fill(0);
  vector[0] = marker;
  return vector;
}

/**
 * TEXT_EMBEDDING model handler (registered with ElizaOS runtime)
 *
 * Supports both single text and batch mode at runtime:
 * - Single: { text: "..." } or "string" → returns number[]
 * - Batch: { texts: ["...", "..."] } → returns number[][] (cast to any at runtime)
 *
 * The return type is number[] for TypeScript compatibility with ElizaOS core,
 * but batch mode returns number[][] at runtime.
 */
export async function handleTextEmbedding(
  runtime: IAgentRuntime,
  params: TextEmbeddingParams | string | null,
): Promise<number[]> {
  const { embeddingDimension } = getEmbeddingConfig(runtime);

  if (params === null) {
    logger.debug("Creating test embedding for initialization");
    return createErrorVector(embeddingDimension, 0.1);
  }

  // Check for batch mode: { texts: string[] }
  // This works at runtime even though TypeScript doesn't know about it
  if (
    typeof params === "object" &&
    params !== null &&
    "texts" in params &&
    Array.isArray((params as { texts: string[] }).texts)
  ) {
    const batchParams = params as { texts: string[] };
    logger.debug(`[Embeddings] Batch mode: ${batchParams.texts.length} texts`);
    // Return batch result - caller expects number[][] at runtime
    // Batch mode returns number[][] but signature is number[]
    return (await handleBatchTextEmbedding(
      runtime,
      batchParams.texts,
    )) as unknown as number[];
  }

  // Single text mode
  let text: string;
  if (typeof params === "string") {
    text = params;
  } else if (typeof params === "object" && params.text) {
    text = params.text;
  } else {
    logger.warn("Invalid input format for embedding");
    return createErrorVector(embeddingDimension, 0.2);
  }

  if (!text.trim()) {
    logger.warn("Empty text for embedding");
    return createErrorVector(embeddingDimension, 0.3);
  }

  // Use batch function with single text for consistency
  const results = await handleBatchTextEmbedding(runtime, [text]);
  return results[0];
}

/**
 * Batch result type for tracking individual embedding results
 */
export interface BatchEmbeddingResult {
  embedding: number[];
  index: number;
  success: boolean;
  error?: string;
}

/**
 * BATCH TEXT_EMBEDDING handler - sends multiple texts in ONE API request
 * This is MUCH more efficient for processing large documents
 * OpenAI supports up to 2048 texts per request
 *
 * @param runtime - Agent runtime
 * @param texts - Array of texts to embed (max 100 per batch for safety)
 * @returns Array of embeddings in same order as input texts
 */
export async function handleBatchTextEmbedding(
  runtime: IAgentRuntime,
  texts: string[],
): Promise<number[][]> {
  const { embeddingModelName, embeddingDimension } =
    getEmbeddingConfig(runtime);
  const embeddingBaseURL = getEmbeddingBaseURL(runtime);

  if (!texts || texts.length === 0) {
    logger.warn("[BatchEmbeddings] Empty texts array");
    return [];
  }

  // Filter out empty texts and track indices
  const validTexts: { text: string; originalIndex: number }[] = [];
  const results: number[][] = new Array(texts.length);

  for (let i = 0; i < texts.length; i++) {
    const text = texts[i]?.trim();
    if (text) {
      validTexts.push({ text, originalIndex: i });
    } else {
      // Fill with error vector for empty texts
      results[i] = createErrorVector(embeddingDimension, 0.3);
    }
  }

  if (validTexts.length === 0) {
    logger.warn("[BatchEmbeddings] All texts were empty");
    return results;
  }

  // Process in batches of MAX_BATCH_SIZE
  for (
    let batchStart = 0;
    batchStart < validTexts.length;
    batchStart += MAX_BATCH_SIZE
  ) {
    const batchEnd = Math.min(batchStart + MAX_BATCH_SIZE, validTexts.length);
    const batch = validTexts.slice(batchStart, batchEnd);
    const batchTexts = batch.map((b) => b.text);

    logger.info(
      `[BatchEmbeddings] Processing batch ${Math.floor(batchStart / MAX_BATCH_SIZE) + 1}/${Math.ceil(validTexts.length / MAX_BATCH_SIZE)}: ${batch.length} texts`,
    );

    try {
      const response = await fetch(`${embeddingBaseURL}/embeddings`, {
        method: "POST",
        headers: {
          ...getAuthHeader(runtime, true),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: embeddingModelName,
          input: batchTexts, // Array of texts!
        }),
      });

      const rateLimitInfo = extractRateLimitInfo(response);

      // Log rate limit status
      if (
        rateLimitInfo.remainingRequests !== undefined &&
        rateLimitInfo.remainingRequests < 50
      ) {
        logger.warn(
          `[BatchEmbeddings] Rate limit: ${rateLimitInfo.remainingRequests}/${rateLimitInfo.limitRequests} requests remaining`,
        );
      }

      // Handle rate limit (429)
      if (response.status === 429) {
        const retryAfter = rateLimitInfo.retryAfter || 30;
        logger.warn(
          `[BatchEmbeddings] Rate limited, waiting ${retryAfter}s...`,
        );
        await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000));

        // Retry this batch
        const retryResponse = await fetch(`${embeddingBaseURL}/embeddings`, {
          method: "POST",
          headers: {
            ...getAuthHeader(runtime, true),
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: embeddingModelName,
            input: batchTexts,
          }),
        });

        if (!retryResponse.ok) {
          logger.error(
            `[BatchEmbeddings] Retry failed: ${retryResponse.status}`,
          );
          // Fill batch with error vectors
          for (const item of batch) {
            results[item.originalIndex] = createErrorVector(
              embeddingDimension,
              0.4,
            );
          }
          continue;
        }

        const retryData = (await retryResponse.json()) as {
          data: Array<{ embedding: number[]; index: number }>;
        };

        if (retryData?.data) {
          for (const item of retryData.data) {
            const originalIndex = batch[item.index].originalIndex;
            results[originalIndex] = item.embedding;
          }
          logger.info(
            `[BatchEmbeddings] Retry successful for ${batch.length} embeddings`,
          );
        }
        continue;
      }

      if (!response.ok) {
        logger.error(
          `[BatchEmbeddings] API error: ${response.status} - ${response.statusText}`,
        );
        for (const item of batch) {
          results[item.originalIndex] = createErrorVector(
            embeddingDimension,
            0.4,
          );
        }
        continue;
      }

      const data = (await response.json()) as {
        data: Array<{ embedding: number[]; index: number }>;
        usage?: { prompt_tokens: number; total_tokens: number };
      };

      if (!data?.data || !Array.isArray(data.data)) {
        logger.error("[BatchEmbeddings] API returned invalid structure");
        for (const item of batch) {
          results[item.originalIndex] = createErrorVector(
            embeddingDimension,
            0.5,
          );
        }
        continue;
      }

      // Map embeddings back to original indices
      for (const item of data.data) {
        const originalIndex = batch[item.index].originalIndex;
        results[originalIndex] = item.embedding;
      }

      if (data.usage) {
        const usage = {
          inputTokens: data.usage.prompt_tokens,
          outputTokens: 0,
          totalTokens: data.usage.total_tokens,
        };
        emitModelUsageEvent(
          runtime,
          ModelType.TEXT_EMBEDDING,
          `batch:${batch.length}`,
          usage,
        );
      }

      logger.debug(
        `[BatchEmbeddings] Got ${batch.length} embeddings (${embeddingDimension}d), remaining: ${rateLimitInfo.remainingRequests ?? "unknown"}`,
      );
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`[BatchEmbeddings] Error: ${message}`);
      for (const item of batch) {
        results[item.originalIndex] = createErrorVector(
          embeddingDimension,
          0.6,
        );
      }
    }
  }

  return results;
}
