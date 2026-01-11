/**
 * Event utilities for OpenAI plugin
 *
 * Handles model usage event emission for tracking and analytics.
 */

import type { IAgentRuntime, ModelTypeName } from "@elizaos/core";
import { EventType } from "@elizaos/core";
import type { TokenUsage } from "../types";

// ============================================================================
// Constants
// ============================================================================

/**
 * Maximum length for truncated prompts in events
 * Prevents leaking sensitive data in analytics
 */
const MAX_PROMPT_LENGTH = 200;

// ============================================================================
// Types
// ============================================================================

/**
 * Model usage event payload
 */
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

/**
 * AI SDK usage format (input/output tokens)
 */
interface AISDKUsage {
  inputTokens?: number;
  outputTokens?: number;
}

/**
 * OpenAI API usage format
 */
interface OpenAIAPIUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

/**
 * Combined usage type supporting both formats
 */
type ModelUsage = TokenUsage | AISDKUsage | OpenAIAPIUsage;

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Truncates a prompt to prevent leaking sensitive data in events.
 *
 * @param prompt - The prompt to truncate
 * @returns Truncated prompt with ellipsis if needed
 */
function truncatePrompt(prompt: string): string {
  if (prompt.length <= MAX_PROMPT_LENGTH) {
    return prompt;
  }
  return `${prompt.slice(0, MAX_PROMPT_LENGTH)}…`;
}

/**
 * Normalizes usage data from different formats.
 *
 * @param usage - Usage data in any supported format
 * @returns Normalized token counts
 */
function normalizeUsage(usage: ModelUsage): TokenUsage {
  // Handle TokenUsage format (promptTokens, completionTokens)
  if ("promptTokens" in usage) {
    return {
      promptTokens: usage.promptTokens ?? 0,
      completionTokens: usage.completionTokens ?? 0,
      totalTokens: usage.totalTokens ?? (usage.promptTokens ?? 0) + (usage.completionTokens ?? 0),
    };
  }

  // Handle AI SDK format (inputTokens, outputTokens)
  if ("inputTokens" in usage || "outputTokens" in usage) {
    const input = (usage as AISDKUsage).inputTokens ?? 0;
    const output = (usage as AISDKUsage).outputTokens ?? 0;
    return {
      promptTokens: input,
      completionTokens: output,
      totalTokens: input + output,
    };
  }

  // Fallback for unexpected format
  return {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
  };
}

// ============================================================================
// Public Functions
// ============================================================================

/**
 * Emits a model usage event for tracking and analytics.
 *
 * The prompt is truncated to prevent leaking sensitive data.
 * Supports both AI SDK usage format and OpenAI API format.
 *
 * @param runtime - The agent runtime
 * @param type - The model type that was used
 * @param prompt - The prompt that was sent
 * @param usage - Token usage data
 */
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
