/**
 * Tool execution logic for AI-powered code generation.
 */

import { logger } from "@/lib/utils/logger";
import { appsRepository } from "@/db/repositories/apps";
import type { SandboxInstance } from "./types";
import { isCommandAllowed } from "./security";
import { readFileViaSh, writeFileViaSh, listFilesViaSh } from "./file-ops";
import { installPackages } from "./package-manager";
import { checkBuild } from "./build-tools";

// Timeout for individual tool calls (60 seconds)
const TOOL_TIMEOUT_MS = 60000;

// Database migration timeout (2 minutes for complex migrations)
const DATABASE_COMMAND_TIMEOUT_MS = 120000;

/**
 * Patterns that identify database commands needing DATABASE_URL injection.
 * These commands will have credentials automatically injected from our secure backend.
 */
const DATABASE_COMMAND_PATTERNS = [
  /drizzle-kit\s+(push|pull|generate|migrate|check|up|drop|introspect|studio)/i,
  /drizzle-kit$/i, // Just "drizzle-kit" alone (might show help or run default)
];

/**
 * Check if a command needs DATABASE_URL injected.
 */
function needsDatabaseCredentials(command: string): boolean {
  return DATABASE_COMMAND_PATTERNS.some((pattern) => pattern.test(command));
}

/**
 * Sanitize command output to prevent credential leakage.
 * Applied to all command output before returning to the AI.
 */
function sanitizeOutput(output: string): string {
  return output
    .replace(/postgres(ql)?:\/\/[^@\s]+@/gi, "postgres://***@")
    .replace(/password=[^&\s"']+/gi, "password=***")
    .replace(/DATABASE_URL=[^\s"']+/gi, "DATABASE_URL=***")
    .replace(/:[^:@\s]{8,}@/g, ":***@"); // Generic password patterns in URLs
}

export interface ToolExecutionResult {
  result: string;
  filesAffected?: string[];
}

/**
 * Execute a tool call with timeout and abort signal protection.
 * Races the promise against both a timeout and an optional abort signal.
 */
async function withTimeoutAndAbort<T>(
  promise: Promise<T>,
  timeoutMs: number,
  toolName: string,
  abortSignal?: AbortSignal,
): Promise<T> {
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(
      () =>
        reject(
          new Error(`Tool '${toolName}' timed out after ${timeoutMs / 1000}s`),
        ),
      timeoutMs,
    );
  });

  // If we have an abort signal, add it to the race
  const abortPromise = abortSignal
    ? new Promise<never>((_, reject) => {
        if (abortSignal.aborted) {
          reject(new Error("Operation aborted by client"));
        }
        abortSignal.addEventListener("abort", () => {
          reject(new Error("Operation aborted by client"));
        });
      })
    : null;

  const racers: Promise<T | never>[] = [promise, timeoutPromise];
  if (abortPromise) {
    racers.push(abortPromise);
  }

  return Promise.race(racers);
}

/**
 * Execute a tool call from the AI.
 * Returns the result string and any affected files.
 *
 * @param sandbox - The sandbox instance to execute commands in
 * @param toolName - Name of the tool to execute
 * @param args - Arguments for the tool
 * @param options - Optional settings including sandboxId and abortSignal
 */
export async function executeToolCall(
  sandbox: SandboxInstance,
  toolName: string,
  args: Record<string, unknown>,
  options: {
    sandboxId?: string;
    appId?: string;
    abortSignal?: AbortSignal;
  } = {},
): Promise<ToolExecutionResult> {
  const { sandboxId, appId, abortSignal } = options;
  const filesAffected: string[] = [];
  let result: string;

  // Check for abort before starting
  if (abortSignal?.aborted) {
    return {
      result: "Operation aborted by client",
      filesAffected: [],
    };
  }

  // Determine timeout upfront - database commands get extended timeout
  const command = toolName === "run_command" ? (args?.command as string) : "";
  const isDatabaseCommand = command && needsDatabaseCredentials(command);
  const effectiveTimeout = isDatabaseCommand
    ? DATABASE_COMMAND_TIMEOUT_MS
    : TOOL_TIMEOUT_MS;

  try {
    const execution = async (): Promise<string> => {
      switch (toolName) {
        case "install_packages": {
          const packages = args?.packages as string[] | undefined;
          if (!packages || !Array.isArray(packages)) {
            return `Error: install_packages called without packages array. Args received: ${JSON.stringify(args)}`;
          }
          return await installPackages(sandbox, packages);
        }

        case "write_file": {
          const path = args?.path as string | undefined;
          const content = args?.content as string | undefined;

          if (!path) {
            return `Error: write_file called without a path. Args received: ${JSON.stringify(args)}`;
          }
          if (content === undefined || content === null) {
            return `Error: write_file called with empty content for ${path}. Please provide the file content.`;
          }

          await writeFileViaSh(sandbox, path, content);
          filesAffected.push(path);

          logger.info("File written", { sandboxId, path });
          return `Wrote ${path}`;
        }

        case "read_file": {
          const path = args?.path as string | undefined;
          if (!path) {
            return `Error: read_file called without a path. Args received: ${JSON.stringify(args)}`;
          }
          const content = await readFileViaSh(sandbox, path);
          return content || `File not found: ${path}`;
        }

        case "check_build": {
          const buildResult = await checkBuild(sandbox);
          logger.info("Build check", {
            sandboxId,
            ok: buildResult.includes("BUILD OK"),
          });
          return buildResult;
        }

        case "list_files": {
          const path = (args?.path as string | undefined) || ".";
          const files = await listFilesViaSh(sandbox, path);
          return files.join("\n") || `Empty: ${path}`;
        }

        case "run_command": {
          const command = args?.command as string | undefined;
          if (!command) {
            return `Error: run_command called without a command. Args received: ${JSON.stringify(args)}`;
          }

          const commandCheck = isCommandAllowed(command);
          if (!commandCheck.allowed) {
            logger.warn("Blocked command attempt", {
              sandboxId,
              command,
              reason: commandCheck.reason,
            });
            return `Command blocked: ${commandCheck.reason}`;
          }

          // Build environment for this command
          let commandEnv: Record<string, string> | undefined;

          // Auto-inject DATABASE_URL for drizzle-kit commands
          if (isDatabaseCommand && appId) {
            const app = await appsRepository.findById(appId);

            if (
              app?.user_database_status === "ready" &&
              app.user_database_uri
            ) {
              commandEnv = { DATABASE_URL: app.user_database_uri };

              logger.info("Injecting DATABASE_URL for database command", {
                sandboxId,
                appId,
                command: command.substring(0, 80),
              });
            } else if (app?.user_database_status === "provisioning") {
              return "Error: Database is still provisioning. Please wait a moment and try again.";
            } else if (!app?.user_database_uri) {
              logger.warn("Database command without provisioned database", {
                sandboxId,
                appId,
                status: app?.user_database_status,
              });
              return "Error: No database provisioned for this app. The app needs a database to run this command.";
            }
          }

          const r = await sandbox.runCommand({
            cmd: "sh",
            args: ["-c", command],
            env: commandEnv,
          });

          // Sanitize output to prevent credential leakage
          const rawOutput =
            `Exit ${r.exitCode}: ${await r.stdout()} ${await r.stderr()}`.trim();
          return sanitizeOutput(rawOutput);
        }

        default:
          return `Unknown tool: ${toolName}`;
      }
    };

    // Execute with timeout and abort signal support (database commands get extended timeout)
    result = await withTimeoutAndAbort(
      execution(),
      effectiveTimeout,
      toolName,
      abortSignal,
    );
  } catch (toolError) {
    const toolErrorMsg =
      toolError instanceof Error ? toolError.message : String(toolError);

    // Log abort errors at info level, others at error level
    if (toolErrorMsg.includes("aborted")) {
      logger.info("Tool execution aborted", {
        sandboxId,
        tool: toolName,
      });
    } else {
      logger.error("Tool execution error", {
        sandboxId,
        tool: toolName,
        error: toolErrorMsg,
      });
    }
    result = `Error executing ${toolName}: ${toolErrorMsg}`;
  }

  return { result, filesAffected };
}
