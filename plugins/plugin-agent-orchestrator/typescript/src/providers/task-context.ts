import type { IAgentRuntime, Memory, Provider, ProviderResult, State } from "@elizaos/core";
import type { AgentOrchestratorService } from "../services/agent-orchestrator-service.js";

async function getService(runtime: IAgentRuntime): Promise<AgentOrchestratorService | null> {
  return (await runtime.getService("CODE_TASK")) as AgentOrchestratorService | null;
}

function formatStatus(status: string): string {
  switch (status) {
    case "pending":
      return "⏳ pending";
    case "running":
      return "🔄 running";
    case "paused":
      return "⏸️ paused";
    case "completed":
      return "✅ completed";
    case "failed":
      return "❌ failed";
    case "cancelled":
      return "🛑 cancelled";
    default:
      return status;
  }
}

export const taskContextProvider: Provider = {
  name: "TASK_CONTEXT",
  description: "Summary of orchestrated tasks and current selection",
  dynamic: true,
  get: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
  ): Promise<ProviderResult> => {
    const svc = await getService(runtime);
    if (!svc) {
      return { text: "Task service not available." };
    }

    const current = await svc.getCurrentTask();
    const tasks = await svc.getRecentTasks(10);

    if (tasks.length === 0) {
      return { text: "No tasks have been created yet." };
    }

    const lines: string[] = [];
    if (current) {
      lines.push(`## Current Task`);
      lines.push(`- Name: ${current.name}`);
      lines.push(`- Status: ${formatStatus(current.metadata.status)}`);
      lines.push(`- Progress: ${current.metadata.progress}%`);
      lines.push(`- Provider: ${current.metadata.providerLabel ?? current.metadata.providerId}`);
      lines.push("");
    }

    lines.push("## Recent Tasks");
    for (const t of tasks) {
      const marker = current?.id === t.id ? " (current)" : "";
      lines.push(
        `- ${t.name} — ${formatStatus(t.metadata.status)} ${t.metadata.progress}%${marker}`,
      );
    }

    return { text: lines.join("\n").trim() };
  },
};
