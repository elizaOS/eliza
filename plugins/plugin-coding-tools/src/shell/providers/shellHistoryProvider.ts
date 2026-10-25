/**
 * SHELL_HISTORY provider injects the complete conversation-scoped shell
 * activity into terminal/code context without changing the service-owned
 * history. It includes command streams, exit codes, working directories, and
 * file operations so planner context never presents a bounded projection as
 * the underlying execution record.
 */
import {
  addHeader,
  ElizaError,
  type IAgentRuntime,
  logger,
  type Memory,
  type Provider,
  type State,
} from "@elizaos/core";
import { requireProviderSpec } from "../generated/specs/spec-helpers";
import { redactShellText } from "../redaction";
import type { ShellService } from "../services/shellService";
import type { CommandHistoryEntry, FileOperation } from "../types";

const spec = requireProviderSpec("SHELL_HISTORY");

function renderFileOperation(
  runtime: IAgentRuntime,
  op: FileOperation,
): string {
  const target = redactShellText(runtime, op.target);
  if (op.secondaryTarget) {
    const secondary = redactShellText(runtime, op.secondaryTarget);
    return `- ${op.type}: ${target} → ${secondary}`;
  }
  return `- ${op.type}: ${target}`;
}

export const shellHistoryProvider: Provider = {
  name: spec.name,
  description:
    "Provides complete shell command history, current working directory, and file operations within the restricted environment",
  descriptionCompressed:
    "Complete shell history, cwd, and file ops in restricted env.",
  position: 99,
  contexts: ["terminal", "code"],
  contextGate: { anyOf: ["terminal", "code"] },
  cacheStable: false,
  cacheScope: "turn",
  // Shell history / cwd / file ops are host-operator context — admin+ only.
  // (#12094 item 3: the gate lives on the provider so it can't drift.)
  roleGate: { minRole: "ADMIN" },
  dynamic: true,
  get: async (runtime: IAgentRuntime, message: Memory, _state: State) => {
    try {
      const shellService = runtime.getService<ShellService>("shell");

      if (!shellService) {
        logger.warn("[shellHistoryProvider] Shell service not found");
        return {
          values: {
            shellHistory: "Shell service is not available",
            currentWorkingDirectory: "N/A",
            allowedDirectory: "N/A",
          },
          text: addHeader("# Shell Status", "Shell service is not available"),
          data: { historyCount: 0, cwd: "N/A", allowedDir: "N/A" },
        };
      }

      const conversationId = message.roomId || message.agentId;
      if (!conversationId) {
        return {
          text: "No conversation ID available",
          values: { historyCount: 0, cwd: "N/A", allowedDir: "N/A" },
          data: { historyCount: 0, cwd: "N/A", allowedDir: "N/A" },
        };
      }
      const history = shellService.getCommandHistory(conversationId);
      const cwd = redactShellText(
        runtime,
        shellService.getCurrentDirectory(conversationId),
      );
      const allowedDir = redactShellText(
        runtime,
        shellService.getAllowedDirectory(),
      );

      let historyText = "No commands in history.";
      if (history.length > 0) {
        historyText = history
          .map((entry: CommandHistoryEntry) => {
            const stdout = redactShellText(runtime, entry.stdout ?? "");
            const stderr = redactShellText(runtime, entry.stderr ?? "");
            let entryStr = redactShellText(
              runtime,
              `[${new Date(entry.timestamp).toISOString()}] ${entry.workingDirectory}> ${entry.command}`,
            );

            if (stdout) {
              entryStr += `\n  Output: ${stdout}`;
            }

            if (stderr) {
              entryStr += `\n  Error: ${stderr}`;
            }

            entryStr += `\n  Exit Code: ${entry.exitCode}`;

            if (entry.fileOperations && entry.fileOperations.length > 0) {
              entryStr += `\n  File Operations:\n${entry.fileOperations
                .map(
                  (op: FileOperation) =>
                    `    ${renderFileOperation(runtime, op)}`,
                )
                .join("\n")}`;
            }

            return entryStr;
          })
          .join("\n\n");
      }

      const text = `Current Directory: ${cwd}
Allowed Directory: ${allowedDir}

${addHeader("# Shell History", historyText)}`;

      return {
        values: {
          shellHistory: historyText,
          currentWorkingDirectory: cwd,
          allowedDirectory: allowedDir,
        },
        text,
        data: {
          historyCount: history.length,
          cwd,
          allowedDir,
        },
      };
    } catch (error) {
      // error-policy:J4 designed unavailable render; the provider emits a
      // distinguishable "Shell history is unavailable: <msg>" status AND reports
      // the failure via reportError — never a healthy-looking empty history.
      //
      // Surface the failure through the runtime diagnostic boundary AND as a
      // model-visible status line. A bare `catch {}` that returned an empty
      // string here hid real ShellService failures from both the operator logs
      // and the planner loop, presenting success-shaped empty output instead of
      // an error the model could react to (#12273/#12799).
      //
      // `runtime.reportError` (#12263) is the diagnostic boundary for provider
      // failures: it logs with a `[scope]` prefix, emits ERROR_REPORTED, feeds
      // the RECENT_ERRORS provider (so repeated shell-history backend failures
      // become observable to the agent), and drives owner escalation. It never
      // throws. Fall back to logger.error on runtimes/test doubles that predate
      // it so the failure is never silently swallowed.
      const errMsg = redactShellText(
        runtime,
        error instanceof Error ? error.message : String(error),
      );
      if (typeof runtime?.reportError === "function") {
        const diagnosticError = new ElizaError(
          `Shell history context failed: ${errMsg}`,
          {
            code: "SHELL_HISTORY_PROVIDER_FAILED",
            context: { redactedMessage: errMsg },
          },
        );
        runtime.reportError("shellHistoryProvider", diagnosticError, {
          roomId: message.roomId,
          agentId: message.agentId,
        });
      } else {
        logger.error(
          { src: "shellHistoryProvider", error: errMsg },
          `[shellHistoryProvider] Failed to build shell history context: ${errMsg}`,
        );
      }
      const statusText = `Shell history is unavailable: ${errMsg}`;
      return {
        values: {
          shellHistory: statusText,
          currentWorkingDirectory: "N/A",
          allowedDirectory: "N/A",
        },
        text: addHeader("# Shell Status", statusText),
        data: { historyCount: 0, cwd: "N/A", allowedDir: "N/A", error: errMsg },
      };
    }
  },
};

export default shellHistoryProvider;
