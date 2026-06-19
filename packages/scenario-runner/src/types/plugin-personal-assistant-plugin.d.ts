declare module "@elizaos/plugin-personal-assistant/plugin" {
  import type { AgentRuntime, Plugin } from "@elizaos/core";

  export const personalAssistantPlugin: Plugin;
  export function executeLifeOpsSchedulerTask(
    runtime: AgentRuntime,
    options: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
}
