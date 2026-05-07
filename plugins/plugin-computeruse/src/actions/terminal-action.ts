import type {
  Action,
  ActionResult,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import type { ComputerUseService } from "../services/computer-use-service.js";
import type { TerminalActionParams, TerminalActionResult } from "../types.js";
import { resolveActionParams, toComputerUseActionResult } from "./helpers.js";

function formatTerminalResultText(result: TerminalActionResult): string {
  return result.success
    ? (result.output ?? result.message ?? "Terminal action completed.")
    : `Terminal action failed: ${result.error}`;
}

export const terminalAction: Action = {
  name: "TERMINAL_ACTION",
  contexts: ["terminal", "code", "automation"],
  contextGate: { anyOf: ["terminal", "code", "automation"] },
  roleGate: { minRole: "USER" },
  similes: [
    "RUN_COMMAND",
    "EXECUTE_COMMAND",
    "SHELL_COMMAND",
    "TERMINAL",
    "RUN_SHELL",
  ],
  description:
    "Execute terminal commands and manage lightweight terminal sessions through the computer-use service. This includes connect, execute, read, type, clear, close, and the upstream execute_command alias.\n\n" +
    "Why this exists: it gives the agent shell access through the same safety and approval layer as the other computer-use tools.",
  descriptionCompressed:
    "Terminal ops: open, exec, read, type, kill, list, switch, send-input, get-output.",
  suppressPostActionContinuation: true,
  parameters: [
    {
      name: "action",
      description: "Terminal action to perform.",
      required: true,
      schema: {
        type: "string",
        enum: [
          "connect",
          "execute",
          "read",
          "type",
          "clear",
          "close",
          "execute_command",
        ],
      },
    },
    {
      name: "command",
      description: "Shell command for execute or execute_command.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "cwd",
      description: "Working directory for connect or execute.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "sessionId",
      description: "Session ID alias.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "session_id",
      description: "Upstream session ID alias.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "text",
      description: "Text for terminal type.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "timeout",
      description: "Timeout in seconds.",
      required: false,
      schema: { type: "number", default: 30 },
    },
    {
      name: "timeoutSeconds",
      description: "Alias for timeout.",
      required: false,
      schema: { type: "number", default: 30 },
    },
  ],
  validate: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
  ): Promise<boolean> => {
    const service =
      (runtime.getService("computeruse") as unknown as ComputerUseService) ??
      null;
    return !!service && service.getCapabilities().terminal.available;
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    options?: HandlerOptions,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const service =
      (runtime.getService("computeruse") as unknown as ComputerUseService) ??
      null;
    if (!service) {
      return { success: false, error: "ComputerUseService not available" };
    }

    const params = resolveActionParams<TerminalActionParams>(message, options);
    if (!params.action && params.command) {
      params.action = "execute";
    }
    if (!params.action) {
      if (callback) {
        await callback({ text: "Terminal action requires an action." });
      }
      return { success: false, error: "Missing action" };
    }

    const result = await service.executeTerminalAction(params);
    const text = formatTerminalResultText(result);

    if (callback) {
      await callback({ text });
    }

    return toComputerUseActionResult({
      action: params.action,
      result,
      text,
      suppressClipboard: true,
    });
  },
};
