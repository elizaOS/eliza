import type { AgentRuntime } from "@elizaos/core";

export async function prepareMockedTestEnvironment(opts?: {
  plugins?: unknown[];
}): Promise<{ runtime: AgentRuntime; cleanup: () => Promise<void> }> {
  throw new Error(
    "prepareMockedTestEnvironment is a stub — implement when scenario tests are fleshed out",
  );
}
