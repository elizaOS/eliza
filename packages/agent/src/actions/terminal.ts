/**
 * RUN_IN_TERMINAL action — runs a shell command on the server.
 *
 * When triggered the action:
 *   1. Extracts the command from the parameters
 *   2. POSTs to the local API server to execute it
 *   3. The API broadcasts output via WebSocket for real-time display
 *   4. Returns a descriptive text response
 *
 * @module actions/terminal
 */

import type { Action, HandlerOptions } from "@elizaos/core";

/** API port for posting terminal requests. */
const API_PORT = process.env.API_PORT || process.env.SERVER_PORT || "2138";

type ActionParams = Record<string, unknown>;

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function resolveCommandFromObject(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as ActionParams;

  const direct =
    nonEmptyString(record.command) ??
    nonEmptyString(record.cmd) ??
    nonEmptyString(record.commandLine) ??
    nonEmptyString(record.shellCommand);
  if (direct) return direct;

  const args = record.args;
  if (Array.isArray(args) && args.every((entry) => typeof entry === "string")) {
    const joined = args.join(" ").trim();
    if (joined) return joined;
  }

  const nested =
    resolveCommandFromObject(record.arguments) ??
    resolveCommandFromObject(record.input) ??
    resolveCommandFromObject(record.parameters);
  if (nested) return nested;

  return undefined;
}

function resolveCommandFromArguments(
  argumentsValue: unknown,
): string | undefined {
  if (typeof argumentsValue === "string") {
    const trimmed = argumentsValue.trim();
    if (!trimmed) return undefined;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      return resolveCommandFromObject(parsed) ?? trimmed;
    } catch {
      return trimmed;
    }
  }
  return resolveCommandFromObject(argumentsValue);
}

function resolveCommandFromParams(params: unknown): string | undefined {
  const record = params as ActionParams | undefined;
  if (!record || typeof record !== "object") return undefined;

  const direct =
    nonEmptyString(record.command) ??
    nonEmptyString(record.cmd) ??
    nonEmptyString(record.commandLine) ??
    nonEmptyString(record.shellCommand);
  if (direct) return direct;

  return (
    resolveCommandFromArguments(record.arguments) ??
    resolveCommandFromArguments(record.input) ??
    resolveCommandFromObject(record.parameters)
  );
}

function resolveCommandFromText(text: unknown): string | undefined {
  const source = nonEmptyString(text);
  if (!source) return undefined;

  const fenced = source.match(/```(?:bash|sh|zsh|shell)?\s*([\s\S]*?)```/i);
  if (fenced) {
    const command = nonEmptyString(fenced[1]);
    if (command) return command;
  }

  const inline = source.match(/`([^`\n]+)`/);
  if (inline) {
    const command = nonEmptyString(inline[1]);
    if (command) return command;
  }

  const runMatch = source.match(
    /\b(?:run|execute|exec)\b\s+(?:(?:the|this)\s+)?(?:(?:command|shell command)\s+)?["'`]?([^"'`\n]+?)["'`]?$/i,
  );
  if (runMatch) {
    const candidate = runMatch[1]
      .replace(/\s+(?:in|on)\s+(?:the\s+)?(?:terminal|shell)\b.*$/i, "")
      .replace(/[.?!,:;]+$/g, "")
      .trim();
    if (candidate) return candidate;
  }

  return undefined;
}

export const terminalAction: Action = {
  name: "RUN_IN_TERMINAL",

  similes: [
    "RUN_COMMAND",
    "EXECUTE_COMMAND",
    "TERMINAL",
    "SHELL",
    "RUN_SHELL",
    "EXEC",
    // Compatibility for upstream templates that may still emit CALL_MCP_TOOL.
    "CALL_MCP_TOOL",
    "CALL_TOOL",
  ],

  description:
    "Run a shell command in the user's terminal. Use this when the user asks " +
    "you to run a command, execute a script, install packages, or perform " +
    "any terminal operation. Output is shown in real time.",

  validate: async () => true,

  handler: async (_runtime, _message, _state, options) => {
    try {
      const params = (options as HandlerOptions | undefined)?.parameters;
      const command =
        resolveCommandFromParams(params) ??
        resolveCommandFromText(
          (_message as { content?: { text?: string } } | undefined)?.content
            ?.text,
        );

      if (!command) {
        return { text: "", success: false };
      }

      const response = await fetch(
        `http://localhost:${API_PORT}/api/terminal/run`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            command,
            clientId: "runtime-terminal-action",
          }),
        },
      );

      if (!response.ok) {
        return { text: "", success: false };
      }

      return {
        text: `Running in terminal: \`${command}\``,
        success: true,
        data: { command },
      };
    } catch (_err) {
      return { text: "", success: false };
    }
  },

  parameters: [
    {
      name: "command",
      description: "The shell command to execute in the terminal",
      required: true,
      schema: { type: "string" as const },
    },
  ],
};
