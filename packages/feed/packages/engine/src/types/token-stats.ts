/**
 * Token Statistics Types
 *
 * @description Types for tracking LLM token usage across engine operations.
 * Used to measure costs, optimize prompts, and provide transparency on AI usage.
 */

export type LLMProviderName = 'elizacloud' | 'groq' | 'claude' | 'openai';

/**
 * Token usage for a single LLM call
 */
export interface LLMCallTokenUsage {
  /** Unique identifier for this call */
  callId: string;
  /** Provider used (elizacloud, groq, claude, openai) */
  provider: LLMProviderName;
  /** Model used for the call */
  model: string;
  /** Number of input/prompt tokens */
  inputTokens: number;
  /** Number of output/completion tokens */
  outputTokens: number;
  /** Total tokens (input + output) */
  totalTokens: number;
  /** Type of prompt/operation (e.g., 'npc-market-decisions', 'generate_post') */
  promptType: string;
  /** Duration of the call in milliseconds */
  durationMs: number;
  /** Whether the call succeeded */
  success: boolean;
  /** Error message if failed */
  error?: string;
  /** Timestamp of the call */
  timestamp: Date;
}

/**
 * Aggregated token statistics per prompt type
 */
export interface PromptTypeStats {
  /** Type of prompt */
  promptType: string;
  /** Number of calls made */
  callCount: number;
  /** Total input tokens across all calls */
  totalInputTokens: number;
  /** Total output tokens across all calls */
  totalOutputTokens: number;
  /** Total tokens across all calls */
  totalTokens: number;
  /** Average input tokens per call */
  avgInputTokens: number;
  /** Average output tokens per call */
  avgOutputTokens: number;
  /** Average duration per call in milliseconds */
  avgDurationMs: number;
  /** Success rate (0-1) */
  successRate: number;
}

/**
 * Aggregated token statistics per model
 */
export interface ModelStats {
  /** Provider */
  provider: LLMProviderName;
  /** Model name */
  model: string;
  /** Number of calls made */
  callCount: number;
  /** Total input tokens */
  totalInputTokens: number;
  /** Total output tokens */
  totalOutputTokens: number;
  /** Total tokens */
  totalTokens: number;
  /** Average tokens per call */
  avgTokensPerCall: number;
  /** Success rate (0-1) */
  successRate: number;
}

/**
 * Complete token statistics for a game tick
 */
export interface TickTokenStats {
  /** Tick identifier (timestamp-based) */
  tickId: string;
  /** Timestamp when tick started */
  tickStartedAt: Date;
  /** Timestamp when tick completed */
  tickCompletedAt: Date;
  /** Duration of the tick in milliseconds */
  tickDurationMs: number;

  // Aggregate totals
  /** Total number of LLM calls made */
  totalCalls: number;
  /** Total input tokens used */
  totalInputTokens: number;
  /** Total output tokens used */
  totalOutputTokens: number;
  /** Total tokens used */
  totalTokens: number;

  // Breakdown by prompt type
  /** Statistics per prompt type */
  byPromptType: PromptTypeStats[];

  // Breakdown by model
  /** Statistics per model */
  byModel: ModelStats[];

  // Individual calls (for detailed analysis)
  /** All individual LLM calls during this tick */
  calls: LLMCallTokenUsage[];
}

/**
 * Summary statistics for a time period
 */
export interface TokenStatsSummary {
  /** Period start timestamp */
  periodStart: Date;
  /** Period end timestamp */
  periodEnd: Date;
  /** Number of ticks in period */
  tickCount: number;

  // Aggregate totals
  /** Total LLM calls */
  totalCalls: number;
  /** Total input tokens */
  totalInputTokens: number;
  /** Total output tokens */
  totalOutputTokens: number;
  /** Total tokens */
  totalTokens: number;

  // Averages per tick
  /** Average calls per tick */
  avgCallsPerTick: number;
  /** Average input tokens per tick */
  avgInputTokensPerTick: number;
  /** Average output tokens per tick */
  avgOutputTokensPerTick: number;
  /** Average total tokens per tick */
  avgTotalTokensPerTick: number;

  // Breakdown by prompt type (aggregated)
  /** Statistics per prompt type (aggregated across all ticks) */
  byPromptType: PromptTypeStats[];

  // Breakdown by model (aggregated)
  /** Statistics per model (aggregated across all ticks) */
  byModel: ModelStats[];

  // Estimated costs (USD, approximate)
  /** Estimated cost for input tokens */
  estimatedInputCostUSD: number;
  /** Estimated cost for output tokens */
  estimatedOutputCostUSD: number;
  /** Estimated total cost */
  estimatedTotalCostUSD: number;
}

/**
 * Token usage collector interface for tracking calls during a tick
 */
export interface TokenUsageCollector {
  /** Record a completed LLM call */
  recordCall(usage: Omit<LLMCallTokenUsage, 'callId' | 'timestamp'>): void;
  /** Get all recorded calls */
  getCalls(): LLMCallTokenUsage[];
  /** Get aggregated statistics */
  getStats(): Omit<
    TickTokenStats,
    'tickId' | 'tickStartedAt' | 'tickCompletedAt' | 'tickDurationMs'
  >;
  /** Reset the collector for a new tick */
  reset(): void;
}

/**
 * Estimated token costs per 1M tokens (USD)
 * These are approximate and should be updated periodically
 */
export const TOKEN_COST_PER_MILLION: Record<
  string,
  { input: number; output: number }
> = {
  // Groq (very cheap)
  'openai/gpt-oss-120b': { input: 0.3, output: 0.3 },
  'llama-3.3-70b-versatile': { input: 0.59, output: 0.79 },
  'llama-3.1-8b-instant': { input: 0.05, output: 0.08 },
  'moonshotai/kimi-k2-instruct-0905': { input: 0.3, output: 0.3 },

  // OpenAI
  'gpt-5.1': { input: 2.5, output: 10.0 },
  'gpt-5-nano': { input: 0.15, output: 0.6 },
  'gpt-5.1-turbo': { input: 0.5, output: 1.5 },

  // Anthropic/Claude
  'claude-sonnet-4-5': { input: 3.0, output: 15.0 },
  'claude-haiku-4-5': { input: 0.25, output: 1.25 },
  'claude-opus-4-1': { input: 15.0, output: 75.0 },

  // Default fallback
  default: { input: 1.0, output: 3.0 },
};

/**
 * Calculate estimated cost for token usage
 */
export function calculateEstimatedCost(
  model: string,
  inputTokens: number,
  outputTokens: number
): { inputCostUSD: number; outputCostUSD: number; totalCostUSD: number } {
  const defaultCosts = { input: 1.0, output: 3.0 };
  const costs =
    TOKEN_COST_PER_MILLION[model] ??
    TOKEN_COST_PER_MILLION.default ??
    defaultCosts;
  const inputCostUSD = (inputTokens / 1_000_000) * costs.input;
  const outputCostUSD = (outputTokens / 1_000_000) * costs.output;

  return {
    inputCostUSD,
    outputCostUSD,
    totalCostUSD: inputCostUSD + outputCostUSD,
  };
}
