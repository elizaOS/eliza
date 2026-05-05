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
      "claude_code_workbench:",
      `  available: ${status.available}`,
      `  running: ${status.running}`,
      `  workspaceRoot: ${status.workspaceRoot}`,
      `  timeoutMs: ${status.timeoutMs}`,
      `  maxOutputChars: ${status.maxOutputChars}`,
      `  mutatingWorkflowsEnabled: ${status.enableMutatingWorkflows}`,
      `workflows[${status.workflows.length}]{id,title,category,mutatesRepo,enabled,description}:`,
      ...status.workflows.map((workflow) =>
        [
          `  ${workflow.id}`,
          workflow.title,
          workflow.category,
          String(workflow.mutatesRepo),
          String(workflow.enabled),
          workflow.description.replace(/\s+/g, " ").trim(),
        ].join(","),
      ),
    ];

    if (status.lastRunAt) {
      lines.push("lastRun:");
      lines.push(`  at: ${new Date(status.lastRunAt).toISOString()}`);
    }
    if (status.lastWorkflow) {
      lines.push(`  workflow: ${status.lastWorkflow}`);
    }
    if (typeof status.lastExitCode !== "undefined") {
      lines.push(`  exitCode: ${String(status.lastExitCode)}`);
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
