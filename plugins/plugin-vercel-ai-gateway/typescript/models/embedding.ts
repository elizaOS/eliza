/**
 * Embedding model handler for Vercel AI Gateway plugin.
 */

import type { IAgentRuntime, TextEmbeddingParams } from "@elizaos/core";
import { GatewayClient } from "../providers/client";
import { buildConfig, getEmbeddingDimensions, getEmbeddingModel } from "../utils/config";

/**
 * Handle TEXT_EMBEDDING model requests.
 */
export async function handleTextEmbedding(
  runtime: IAgentRuntime,
  params: TextEmbeddingParams | string | null
): Promise<number[]> {
  const config = buildConfig(runtime);
  const client = new GatewayClient(config);

  // Handle various input formats
  let text: string;
  if (params === null) {
    // Called during initialization to check embedding dimension
    text = "test";
  } else if (typeof params === "string") {
    text = params;
  } else {
    text = params.text;
  }

  const model = getEmbeddingModel(runtime);
  const dimensions = getEmbeddingDimensions(runtime);

  return client.createEmbedding({
    text,
    model,
    dimensions,
  });
}
