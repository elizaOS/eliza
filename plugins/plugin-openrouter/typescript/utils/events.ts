import type { IAgentRuntime, ModelType } from "@elizaos/core";
import { logger } from "@elizaos/core";

interface AIUsage {
  inputTokens?: number;
  outputTokens?: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export function emitModelUsageEvent(
  _runtime: IAgentRuntime,
  modelType: (typeof ModelType)[keyof typeof ModelType],
  prompt: string,
  usage: AIUsage
): void {
  const inputTokens = usage.inputTokens ?? usage.promptTokens ?? 0;
  const outputTokens = usage.outputTokens ?? usage.completionTokens ?? 0;
  const totalTokens = usage.totalTokens ?? inputTokens + outputTokens;

  logger.debug({
    event: "model:usage",
    modelType,
    provider: "openrouter",
    prompt: prompt.substring(0, 100),
    usage: {
      promptTokens: inputTokens,
      completionTokens: outputTokens,
      totalTokens,
    },
    timestamp: Date.now(),
  });
}
