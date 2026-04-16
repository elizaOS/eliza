/**
 * TERMINAL_ACTION — execute shell commands, manage terminal sessions.
 *
 * Ported from coasty-ai/open-computer-use terminal.ts (Apache 2.0).
 */

import type {
  Action,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import type { ComputerUseService } from "../services/computer-use-service.js";
import {
  closeTerminal,
  connectTerminal,
  executeTerminal,
} from "../platform/terminal.js";

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
    "Execute terminal commands or manage terminal sessions.\n\n" +
    "Available actions:\n" +
    "- execute: Run a shell command. Requires command. Optional cwd, sessionId, timeoutSeconds.\n" +
    "- connect: Create a new terminal session with a working directory. Optional cwd.\n" +
    "- close: Close a terminal session. Optional sessionId (closes all if omitted).\n\n" +
    "Dangerous commands (rm -rf /, mkfs, fork bombs, etc.) are automatically blocked.\n" +
    "Output is capped at 5000 characters. Default timeout is 30 seconds.",

  parameters: [
    {
      name: "action",
      description: "Terminal action to perform",
      required: true,
      schema: {
        type: "string",
        enum: ["execute", "connect", "close"],
      },
    },
    {
      name: "command",
      description: "Shell command to execute (for execute action)",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "cwd",
      description: "Working directory (for execute and connect actions)",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "sessionId",
      description: "Terminal session ID (for execute with session, and close)",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "timeoutSeconds",
      description: "Command timeout in seconds (default 30)",
      required: false,
      schema: { type: "number", default: 30 },
    },
  ],

  examples: [
    [
      {
        name: "{{user1}}",
        content: { text: "Run 'ls -la' in the current directory" },
      },
      {
        name: "{{agentName}}",
        content: { text: "I'll run that command.", action: "TERMINAL_ACTION" },
      },
    ],
    [
      {
        name: "{{user1}}",
        content: { text: "Check the git status of this project" },
      },
      {
        name: "{{agentName}}",
        content: { text: "I'll run git status.", action: "TERMINAL_ACTION" },
      },
    ],
  ],

  validate: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
  ): Promise<boolean> => {
    const service =
      (runtime.getService("computeruse") as unknown as ComputerUseService) ??
      null;
    return !!service;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    options?: HandlerOptions,
    callback?: HandlerCallback,
  ) => {
    const params = ((options as Record<string, unknown>)?.parameters ?? {}) as {
      action?: string;
      command?: string;
      cwd?: string;
      sessionId?: string;
      timeoutSeconds?: number;
    };

    if (!params.action && message.content && typeof message.content === "object") {
      Object.assign(params, message.content);
    }

    if (!params.action) {
      if (params.command) {
        params.action = "execute";
      } else {
        if (callback) await callback({ text: "Terminal action required." });
        return { success: false, error: "Missing action" };
      }
    }

    let text = "";
    let success = false;

    switch (params.action) {
      case "execute": {
        if (!params.command) {
          text = "command is required for execute";
          break;
        }
        const r = await executeTerminal({
          command: params.command,
          sessionId: params.sessionId,
          cwd: params.cwd,
          timeoutSeconds: params.timeoutSeconds,
        });
        success = r.success;
        text = r.output || r.error || (r.success ? "Command completed." : "Command failed.");
        break;
      }
      case "connect": {
        const r = await connectTerminal(params.cwd);
        success = r.success;
        text = r.message ?? `Terminal session created (${r.sessionId})`;
        break;
      }
      case "close": {
        const r = await closeTerminal(params.sessionId);
        success = r.success;
        text = r.message ?? "Terminal session closed.";
        break;
      }
      default:
        text = `Unknown terminal action: ${params.action}`;
    }

    if (callback) {
      await callback({ text });
    }

    return { success };
  },
};
