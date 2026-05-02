import {
  type Action,
  type ActionResult,
  type HandlerCallback,
  type IAgentRuntime,
  logger,
  type Memory,
  type State,
} from "@elizaos/core";
import type {
  ClaudeCodeWorkbenchService,
  WorkbenchRunInput,
  WorkbenchRunResult,
} from "../services/workbench-service.ts";

interface WorkbenchRunActionOptions extends Record<string, unknown> {
  workflow?: string;
  cwd?: string;
  stdin?: string;
}

function normalizeString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

export function extractRunInput(
  message: Memory,
  options: WorkbenchRunActionOptions,
): WorkbenchRunInput | null {
  const workflow = normalizeString(options.workflow);
  const base: WorkbenchRunInput = {
    workflow: workflow ?? "",
    cwd: normalizeString(options.cwd),
    stdin: normalizeString(options.stdin),
  };

  if (workflow) {
    return base;
  }

  const rawText = normalizeString(message.content?.text);
  if (!rawText) {
    return null;
  }

  const match = rawText.match(
    /^(?:\/)?(?:workbench|claude-workbench|ccw)\s+(?:run\s+)?([a-zA-Z0-9._-]+)/i,
  );
  if (!match?.[1]) {
    return null;
  }

  return {
    ...base,
    workflow: match[1],
  };
}

function summarizeResult(result: WorkbenchRunResult): string {
  const status = result.ok
    ? `✅ Workflow ${result.workflow} completed.`
    : `❌ Workflow ${result.workflow} failed.`;

  const outputSource = (
    result.ok ? result.stdout : result.stderr || result.stdout
  ).trim();

  if (!outputSource) {
    return status;
  }

  const preview = outputSource.slice(0, 800);
  const suffix = outputSource.length > 800 ? "\n…" : "";
  return `${status}\n\n${preview}${suffix}`;
}

export const claudeCodeWorkbenchRunAction: Action = {
  name: "CLAUDE_CODE_WORKBENCH_RUN",
  similes: ["RUN_WORKBENCH_WORKFLOW", "WORKBENCH_RUN", "CCW_RUN"],
  description:
    "Run an allowlisted repo workflow through the Claude Code workbench service.",

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

    const runInput = extractRunInput(
      message,
      options as WorkbenchRunActionOptions,
    );

    if (!runInput) {
      const error =
        "No workflow provided. Pass `workflow` in options or use message text like `workbench run check`.";
      if (callback) {
        await callback({ text: error, source: message.content.source });
      }
      return { success: false, error };
    }

    try {
      const result = await service.run(runInput);
      const text = summarizeResult(result);

      if (callback) {
        await callback({ text, source: message.content.source });
      }

      return {
        success: result.ok,
        text,
        data: { ...result },
        ...(result.ok
          ? {}
          : {
              error:
                result.stderr ||
                `Workflow ${result.workflow} exited with code ${String(result.exitCode)}`,
            }),
      };
    } catch (error) {
      const messageText =
        error instanceof Error
          ? error.message
          : `Unknown workbench error: ${String(error)}`;
      logger.error(`CLAUDE_CODE_WORKBENCH_RUN failed: ${messageText}`);

      if (callback) {
        await callback({ text: messageText, source: message.content.source });
      }

      return {
        success: false,
        error: messageText,
      };
    }
  },

  examples: [
    [
      {
        name: "{{name1}}",
        content: {
          text: "workbench run check",
        },
      },
      {
        name: "{{name2}}",
        content: {
          text: "✅ Workflow check completed.",
          actions: ["CLAUDE_CODE_WORKBENCH_RUN"],
        },
      },
    ],
  ],
};
