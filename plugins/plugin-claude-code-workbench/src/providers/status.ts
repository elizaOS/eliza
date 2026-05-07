import type {
  IAgentRuntime,
  Memory,
  Provider,
  ProviderResult,
  State,
} from "@elizaos/core";
import type { ClaudeCodeWorkbenchService } from "../services/workbench-service.ts";
const WORKFLOW_LIMIT = 20;
const DESCRIPTION_LIMIT = 160;

export const claudeCodeWorkbenchStatusProvider: Provider = {
  name: "CLAUDE_CODE_WORKBENCH_STATUS",
  description:
    "Provides Claude Code workbench availability, workflow policy, and recent run metadata.",
  contexts: ["code", "automation", "agent_internal"],
  contextGate: { anyOf: ["code", "automation", "agent_internal"] },
  cacheStable: false,
  cacheScope: "turn",

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

    try {
      const status = service.getStatus();

    const lines = [
      "claude_code_workbench:",
      `  available: ${status.available}`,
      `  running: ${status.running}`,
      `  workspaceRoot: ${status.workspaceRoot}`,
      `  timeoutMs: ${status.timeoutMs}`,
      `  maxOutputChars: ${status.maxOutputChars}`,
      `  mutatingWorkflowsEnabled: ${status.enableMutatingWorkflows}`,
      `workflows[${Math.min(status.workflows.length, WORKFLOW_LIMIT)}]{id,title,category,mutatesRepo,enabled,description}:`,
      ...status.workflows.slice(0, WORKFLOW_LIMIT).map((workflow) =>
        [
          `  ${workflow.id}`,
          workflow.title,
          workflow.category,
          String(workflow.mutatesRepo),
          String(workflow.enabled),
          workflow.description.replace(/\s+/g, " ").trim().slice(0, DESCRIPTION_LIMIT),
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
        data: { ...status, workflows: status.workflows.slice(0, WORKFLOW_LIMIT) },
      };
    } catch (error) {
      return {
        text: "Claude Code workbench status unavailable.",
        values: { workbenchAvailable: false },
        data: {
          available: false,
          error: error instanceof Error ? error.message : String(error),
        },
      };
    }
  },
};
