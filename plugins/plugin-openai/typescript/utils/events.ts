import type { IAgentRuntime, ModelTypeName } from "@elizaos/core";
import { EventType } from "@elizaos/core";
import type { TokenUsage } from "../types";

const MAX_PROMPT_LENGTH = 200;

interface ModelUsageEventPayload {
  runtime: IAgentRuntime;
  source: "openai";
  provider: "openai";
  type: ModelTypeName;
  prompt: string;
  tokens: {
    prompt: number;
    completion: number;
    total: number;
  };
}

interface AISDKUsage {
  inputTokens?: number;
  outputTokens?: number;
}

interface OpenAIAPIUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

type ModelUsage = TokenUsage | AISDKUsage | OpenAIAPIUsage;

function truncatePrompt(prompt: string): string {
  if (prompt.length <= MAX_PROMPT_LENGTH) {
    return prompt;
  }
  return `${prompt.slice(0, MAX_PROMPT_LENGTH)}…`;
}

function normalizeUsage(usage: ModelUsage): TokenUsage {
  if ("promptTokens" in usage) {
    return {
      promptTokens: usage.promptTokens ?? 0,
      completionTokens: usage.completionTokens ?? 0,
      totalTokens: usage.totalTokens ?? (usage.promptTokens ?? 0) + (usage.completionTokens ?? 0),
    };
  }
  if ("inputTokens" in usage || "outputTokens" in usage) {
    const input = (usage as AISDKUsage).inputTokens ?? 0;
    const output = (usage as AISDKUsage).outputTokens ?? 0;
    return {
      promptTokens: input,
      completionTokens: output,
      totalTokens: input + output,
    };
  }
  return {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
  };
}

export function emitModelUsageEvent(
  runtime: IAgentRuntime,
  type: ModelTypeName,
  prompt: string,
  usage: ModelUsage
): void {
  const normalized = normalizeUsage(usage);

  const payload: ModelUsageEventPayload = {
    runtime,
    source: "openai",
    provider: "openai",
    type,
    prompt: truncatePrompt(prompt),
    tokens: {
      prompt: normalized.promptTokens,
      completion: normalized.completionTokens,
      total: normalized.totalTokens,
    },
  };

  runtime.emitEvent(EventType.MODEL_USED, payload);
}
