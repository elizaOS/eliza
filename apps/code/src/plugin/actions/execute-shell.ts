import { exec } from "node:child_process";
import { promisify } from "node:util";
import {
  type Action,
  type ActionResult,
  type HandlerCallback,
  type HandlerOptions,
  type IAgentRuntime,
  logger,
  type Memory,
  type State,
} from "@elizaos/core";
import { createCommandError, formatErrorForDisplay } from "../../lib/errors.js";
import { getCwd } from "../providers/cwd.js";

const execAsync = promisify(exec);

function extractCommand(text: string): string {
  const patterns = [
    /(?:run|execute|exec)\s+["'`](.+?)["'`]/i,
    /(?:run|execute|exec)\s+(?:command\s+)?(.+?)(?:\.|$)/i,
    /\$\s*(.+)/,
    /```(?:bash|sh|shell)?\n(.+?)\n```/s,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) {
      return match[1].trim();
    }
  }

  return "";
}

export const executeShellAction: Action = {
  name: "EXECUTE_SHELL",
  similes: ["RUN_COMMAND", "SHELL", "EXEC", "TERMINAL", "BASH"],
  description: `Execute shell commands in the terminal with full system access.

USE THIS ACTION WHEN:
- User wants to run a specific command (npm, git, python, etc.)
- User says "run", "execute", "exec", or uses $ prefix
- User wants to install packages, run tests, start servers, or build projects
- User provides a command in backticks or code blocks

DO NOT USE WHEN:
- User wants to read file contents (use READ_FILE)
- User wants to list directory contents (use LIST_FILES)
- User wants git operations specifically (prefer GIT action for better parsing)
- User wants to search for text in files (use SEARCH_FILES)

SAFETY NOTES:
- Commands run with full user permissions
- Long-running commands timeout after 60 seconds
- Output is truncated at 5000 characters
- Working directory is the current CWD (see CHANGE_DIRECTORY)

SUPPORTED PATTERNS:
- Explicit: "run 'npm test'", "execute npm build"
- Shell prefix: "$ ls -la"
- Code blocks with bash/sh/shell language tags`,

  validate: async (
    _runtime: IAgentRuntime,
    message: Memory,
  ): Promise<boolean> => {
    const text = message.content.text?.toLowerCase() ?? "";
    return (
      text.includes("run") ||
      text.includes("execute") ||
      text.includes("shell") ||
      text.includes("command") ||
      text.includes("terminal") ||
      text.startsWith("$")
    );
  },

  handler: async (
    _runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: HandlerOptions,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const command = extractCommand(message.content.text ?? "");

    if (!command) {
      const msg = "Could not extract command. Please specify what to run.";
      await callback?.({ text: msg });
      return { success: false, text: msg };
    }

    const cwd = getCwd();

    try {
      const { stdout, stderr } = await execAsync(command, {
        cwd,
        timeout: 60000,
        maxBuffer: 10 * 1024 * 1024,
        env: { ...process.env, FORCE_COLOR: "0" },
      });

      let output = `$ ${command}\n`;
      if (stdout) output += stdout;
      if (stderr) output += `\nstderr:\n${stderr}`;

      const truncated =
        output.length > 5000
          ? `${output.substring(0, 5000)}\n...(truncated)`
          : output;
      const result = `\`\`\`\n${truncated}\n\`\`\``;

      await callback?.({ text: result });
      return {
        success: true,
        text: result,
        data: { command, exitCode: 0, stdout, stderr },
      };
    } catch (err) {
      const error = err as Error & {
        code?: number;
        stderr?: string;
        stdout?: string;
      };
      const cmdError = createCommandError(
        command,
        error.code ?? 1,
        error.stderr ?? error.message,
      );
      const errorMsg = formatErrorForDisplay(cmdError);

      logger.error(`EXECUTE_SHELL error: ${error.message}`);
      await callback?.({ text: errorMsg });

      return {
        success: false,
        text: errorMsg,
        data: { command, exitCode: error.code ?? 1 },
      };
    }
  },

  examples: [
    [
      { name: "{{user1}}", content: { text: "run 'npm test'" } },
      {
        name: "{{agent}}",
        content: { text: "Running npm test...", actions: ["EXECUTE_SHELL"] },
      },
    ],
    [
      { name: "{{user1}}", content: { text: "$ ls -la" } },
      {
        name: "{{agent}}",
        content: { text: "Executing...", actions: ["EXECUTE_SHELL"] },
      },
    ],
  ],
};
