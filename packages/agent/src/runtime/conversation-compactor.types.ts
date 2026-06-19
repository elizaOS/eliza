/**
 * Shared type contract for conversation-history compactors.
 *
 * Distinct from prompt-compaction.ts (presentation-layer regex stripping).
 * A Compactor takes a multi-turn transcript and returns a smaller artifact
 * that preserves the load-bearing facts, decisions, and tool-call/tool-result
 * pairs needed for the agent to continue coherently.
 *
 * Mirrors the shape used by CompactBench
 * (https://github.com/compactbench/compactbench) so our compactors can be
 * benchmarked through that harness without per-method shims.
 */

export type CompactorRole =
  | "system"
  | "developer"
  | "user"
  | "assistant"
  | "tool";

export type CompactorToolCall = {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
};

export type CompactorMessage = {
  role: CompactorRole;
  /** Plain text content. Multi-modal blocks are flattened to text upstream. */
  content: string;
  /** For assistant messages that invoke tools. */
  toolCalls?: CompactorToolCall[];
  /** For tool-role messages, the id of the assistant tool_call this answers. */
  toolCallId?: string;
  /** Tool name, mirrored on tool-role messages for readability/auditing. */
  toolName?: string;
  /** Optional epoch ms — used for time-aware summarization, not required. */
  timestamp?: number;
  /** Free-form tags propagated by the runtime (e.g. "thought", "observation"). */
  tags?: string[];
};

export type CompactorTranscript = {
  /** All messages in chronological order. The system prompt, if present, is index 0. */
  messages: CompactorMessage[];
  /** Free-form metadata (scenario id, agent name, intent, etc.). */
  metadata?: Record<string, unknown>;
};

export type CompactionStats = {
  originalMessageCount: number;
  compactedMessageCount: number;
  /** Approximate token counts using the configured counter. */
  originalTokens: number;
  compactedTokens: number;
  /** Model id used for summarization, if the strategy called a model. */
  summarizationModel?: string;
  /** End-to-end wall time in ms. */
  latencyMs: number;
  /** Strategy-specific telemetry — never assume keys; for inspection only. */
  extra?: Record<string, unknown>;
};

export type CompactionArtifact = {
  /**
   * Replacement messages for the compacted region. The runtime concatenates
   * these in place of the messages that were summarized; tail messages
   * (within `preserveTailMessages`) remain untouched.
   */
  replacementMessages: CompactorMessage[];
  stats: CompactionStats;
};

/**
 * Token counter callback. Implementations may use tiktoken, a model API,
 * or a heuristic (4 chars per token). Must be deterministic for a given input.
 */
export type TokenCounter = (text: string) => number;

/**
 * Model invocation callback used by summarization-based compactors.
 * Should return the raw text response. Errors propagate.
 */
export type CompactorModelCall = (params: {
  systemPrompt: string;
  messages: CompactorMessage[];
  /** Hard cap on response tokens; implementations may ignore. */
  maxOutputTokens?: number;
}) => Promise<string>;

export type CompactorOptions = {
  /** Soft target token budget for the compacted artifact. */
  targetTokens: number;
  /**
   * Number of trailing messages to preserve verbatim. Default 6.
   * Tool-call/tool-result pairs that straddle this boundary are kept paired
   * (the compactor may shift the boundary outward to avoid splitting a pair).
   */
  preserveTailMessages?: number;
  /** Token counter; defaults to a 4-chars-per-token heuristic if omitted. */
  countTokens?: TokenCounter;
  /** Required for summarization-based strategies; optional for stripping ones. */
  callModel?: CompactorModelCall;
  /** Model id to record in stats — does not change `callModel` behavior. */
  summarizationModel?: string;
};

export interface Compactor {
  readonly name: string;
  readonly version: string;
  compact(
    transcript: CompactorTranscript,
    options: CompactorOptions,
  ): Promise<CompactionArtifact>;
}

/** 4-chars-per-token heuristic. Cheap, deterministic, model-agnostic. */
export function approxCountTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Sum of approximate tokens across all message contents and tool args. */
export function countTranscriptTokens(
  transcript: CompactorTranscript,
  counter: TokenCounter = approxCountTokens,
): number {
  let total = 0;
  for (const m of transcript.messages) {
    total += counter(m.content);
    if (m.toolCalls) {
      for (const tc of m.toolCalls) {
        total += counter(tc.name);
        total += counter(JSON.stringify(tc.arguments));
      }
    }
  }
  return total;
}
