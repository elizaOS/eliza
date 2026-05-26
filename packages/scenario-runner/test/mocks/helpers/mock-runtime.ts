import type { AgentRuntime } from "@elizaos/core";

export async function prepareMockedTestEnvironment(opts?: {
  plugins?: unknown[];
  seedLifeOpsSimulator?: boolean;
}): Promise<{
  applyRuntimeFixtures?: (
    runtime: AgentRuntime,
  ) => Promise<(() => Promise<void>) | void>;
  cleanup: () => Promise<void>;
}> {
  void opts;
  return {
    applyRuntimeFixtures: async () => undefined,
    cleanup: async () => undefined,
  };
}
