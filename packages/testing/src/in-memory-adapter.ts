/** Explicit ephemeral persistence for tests; production core never supplies it. */
import type { AgentRuntime } from "@elizaos/core";
import { InMemoryDatabaseAdapter } from "@elizaos/plugin-inmemorydb/runtime";

export { InMemoryDatabaseAdapter };

export async function initializeTestRuntime(
  runtime: AgentRuntime,
  options?: Parameters<AgentRuntime["initialize"]>[0],
): Promise<void> {
  if (!runtime.adapter) {
    runtime.registerDatabaseAdapter(
      new InMemoryDatabaseAdapter(runtime.agentId),
    );
  }
  await runtime.initialize(options);
}
