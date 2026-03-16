import type { IAgentRuntime, TextEmbeddingParams } from "@elizaos/core";
import { logger } from "@elizaos/core";
import { embed } from "ai";
import { createOllama } from "ollama-ai-provider";

import { getBaseURL, getEmbeddingModel } from "../utils/config";
import { ensureModelAvailable } from "./availability";

export async function handleTextEmbedding(
  runtime: IAgentRuntime,
  params: TextEmbeddingParams | string | null
): Promise<number[]> {
  try {
    const baseURL = getBaseURL(runtime);
    const customFetch = runtime.fetch ?? undefined;
    const ollama = createOllama({
      fetch: customFetch,
      baseURL,
    });

    const modelName = getEmbeddingModel(runtime);
    logger.log(`[Ollama] Using TEXT_EMBEDDING model: ${modelName}`);
    await ensureModelAvailable(modelName, baseURL, customFetch);

    const text =
      typeof params === "string"
        ? params
        : params
          ? (params as TextEmbeddingParams).text || ""
          : "";

    const embeddingText = text || "test";

    try {
      const embedParams = {
        model: ollama.embedding(modelName),
        value: embeddingText,
      };

      const { embedding } = await embed(embedParams);
      return embedding;
    } catch (embeddingError) {
      logger.error({ error: embeddingError }, "Error generating embedding");
      return Array(1536).fill(0);
    }
  } catch (error) {
    logger.error({ error }, "Error in TEXT_EMBEDDING model");
    return Array(1536).fill(0);
  }
}
