/** Registers the explicit SQLite adapter for one agent and one state path. */
import {
  ElizaError,
  type IAgentRuntime,
  type IDatabaseAdapter,
  type Plugin,
} from "@elizaos/core";
import { SQLiteDatabaseAdapter } from "./adapter";

export { SQLiteDatabaseAdapter } from "./adapter";
export { SQLiteStorage } from "./storage";

export const plugin: Plugin = {
  name: "@elizaos/plugin-sqlite",
  description: "Durable per-agent SQLite storage",
  async init(
    _config: Record<string, string>,
    runtime: IAgentRuntime,
  ): Promise<void> {
    const path = runtime.getSetting("SQLITE_DATABASE_PATH");
    if (typeof path !== "string" || !path)
      throw new ElizaError(
        "Set an absolute SQLITE_DATABASE_PATH before enabling SQLite storage",
        { code: "SQLITE_PATH_REQUIRED" },
      );
    const host = runtime as IAgentRuntime & {
      registerDatabaseAdapter?: (adapter: IDatabaseAdapter) => void;
      hasDatabaseAdapter?: () => boolean;
    };
    if (typeof host.registerDatabaseAdapter !== "function")
      throw new ElizaError("Runtime cannot register a database adapter", {
        code: "SQLITE_ADAPTER_REGISTRATION_UNAVAILABLE",
      });
    if (runtime.adapter !== undefined || host.hasDatabaseAdapter?.())
      throw new ElizaError(
        "SQLite must be selected before another database adapter",
        { code: "SQLITE_ADAPTER_ALREADY_REGISTERED" },
      );
    const adapter = SQLiteDatabaseAdapter.create(path, runtime.agentId);
    await adapter.initialize();
    host.registerDatabaseAdapter(adapter);
  },
};
export default plugin;
