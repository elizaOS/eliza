/**
 * Configure coding tools - creates CodingAction instances for coding operations.
 *
 * This provides Claude Code-style actions:
 * - exec: Execute shell commands (via ShellService)
 * - process: Manage background processes (via ShellService)
 * - read_file: Read file contents
 * - write_file: Write file contents
 * - edit_file: Edit file contents (find & replace)
 * - list_files: List directory contents
 * - search_files: Search for patterns in files
 * - git: Execute git commands
 */

import type { IAgentRuntime } from "@elizaos/core";
import type { CoderService } from "./services/coderService";
import type {
  CodingAction,
  CodingActionContext,
  CodingActionResult,
  CodingToolsOptions,
  ProcessSession,
  ShellService,
} from "./types";

/**
 * Create configured coding actions using the provided services.
 *
 * @param runtime - The Eliza agent runtime
 * @param options - Configuration options for the tools
 * @returns Array of CodingAction instances
 */
export function configureCodingTools(
  runtime: IAgentRuntime,
  options?: CodingToolsOptions,
): CodingAction[] {
  const shellService = runtime.getService<ShellService>("shell");
  const coderService = runtime.getService<CoderService>("coder");

  const defaultCwd = options?.cwd ?? process.cwd();
  const scopeKey = options?.scopeKey;
  const sessionKey = options?.sessionKey;
  const notifyOnExit = options?.notifyOnExit ?? false;
  const defaultBackgroundMs = options?.backgroundMs ?? 10000;
  const defaultTimeoutSec = options?.timeoutSec ?? 1800;
  const conversationId = options?.conversationId ?? "default";

  const actions: CodingAction[] = [];

  // ============================================================================
  // exec - Execute shell commands
  // ============================================================================
  if (shellService) {
    const execAction: CodingAction = {
      name: "exec",
      label: "exec",
      description:
        "Execute a shell command. Returns output when complete or session info if backgrounded.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "Shell command to execute" },
          workdir: {
            type: "string",
            description: "Working directory (optional)",
          },
          env: {
            type: "object",
            additionalProperties: { type: "string" },
            description: "Environment variables (optional)",
          },
          yieldMs: {
            type: "number",
            description:
              "Milliseconds to wait before backgrounding (default 10000)",
          },
          background: {
            type: "boolean",
            description: "Run in background immediately",
          },
          timeout: { type: "number", description: "Timeout in seconds" },
          pty: {
            type: "boolean",
            description: "Use PTY for interactive commands",
          },
        },
        required: ["command"],
      },
      execute: async (
        context: CodingActionContext,
      ): Promise<CodingActionResult> => {
        const params = context.args as {
          command: string;
          workdir?: string;
          env?: Record<string, string>;
          yieldMs?: number;
          background?: boolean;
          timeout?: number;
          pty?: boolean;
        };

        if (!params.command) {
          throw new Error("Provide a command to execute.");
        }

        const result = await shellService.exec(params.command, {
          workdir: params.workdir?.trim() || defaultCwd,
          env: params.env,
          yieldMs: params.yieldMs ?? defaultBackgroundMs,
          background: params.background,
          timeout: params.timeout ?? defaultTimeoutSec,
          pty: params.pty,
          scopeKey,
          sessionKey,
          notifyOnExit,
          conversationId: context.conversationId ?? conversationId,
          onUpdate: context.onUpdate
            ? (session: ProcessSession) => {
                context.onUpdate?.({
                  content: [
                    {
                      type: "text",
                      text: session.tail || session.aggregated || "",
                    },
                  ],
                  details: {
                    status: "running",
                    sessionId: session.id,
                    pid: session.pid ?? undefined,
                    startedAt: session.startedAt,
                    cwd: session.cwd,
                    tail: session.tail,
                  },
                });
              }
            : undefined,
        });

        if (result.status === "running") {
          return {
            content: [
              {
                type: "text",
                text: `Command still running (session ${
                  result.sessionId
                }, pid ${
                  result.pid ?? "n/a"
                }). Use process action (list/poll/log/write/kill) for follow-up.`,
              },
            ],
            details: {
              status: "running",
              sessionId: result.sessionId,
              pid: result.pid ?? undefined,
              startedAt: result.startedAt,
              cwd: result.cwd,
              tail: result.tail,
            },
          };
        }

        if (result.status === "failed") {
          return {
            content: [
              {
                type: "text",
                text: result.aggregated || result.reason || "Command failed.",
              },
            ],
            details: {
              status: "failed",
              exitCode: result.exitCode ?? 1,
              durationMs: result.durationMs,
              reason: result.reason,
            },
          };
        }

        return {
          content: [
            {
              type: "text",
              text: result.aggregated || "(no output)",
            },
          ],
          details: {
            status: "completed",
            exitCode: result.exitCode ?? 0,
            durationMs: result.durationMs,
            aggregated: result.aggregated,
            cwd: result.cwd,
          },
        };
      },
    };
    actions.push(execAction);

    // ============================================================================
    // process - Manage background processes
    // ============================================================================
    const processAction: CodingAction = {
      name: "process",
      label: "process",
      description:
        "Manage running exec sessions: list, poll, log, write, send-keys, submit, paste, kill.",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            description:
              "Process action (list, poll, log, write, send-keys, submit, paste, kill, clear, remove)",
          },
          sessionId: {
            type: "string",
            description: "Session id for actions other than list",
          },
          data: {
            type: "string",
            description: "Data to write for write action",
          },
          keys: {
            type: "array",
            items: { type: "string" },
            description: "Key tokens to send for send-keys",
          },
          hex: {
            type: "array",
            items: { type: "string" },
            description: "Hex bytes to send for send-keys",
          },
          literal: {
            type: "string",
            description: "Literal string for send-keys",
          },
          text: {
            type: "string",
            description: "Text to paste for paste action",
          },
          bracketed: {
            type: "boolean",
            description: "Wrap paste in bracketed mode",
          },
          eof: { type: "boolean", description: "Close stdin after write" },
          offset: { type: "number", description: "Log offset" },
          limit: { type: "number", description: "Log length" },
        },
        required: ["action"],
      },
      execute: async (
        context: CodingActionContext,
      ): Promise<CodingActionResult> => {
        const params = context.args as {
          action: string;
          sessionId?: string;
          data?: string;
          keys?: string[];
          hex?: string[];
          literal?: string;
          text?: string;
          bracketed?: boolean;
          eof?: boolean;
          offset?: number;
          limit?: number;
        };

        const result = await shellService.processAction({
          action: params.action as
            | "list"
            | "poll"
            | "log"
            | "write"
            | "send-keys"
            | "submit"
            | "paste"
            | "kill"
            | "clear"
            | "remove",
          sessionId: params.sessionId,
          data: params.data,
          keys: params.keys,
          hex: params.hex,
          literal: params.literal,
          text: params.text,
          bracketed: params.bracketed,
          eof: params.eof,
          offset: params.offset,
          limit: params.limit,
        });

        return {
          content: [
            {
              type: "text",
              text: result.message as string | undefined,
            },
          ],
          details: result.data as Record<string, unknown> | undefined,
        };
      },
    };
    actions.push(processAction);
  }

  // ============================================================================
  // File operations (via CoderService)
  // ============================================================================
  if (coderService) {
    // read_file
    const readFileAction: CodingAction = {
      name: "read_file",
      label: "read_file",
      description: "Read the contents of a file.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path to the file to read" },
        },
        required: ["path"],
      },
      execute: async (
        context: CodingActionContext,
      ): Promise<CodingActionResult> => {
        const params = context.args as { path: string };
        const convId = context.conversationId ?? conversationId;
        const result = await coderService.readFile(convId, params.path);

        if (!result.ok) {
          return {
            content: [{ type: "text", text: `Error: ${result.error}` }],
            details: { success: false, error: result.error },
          };
        }

        return {
          content: [{ type: "text", text: result.content }],
          details: { success: true },
        };
      },
    };
    actions.push(readFileAction);

    // write_file
    const writeFileAction: CodingAction = {
      name: "write_file",
      label: "write_file",
      description:
        "Write content to a file. Creates the file if it doesn't exist.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path to the file to write" },
          content: {
            type: "string",
            description: "Content to write to the file",
          },
        },
        required: ["path", "content"],
      },
      execute: async (
        context: CodingActionContext,
      ): Promise<CodingActionResult> => {
        const params = context.args as { path: string; content: string };
        const convId = context.conversationId ?? conversationId;
        const result = await coderService.writeFile(
          convId,
          params.path,
          params.content,
        );

        if (!result.ok) {
          return {
            content: [{ type: "text", text: `Error: ${result.error}` }],
            details: { success: false, error: result.error },
          };
        }

        return {
          content: [{ type: "text", text: `File written: ${params.path}` }],
          details: { success: true },
        };
      },
    };
    actions.push(writeFileAction);

    // edit_file
    const editFileAction: CodingAction = {
      name: "edit_file",
      label: "edit_file",
      description:
        "Edit a file by replacing text. Finds old_str and replaces with new_str.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path to the file to edit" },
          old_str: { type: "string", description: "Text to find and replace" },
          new_str: { type: "string", description: "Text to replace with" },
        },
        required: ["path", "old_str", "new_str"],
      },
      execute: async (
        context: CodingActionContext,
      ): Promise<CodingActionResult> => {
        const params = context.args as {
          path: string;
          old_str: string;
          new_str: string;
        };
        const convId = context.conversationId ?? conversationId;
        const result = await coderService.editFile(
          convId,
          params.path,
          params.old_str,
          params.new_str,
        );

        if (!result.ok) {
          return {
            content: [{ type: "text", text: `Error: ${result.error}` }],
            details: { success: false, error: result.error },
          };
        }

        return {
          content: [{ type: "text", text: `File edited: ${params.path}` }],
          details: { success: true },
        };
      },
    };
    actions.push(editFileAction);

    // list_files
    const listFilesAction: CodingAction = {
      name: "list_files",
      label: "list_files",
      description: "List files and directories in a path.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description:
              "Directory path to list (defaults to current directory)",
          },
        },
        required: [],
      },
      execute: async (
        context: CodingActionContext,
      ): Promise<CodingActionResult> => {
        const params = context.args as { path?: string };
        const convId = context.conversationId ?? conversationId;
        const result = await coderService.listFiles(convId, params.path ?? ".");

        if (!result.ok) {
          return {
            content: [{ type: "text", text: `Error: ${result.error}` }],
            details: { success: false, error: result.error },
          };
        }

        return {
          content: [{ type: "text", text: result.items.join("\n") }],
          details: { success: true, items: result.items },
        };
      },
    };
    actions.push(listFilesAction);

    // search_files
    const searchFilesAction: CodingAction = {
      name: "search_files",
      label: "search_files",
      description: "Search for a pattern in files within a directory.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Pattern to search for" },
          path: {
            type: "string",
            description:
              "Directory path to search in (defaults to current directory)",
          },
          max_matches: {
            type: "number",
            description: "Maximum matches to return (default 50)",
          },
        },
        required: ["pattern"],
      },
      execute: async (
        context: CodingActionContext,
      ): Promise<CodingActionResult> => {
        const params = context.args as {
          pattern: string;
          path?: string;
          max_matches?: number;
        };
        const convId = context.conversationId ?? conversationId;
        const result = await coderService.searchFiles(
          convId,
          params.pattern,
          params.path ?? ".",
          params.max_matches ?? 50,
        );

        if (!result.ok) {
          return {
            content: [{ type: "text", text: `Error: ${result.error}` }],
            details: { success: false, error: result.error },
          };
        }

        const formatted = result.matches
          .map((m) => `${m.file}:${m.line}: ${m.content}`)
          .join("\n");

        return {
          content: [{ type: "text", text: formatted || "No matches found" }],
          details: { success: true, matches: result.matches },
        };
      },
    };
    actions.push(searchFilesAction);

    // git
    const gitAction: CodingAction = {
      name: "git",
      label: "git",
      description: "Execute a git command.",
      parameters: {
        type: "object",
        properties: {
          args: {
            type: "string",
            description:
              "Git command arguments (e.g., 'status', 'diff', 'log --oneline -5')",
          },
        },
        required: ["args"],
      },
      execute: async (
        context: CodingActionContext,
      ): Promise<CodingActionResult> => {
        const params = context.args as { args: string };
        const convId = context.conversationId ?? conversationId;
        const result = await coderService.git(params.args, convId);

        return {
          content: [
            {
              type: "text",
              text: result.success ? result.stdout : result.stderr,
            },
          ],
          details: {
            success: result.success,
            exitCode: result.exitCode,
            stdout: result.stdout,
            stderr: result.stderr,
          },
        };
      },
    };
    actions.push(gitAction);
  }

  return actions;
}

export default configureCodingTools;
