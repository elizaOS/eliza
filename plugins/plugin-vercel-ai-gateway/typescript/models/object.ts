import type { IAgentRuntime, JsonValue, ObjectGenerationParams } from "@elizaos/core";
import { GatewayClient } from "../providers/client";
import { buildConfig, getLargeModel, getSmallModel } from "../utils/config";

export async function handleObjectSmall(
  runtime: IAgentRuntime,
  params: ObjectGenerationParams
): Promise<Record<string, JsonValue>> {
  const config = buildConfig(runtime);
  const client = new GatewayClient(config);

  const model = getSmallModel(runtime);

  return (await client.generateObject({
    prompt: params.prompt,
    model,
    temperature: params.temperature,
  })) as Record<string, JsonValue>;
}

export async function handleObjectLarge(
  runtime: IAgentRuntime,
  params: ObjectGenerationParams
): Promise<Record<string, JsonValue>> {
  const config = buildConfig(runtime);
  const client = new GatewayClient(config);

  const model = getLargeModel(runtime);

  return (await client.generateObject({
    prompt: params.prompt,
    model,
    temperature: params.temperature,
  })) as Record<string, JsonValue>;
}
