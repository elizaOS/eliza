import { requireProviderSpec } from "../../generated/spec-helpers.ts";
import type {
  IAgentRuntime,
  Memory,
  Provider,
  State,
} from "../../types/index.ts";

// Get text content from centralized specs
const spec = requireProviderSpec("CONTEXT_BENCH");

function hasBenchmarkContext(
  meta: Memory["metadata"] | undefined,
): meta is Memory["metadata"] & { benchmarkContext?: string } {
  return (
    typeof meta === "object" &&
    meta !== null &&
    "benchmarkContext" in meta &&
    (typeof (meta as { benchmarkContext?: string }).benchmarkContext ===
      "string" ||
      (meta as { benchmarkContext?: string }).benchmarkContext === undefined)
  );
}

/**
 * Benchmark context provider.
 *
 * If a benchmark harness attaches context to the inbound message metadata (as `benchmarkContext`),
 * this provider surfaces it to the model and sets `benchmark_has_context=true` in state.values.
 *
 * Python's message service uses `benchmark_has_context` to force REPLY/action execution so the
 * full Provider -> Model -> Action -> Evaluator loop is exercised during benchmarks.
 */
export const contextBenchProvider: Provider = {
  name: spec.name,
  description: spec.description,
  position: spec.position ?? 5,
  get: async (_runtime: IAgentRuntime, message: Memory, _state: State) => {
    const meta = message.metadata;
    const benchmarkContext = hasBenchmarkContext(meta)
      ? meta.benchmarkContext
      : undefined;

    if (
      typeof benchmarkContext !== "string" ||
      benchmarkContext.trim() === ""
    ) {
      return {
        text: "",
        values: {
          benchmark_has_context: false,
        },
        data: {},
      };
    }

    return {
      text: `# Benchmark Context\n${benchmarkContext.trim()}`,
      values: {
        benchmark_has_context: true,
      },
      data: {
        benchmarkContext: benchmarkContext.trim(),
      },
    };
  },
};
