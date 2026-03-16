import type { GenerateTextParams, IAgentRuntime } from "@elizaos/core";
import { GatewayClient } from "../providers/client";
import { buildConfig, getLargeModel, getSmallModel } from "../utils/config";

export async function handleTextSmall(
  runtime: IAgentRuntime,
  params: GenerateTextParams
): Promise<string> {
  const config = buildConfig(runtime);
  const client = new GatewayClient(config);

  const model = getSmallModel(runtime);

  if (params.stream && params.onStreamChunk) {
    const chunks: string[] = [];
    for await (const chunk of client.streamText({
      prompt: params.prompt,
      system: runtime.character?.system,
      model,
      maxTokens: params.maxTokens,
      temperature: params.temperature,
      stopSequences: params.stopSequences,
    })) {
      chunks.push(chunk);
      params.onStreamChunk(chunk);
    }
    return chunks.join("");
  }

  return client.generateText({
    prompt: params.prompt,
    system: runtime.character?.system,
    model,
    maxTokens: params.maxTokens,
    temperature: params.temperature,
    frequencyPenalty: params.frequencyPenalty,
    presencePenalty: params.presencePenalty,
    stopSequences: params.stopSequences,
  });
}

/**
 * Handle TEXT_LARGE model requests.
 */
export async function handleTextLarge(
  runtime: IAgentRuntime,
  params: GenerateTextParams
): Promise<string> {
  const config = buildConfig(runtime);
  const client = new GatewayClient(config);

  const model = getLargeModel(runtime);

  if (params.stream && params.onStreamChunk) {
    const chunks: string[] = [];
    for await (const chunk of client.streamText({
      prompt: params.prompt,
      system: runtime.character?.system,
      model,
      maxTokens: params.maxTokens,
      temperature: params.temperature,
      stopSequences: params.stopSequences,
    })) {
      chunks.push(chunk);
      params.onStreamChunk(chunk);
    }
    return chunks.join("");
  }

  return client.generateText({
    prompt: params.prompt,
    system: runtime.character?.system,
    model,
    maxTokens: params.maxTokens,
    temperature: params.temperature,
    frequencyPenalty: params.frequencyPenalty,
    presencePenalty: params.presencePenalty,
    stopSequences: params.stopSequences,
  });
}
