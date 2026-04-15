import type {
  Action,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import type { ComputerUseService } from "../services/computer-use-service.js";
import type { TerminalActionParams as ServiceTerminalActionParams } from "../types.js";
import {
  clearTerminal,
  connectTerminal,
  executeCommand,
  executeTerminal,
  readTerminal,
  typeTerminal,
  closeTerminal,
} from "../platform/terminal.js";

type TerminalActionType =
  | "terminal_connect"
  | "terminal_execute"
  | "terminal_read"
  | "terminal_type"
  | "terminal_clear"
  | "terminal_close"
  | "execute_command";

interface TerminalActionParams {
  action: TerminalActionType;
  cwd?: string;
  command?: string;
  timeout?: number;
  session_id?: string;
  text?: string;
}

type TerminalActionResult = {
  success: boolean;
  output?: string;
  message?: string;
  error?: string;
  exit_code?: number;
  session_id?: string;
  cwd?: string;
  [key: string]: unknown;
};

function normalizeTerminalParams(message: Memory, options?: HandlerOptions): TerminalActionParams {
  const params = ((options as Record<string, unknown>)?.parameters ?? {}) as Partial<TerminalActionParams>;

  if (!params.action && message.content && typeof message.content === "object") {
    Object.assign(params, message.content as Record<string, unknown>);
  }

  params.action = params.action ?? "terminal_execute";
  return params as TerminalActionParams;
}

export const terminalAction: Action = {
  name: "TERMINAL_ACTION",

  similes: [
    "TERMINAL",
    "SHELL",
    "COMMAND_LINE",
    "RUN_COMMAND",
    "EXECUTE_COMMAND",
    "TYPING_TERMINAL",
    "COMMAND_PROMPT",
  ],

  description:
    "Control a local terminal session for shell access, project inspection, package management, test runs, " +
    "git workflows, and other command-line tasks that are not exposed in the UI.\n\n" +
    "Available actions:\n" +
    "- terminal_connect: Create a terminal session in a working directory. Use to establish session state.\n" +
    "- terminal_execute: Run a shell command in the session cwd and capture output.\n" +
    "- execute_command: Alias for terminal_execute.\n" +
    "- terminal_read: Read the latest captured output from the session.\n" +
    "- terminal_type: Queue text for a session without executing it yet.\n" +
    "- terminal_clear: Clear the session input/output buffer.\n" +
    "- terminal_close: Close the session and discard its state.\n\n" +
    "Use this when work requires the local shell, running tests, reading logs, or manipulating files via commands.",

  parameters: [
    {
      name: "action",
      description: "The terminal action to perform",
      required: true,
      schema: {
        type: "string",
        enum: [
          "terminal_connect",
          "terminal_execute",
          "terminal_read",
          "terminal_type",
          "terminal_clear",
          "terminal_close",
          "execute_command",
        ],
      },
    },
    {
      name: "cwd",
      description: "Working directory for terminal_connect.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "command",
      description: "Shell command to execute.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "timeout",
      description: "Command timeout in seconds.",
      required: false,
      schema: { type: "number" },
    },
    {
      name: "session_id",
      description: "Terminal session identifier.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "text",
      description: "Text to queue with terminal_type.",
      required: false,
      schema: { type: "string" },
    },
  ],

  examples: [
    [
      {
        name: "{{user1}}",
        content: { text: "Run the test suite in the project root." },
      },
      {
        name: "{{agentName}}",
        content: { text: "I'll use the terminal to run the tests.", action: "TERMINAL_ACTION" },
      },
    ],
  ],

  validate: async (): Promise<boolean> => true,

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    options?: HandlerOptions,
    callback?: HandlerCallback,
  ) => {
    const params = normalizeTerminalParams(message, options);
    const service = runtime.getService?.("computeruse") as unknown as ComputerUseService | undefined;

    if (service) {
      const result = await service.executeTerminalAction(params as unknown as ServiceTerminalActionParams);

      if (callback) {
        const output = typeof result.output === "string" ? result.output.trim() : "";
        await callback({
          text: result.success
            ? output || (typeof result.message === "string" ? result.message : "Terminal action completed.")
            : result.approvalRequired
              ? `Terminal action is waiting for approval (${result.approvalId}).`
              : `Terminal action failed: ${String(result.error ?? "unknown error")}`,
        });
      }

      return result;
    }

    let result: any;
    switch (params.action) {
      case "terminal_connect":
        result = connectTerminal({ cwd: params.cwd });
        break;
      case "terminal_execute":
        result = await executeTerminal({
          command: params.command ?? "",
          timeout: params.timeout,
          session_id: params.session_id,
        });
        break;
      case "execute_command":
        result = await executeCommand({
          command: params.command ?? "",
          timeout: params.timeout,
          session_id: params.session_id,
        });
        break;
      case "terminal_read":
        result = readTerminal({ session_id: params.session_id });
        break;
      case "terminal_type":
        result = typeTerminal({
          text: params.text ?? "",
          session_id: params.session_id,
        });
        break;
      case "terminal_clear":
        result = clearTerminal({ session_id: params.session_id });
        break;
      case "terminal_close":
        result = closeTerminal({ session_id: params.session_id });
        break;
      default:
        result = { success: false, error: `Unknown terminal action: ${params.action}` };
        break;
    }

    if (callback) {
      const output = typeof result.output === "string" ? result.output.trim() : "";
      await callback({
        text: result.success
          ? output || (typeof result.message === "string" ? result.message : "Terminal action completed.")
          : `Terminal action failed: ${String(result.error ?? "unknown error")}`,
      });
    }

    return result as any;
  },
};

export { executeCommand, executeTerminal };
