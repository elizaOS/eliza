import type { IAgentRuntime, TextEmbeddingParams } from "@elizaos/core";
import { GatewayClient } from "../providers/client";
import { buildConfig, getEmbeddingDimensions, getEmbeddingModel } from "../utils/config";

export async function handleTextEmbedding(
  runtime: IAgentRuntime,
  params: TextEmbeddingParams | string | null
): Promise<number[]> {
  const config = buildConfig(runtime);
  const client = new GatewayClient(config);

  let text: string;
  if (params === null) {
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
