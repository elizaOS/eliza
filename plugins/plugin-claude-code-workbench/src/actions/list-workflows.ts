import type {
  Action,
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import type { ClaudeCodeWorkbenchService } from "../services/workbench-service.ts";

function toText(service: ClaudeCodeWorkbenchService): string {
  const workflows = service.listWorkflows();
  if (workflows.length === 0) {
    return "No workbench workflows are available.";
  }

  const lines = ["Available workbench workflows:"];
  for (const workflow of workflows) {
    const mutating = workflow.mutatesRepo ? " [mutates repo]" : "";
    const disabled = workflow.enabled ? "" : " [disabled]";
    lines.push(
      `- ${workflow.id}${mutating}${disabled}: ${workflow.description}`,
    );
  }

  return lines.join("\n");
}

export const claudeCodeWorkbenchListAction: Action = {
  name: "CLAUDE_CODE_WORKBENCH_LIST",
  similes: ["LIST_WORKBENCH_WORKFLOWS", "WORKBENCH_LIST", "CCW_LIST"],
  description: "List available Claude Code workbench workflows.",

  validate: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state: State | undefined,
  ): Promise<boolean> => {
    return Boolean(runtime.getService("claude_code_workbench"));
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state: State | undefined,
    _options: Record<string, unknown> = {},
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const service = runtime.getService(
      "claude_code_workbench",
    ) as ClaudeCodeWorkbenchService | null;

    if (!service) {
      const error =
        "Claude Code workbench service is not available. Ensure plugin-claude-code-workbench is enabled.";
      if (callback) {
        await callback({ text: error, source: message.content.source });
      }
      return { success: false, error };
    }

    const text = toText(service);

    if (callback) {
      await callback({ text, source: message.content.source });
    }

    return {
      success: true,
      text,
      data: { workflows: service.listWorkflows() },
    };
  },

  examples: [
    [
      {
        name: "{{name1}}",
        content: {
          text: "List workbench workflows",
        },
      },
      {
        name: "{{name2}}",
        content: {
          text: "Available workbench workflows:",
          actions: ["CLAUDE_CODE_WORKBENCH_LIST"],
        },
      },
    ],
  ],
};
