declare module "@elizaos/plugin-lifeops/plugin" {
  import type { AgentRuntime, Plugin } from "@elizaos/core";

  export const appLifeOpsPlugin: Plugin;
  export function executeLifeOpsSchedulerTask(
    runtime: AgentRuntime,
    options: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
}
