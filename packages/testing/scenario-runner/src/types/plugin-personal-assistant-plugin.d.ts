declare module "@elizaos/plugin-personal-assistant/plugin" {
  import type { AgentRuntime, Plugin } from "@elizaos/core";

  export const personalAssistantPlugin: Plugin;
  export function executeLifeOpsSchedulerTask(
    runtime: AgentRuntime,
    options: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
  export function executeLifeOpsReminderTask(
    runtime: AgentRuntime,
    options: { now?: string; limit?: number },
  ): Promise<Record<string, unknown>>;
  export function processDueScheduledTasks(request: {
    runtime: AgentRuntime;
    agentId: string;
    now: Date;
    limit: number;
  }): Promise<Record<string, unknown>>;
  export function resetLifeOpsScenarioState(
    runtime: AgentRuntime,
  ): Promise<void>;
}
