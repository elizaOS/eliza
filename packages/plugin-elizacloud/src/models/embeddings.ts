import type { IAgentRuntime, TextEmbeddingParams } from "@elizaos/core";
import { logger, ModelType, VECTOR_DIMS } from "@elizaos/core";
import {
  getSetting,
  getEmbeddingBaseURL,
  getAuthHeader,
} from "../utils/config";
import { emitModelUsageEvent } from "../utils/events";

/**
 * TEXT_EMBEDDING model handler
 */
export async function handleTextEmbedding(
  runtime: IAgentRuntime,
  params: TextEmbeddingParams | string | null,
): Promise<number[]> {
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
  if (params === null) {
    logger.debug("Creating test embedding for initialization");
    const testVector = Array(embeddingDimension).fill(0);
    testVector[0] = 0.1;
    return testVector;
  }
  let text: string;
  if (typeof params === "string") {
    text = params;
  } else if (typeof params === "object" && params.text) {
    text = params.text;
  } else {
    logger.warn("Invalid input format for embedding");
    const fallbackVector = Array(embeddingDimension).fill(0);
    fallbackVector[0] = 0.2;
    return fallbackVector;
  }
  if (!text.trim()) {
    logger.warn("Empty text for embedding");
    const emptyVector = Array(embeddingDimension).fill(0);
    emptyVector[0] = 0.3;
    return emptyVector;
  }

  const embeddingBaseURL = getEmbeddingBaseURL(runtime);

  try {
    const response = await fetch(`${embeddingBaseURL}/embeddings`, {
      method: "POST",
      headers: {
        ...getAuthHeader(runtime, true),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: embeddingModelName,
        input: text,
      }),
    });

    if (!response.ok) {
      logger.error(
        `ElizaOS Cloud API error: ${response.status} - ${response.statusText}`,
      );
      const errorVector = Array(embeddingDimension).fill(0);
      errorVector[0] = 0.4;
      return errorVector;
    }

    const data = (await response.json()) as {
      data: [{ embedding: number[] }];
      usage?: { prompt_tokens: number; total_tokens: number };
    };

    if (!data?.data?.[0]?.embedding) {
      logger.error("API returned invalid structure");
      const errorVector = Array(embeddingDimension).fill(0);
      errorVector[0] = 0.5;
      return errorVector;
    }

    const embedding = data.data[0].embedding;

    if (data.usage) {
      const usage = {
        inputTokens: data.usage.prompt_tokens,
        outputTokens: 0,
        totalTokens: data.usage.total_tokens,
      };

      emitModelUsageEvent(runtime, ModelType.TEXT_EMBEDDING, text, usage);
    }

    logger.log(`Got valid embedding with length ${embedding.length}`);
    return embedding;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`Error generating embedding: ${message}`);
    const errorVector = Array(embeddingDimension).fill(0);
    errorVector[0] = 0.6;
    return errorVector;
  }
}
