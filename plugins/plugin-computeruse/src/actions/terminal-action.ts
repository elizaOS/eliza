import type {
  Action,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import type { TerminalActionParams } from "../types.js";
import type { ComputerUseService } from "../services/computer-use-service.js";
import { resolveActionParams } from "./helpers.js";

export const terminalAction: Action = {
  name: "TERMINAL_ACTION",
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
  ) => {
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

    if (callback) {
      await callback({
        text: result.success
          ? result.output ?? result.message ?? "Terminal action completed."
          : `Terminal action failed: ${result.error}`,
      });
    }

    return result as unknown as any;
  },
};
