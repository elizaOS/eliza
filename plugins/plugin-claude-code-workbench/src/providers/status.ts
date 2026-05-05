import type {
  IAgentRuntime,
  Memory,
  Provider,
  ProviderResult,
  State,
} from "@elizaos/core";
import type { ClaudeCodeWorkbenchService } from "../services/workbench-service.ts";

export const claudeCodeWorkbenchStatusProvider: Provider = {
  name: "CLAUDE_CODE_WORKBENCH_STATUS",
  description:
    "Provides Claude Code workbench availability, workflow policy, and recent run metadata.",

  get: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state: State | undefined,
  ): Promise<ProviderResult> => {
    const service = runtime.getService(
      "claude_code_workbench",
    ) as ClaudeCodeWorkbenchService | null;

    if (!service) {
      return {
        text: "Claude Code workbench plugin is not active (service not found).",
        values: { workbenchAvailable: false },
        data: { available: false },
      };
    }

    const status = service.getStatus();

    const lines = [
      `Workbench availability: ${status.available ? "available" : "unavailable"}`,
      `Workflow count: ${status.workflows.length}`,
      `Workspace root: ${status.workspaceRoot}`,
      `Timeout: ${status.timeoutMs}ms`,
      `Output cap: ${status.maxOutputChars} chars`,
      `Mutating workflows: ${status.enableMutatingWorkflows ? "enabled" : "disabled"}`,
    ];

    if (status.lastRunAt) {
      lines.push(`Last run: ${new Date(status.lastRunAt).toISOString()}`);
    }
    if (status.lastWorkflow) {
      lines.push(`Last workflow: ${status.lastWorkflow}`);
    }
    if (typeof status.lastExitCode !== "undefined") {
      lines.push(`Last exit code: ${String(status.lastExitCode)}`);
    }

    return {
      text: lines.join("\n"),
      values: {
        workbenchAvailable: status.available,
        workbenchRunning: status.running,
      },
      data: { ...status },
    };
  },
};
