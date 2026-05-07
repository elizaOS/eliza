import type {
  Action,
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import type { ClaudeCodeWorkbenchService } from "../services/workbench-service.ts";

function toText(
  service: ClaudeCodeWorkbenchService,
  includeDisabled: boolean,
): string {
  const workflows = service
    .listWorkflows()
    .filter((workflow) => includeDisabled || workflow.enabled);
  if (workflows.length === 0) {
    return "workbench_workflows[0]:";
  }

  const lines = [
    `workbench_workflows[${workflows.length}]{id,enabled,mutatesRepo,description}:`,
  ];
  for (const workflow of workflows) {
    lines.push(
      `  ${workflow.id},${workflow.enabled},${workflow.mutatesRepo},${workflow.description.replace(/\s+/g, " ").trim()}`,
    );
  }

  return lines.join("\n");
}

export const claudeCodeWorkbenchListAction: Action = {
  name: "CLAUDE_CODE_WORKBENCH_LIST",
  contexts: ["code", "automation", "agent_internal"],
  contextGate: { anyOf: ["code", "automation", "agent_internal"] },
  similes: ["LIST_WORKBENCH_WORKFLOWS", "WORKBENCH_LIST", "CCW_LIST"],
  description: "List available Claude Code workbench workflows.",
  descriptionCompressed: "list available Claude Code workbench workflow",

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
    options: Record<string, unknown> = {},
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

    const params =
      options.parameters && typeof options.parameters === "object"
        ? (options.parameters as { includeDisabled?: unknown })
        : (options as { includeDisabled?: unknown });
    const includeDisabled = params.includeDisabled !== false;
    const workflows = service
      .listWorkflows()
      .filter((workflow) => includeDisabled || workflow.enabled);
    const text = toText(service, includeDisabled);

    if (callback) {
      await callback({ text, source: message.content.source });
    }

    return {
      success: true,
      text,
      data: { workflows },
    };
  },

  parameters: [
    {
      name: "includeDisabled",
      description:
        "Whether to include disabled workbench workflows. Defaults to true.",
      required: false,
      schema: { type: "boolean" as const },
    },
  ],

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
