import type { IAgentRuntime, ObjectGenerationParams } from "@elizaos/core";
import { GatewayClient } from "../providers/client";
import { buildConfig, getLargeModel, getSmallModel } from "../utils/config";

export async function handleObjectSmall(
  runtime: IAgentRuntime,
  params: ObjectGenerationParams
): Promise<Record<string, unknown>> {
  const config = buildConfig(runtime);
  const client = new GatewayClient(config);

  const model = getSmallModel(runtime);

  return client.generateObject({
    prompt: params.prompt,
    model,
    temperature: params.temperature,
  });
}

export async function handleObjectLarge(
  runtime: IAgentRuntime,
  params: ObjectGenerationParams
): Promise<Record<string, unknown>> {
  const config = buildConfig(runtime);
  const client = new GatewayClient(config);

  const model = getLargeModel(runtime);

  return client.generateObject({
    prompt: params.prompt,
    model,
    temperature: params.temperature,
  });
}
