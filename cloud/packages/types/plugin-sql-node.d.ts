declare module "@elizaos/plugin-sql/node" {
  import type { IDatabaseAdapter } from "@elizaos/core";
  export function createDatabaseAdapter(
    config: { postgresUrl: string },
    agentId: string,
  ): IDatabaseAdapter;
  const plugin: unknown;
  export default plugin;
}
