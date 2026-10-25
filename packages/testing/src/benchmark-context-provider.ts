import type { IAgentRuntime, Memory, Provider, State } from "@elizaos/core";

/** Explicit benchmark-only context. Production assistant composition never registers it. */
export const contextBenchProvider: Provider = {
  name: "CONTEXT_BENCH",
  description: "Benchmark/task context injected by a benchmark harness",
  position: 5,
  alwaysInResponseState: true,
  contexts: ["general"],
  contextGate: { anyOf: ["general"] },
  cacheStable: false,
  cacheScope: "turn",
  roleGate: { minRole: "USER" },
  get: async (_runtime: IAgentRuntime, message: Memory, _state: State) => {
    const metadata = message.metadata;
    const benchmarkContext =
      metadata && "benchmarkContext" in metadata
        ? metadata.benchmarkContext
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
