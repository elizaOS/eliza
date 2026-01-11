/**
 * Object generation model handlers for Vercel AI Gateway plugin.
 */

import type { IAgentRuntime, ObjectGenerationParams } from "@elizaos/core";
import { GatewayClient } from "../providers/client";
import { buildConfig, getSmallModel, getLargeModel } from "../utils/config";

/**
 * Handle OBJECT_SMALL model requests.
 */
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

/**
 * Handle OBJECT_LARGE model requests.
 */
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


