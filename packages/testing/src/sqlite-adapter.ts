/** Supplies explicit temporary SQLite storage to real runtime tests. */
import { AgentRuntime } from "@elizaos/core";
import { SQLiteDatabaseAdapter } from "@elizaos/plugin-sqlite";

export { SQLiteDatabaseAdapter };

export async function initializeTestRuntime(
  runtime: AgentRuntime,
  options?: Parameters<AgentRuntime["initialize"]>[0],
): Promise<void> {
  if (!runtime.adapter) {
    runtime.registerDatabaseAdapter(
      SQLiteDatabaseAdapter.create(":memory:", runtime.agentId),
    );
  }
  await runtime.initialize(options);
}

/** Constructs a real runtime with an isolated SQLite database bound to its agent. */
export function createSQLiteTestRuntime(
  options: ConstructorParameters<typeof AgentRuntime>[0],
): AgentRuntime {
  const runtime = new AgentRuntime(options);
  if (!runtime.adapter) {
    runtime.registerDatabaseAdapter(
      SQLiteDatabaseAdapter.create(":memory:", runtime.agentId),
    );
  }
  return runtime;
}
