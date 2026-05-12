/**
 * Mock LLM Plugin for Framework Benchmarking
 *
 * Replaces all LLM model handlers with deterministic, zero-latency handlers
 * that return pre-computed valid JSON responses. This isolates framework
 * overhead from LLM latency for accurate performance measurement.
 */

import {
  type GenerateTextParams,
  type IAgentRuntime,
  type Memory,
  ModelType,
  type Plugin,
  type Provider,
  type State,
} from "@elizaos/core";

// ─── Mock response constants ───────────────────────────────────────────────

/** Response for shouldRespond evaluations (TEXT_SMALL / dynamicPromptExec) */
const SHOULD_RESPOND_JSON = JSON.stringify({
  name: "BenchmarkAgent",
  reasoning: "The message is directed at me. I should respond.",
  action: "RESPOND",
});

/** Response for main message handler (TEXT_LARGE / dynamicPromptExec) */
const MESSAGE_HANDLER_JSON = JSON.stringify({
  thought: "Processing benchmark message. Will reply with a fixed response.",
  actions: ["REPLY"],
  providers: [],
  text: "This is a fixed benchmark response from the mock LLM plugin.",
  simple: true,
});

/** Response for reply action (TEXT_LARGE direct calls) */
const REPLY_ACTION_JSON = JSON.stringify({
  thought: "Generating a reply for the benchmark.",
  text: "Fixed reply from mock LLM plugin.",
});

/** Multi-step decision response (marks task as finished immediately) */
const MULTI_STEP_DECISION_JSON = JSON.stringify({
  thought: "The task is straightforward, completing immediately.",
  action: null,
  providers: [],
  isFinish: true,
});

/** Multi-step summary response */
const MULTI_STEP_SUMMARY_JSON = JSON.stringify({
  thought: "Summarizing benchmark run.",
  text: "Benchmark multi-step task completed successfully.",
});

/** Reflection evaluator response */
const REFLECTION_JSON = JSON.stringify({
  thought: "Benchmark interaction processed normally.",
  facts: [],
  relationships: [],
});

/** Fixed 384-dimension embedding vector (all zeros). Frozen to prevent mutation. */
const ZERO_EMBEDDING: readonly number[] = Object.freeze(
  new Array(384).fill(0),
) as readonly number[];

// ─── Handler implementations ───────────────────────────────────────────────

/**
 * Detect which template/context is being used and return appropriate response.
 * The prompt string contains template markers we can match against.
 */
function detectAndRespondTextLarge(
  _runtime: IAgentRuntime,
  params: GenerateTextParams,
): string {
  const prompt = String(params.prompt ?? "");

  // Multi-step decision template
  if (prompt.includes("Multi-Step Workflow") || prompt.includes("isFinish")) {
    return MULTI_STEP_DECISION_JSON;
  }

  // Multi-step summary template
  if (
    prompt.includes("Execution Trace") ||
    prompt.includes("Summarize what the assistant")
  ) {
    return MULTI_STEP_SUMMARY_JSON;
  }

  // Reflection evaluator template
  if (
    prompt.includes("Generate Agent Reflection") ||
    prompt.includes("Extract Facts")
  ) {
    return REFLECTION_JSON;
  }

  // Reply action template
  if (
    prompt.includes("Generate dialog for the character") &&
    !prompt.includes("decide what actions")
  ) {
    return REPLY_ACTION_JSON;
  }

  // Default: message handler response
  return MESSAGE_HANDLER_JSON;
}

function detectAndRespondTextSmall(
  _runtime: IAgentRuntime,
  params: GenerateTextParams,
): string {
  const prompt = String(params.prompt ?? "");

  // ShouldRespond template
  if (
    prompt.includes("should respond") ||
    prompt.includes("RESPOND | IGNORE | STOP")
  ) {
    return SHOULD_RESPOND_JSON;
  }

  // Boolean footer (yes/no responses)
  if (prompt.includes("Respond with only a YES or a NO")) {
    return "YES";
  }

  // Post generation
  if (prompt.includes("Generate dialog")) {
    return MESSAGE_HANDLER_JSON;
  }

  // Default for small model
  return SHOULD_RESPOND_JSON;
}

// ─── Dummy providers for scaling tests ──────────────────────────────────────

/** Create N dummy providers that return minimal static data */
export function createDummyProviders(count: number): Provider[] {
  const providers: Provider[] = [];
  for (let i = 0; i < count; i++) {
    providers.push({
      name: `BENCHMARK_DUMMY_${i}`,
      description: `Dummy provider #${i} for benchmark scaling tests`,
      get: async (
        _runtime: IAgentRuntime,
        _message: Memory,
        _state?: State,
      ) => {
        return {
          text: `Dummy provider ${i} context data.`,
          values: { [`dummy_${i}`]: `value_${i}` },
          data: {},
        };
      },
    });
  }
  return providers;
}

// ─── Plugin definition ──────────────────────────────────────────────────────

export const mockLlmPlugin: Plugin = {
  name: "mock-llm-benchmark",
  description:
    "Deterministic zero-latency mock LLM handlers for framework benchmarking",
  models: {
    [ModelType.TEXT_SMALL]: async (
      runtime: IAgentRuntime,
      params: GenerateTextParams,
    ): Promise<string> => {
      return detectAndRespondTextSmall(runtime, params);
    },

    [ModelType.TEXT_LARGE]: async (
      runtime: IAgentRuntime,
      params: GenerateTextParams,
    ): Promise<string> => {
      return detectAndRespondTextLarge(runtime, params);
    },

    [ModelType.TEXT_EMBEDDING]: async (
      _runtime: IAgentRuntime,
      _params: unknown,
    ): Promise<number[]> => {
      return [...ZERO_EMBEDDING];
    },

    [ModelType.TEXT_COMPLETION]: async (
      runtime: IAgentRuntime,
      params: GenerateTextParams,
    ): Promise<string> => {
      return detectAndRespondTextLarge(runtime, params);
    },
  },
};
