import {
  addHeader,
  type IAgentRuntime,
  logger,
  type Memory,
  type Provider,
  type State,
} from "@elizaos/core";
import { requireProviderSpec } from "../generated/specs/spec-helpers";
import type { ShellService } from "../services/shellService";
import type { CommandHistoryEntry, FileOperation } from "../types";

const MAX_OUTPUT_LENGTH = 8000;
const TRUNCATE_SEGMENT_LENGTH = 4000;

const spec = requireProviderSpec("shellHistoryProvider");

export const shellHistoryProvider: Provider = {
  name: spec.name,
  description:
    "Provides recent shell command history, current working directory, and file operations within the restricted environment",
  position: 99,
  get: async (runtime: IAgentRuntime, message: Memory, _state: State) => {
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
    const history = shellService.getCommandHistory(conversationId, 10);
    const cwd = shellService.getCurrentDirectory(conversationId);
    const allowedDir = shellService.getAllowedDirectory();

    let historyText = "No commands in history.";
    if (history.length > 0) {
      historyText = history
        .map((entry: CommandHistoryEntry) => {
          let entryStr = `[${new Date(entry.timestamp).toISOString()}] ${entry.workingDirectory}> ${entry.command}`;

          if (entry.stdout) {
            if (entry.stdout.length > MAX_OUTPUT_LENGTH) {
              entryStr += `\n  Output: ${entry.stdout.substring(0, TRUNCATE_SEGMENT_LENGTH)}\n  ... [TRUNCATED] ...\n  ${entry.stdout.substring(entry.stdout.length - TRUNCATE_SEGMENT_LENGTH)}`;
            } else {
              entryStr += `\n  Output: ${entry.stdout}`;
            }
          }

          if (entry.stderr) {
            if (entry.stderr.length > MAX_OUTPUT_LENGTH) {
              entryStr += `\n  Error: ${entry.stderr.substring(0, TRUNCATE_SEGMENT_LENGTH)}\n  ... [TRUNCATED] ...\n  ${entry.stderr.substring(entry.stderr.length - TRUNCATE_SEGMENT_LENGTH)}`;
            } else {
              entryStr += `\n  Error: ${entry.stderr}`;
            }
          }

          entryStr += `\n  Exit Code: ${entry.exitCode}`;

          if (entry.fileOperations && entry.fileOperations.length > 0) {
            entryStr += "\n  File Operations:";
            entry.fileOperations.forEach((op: FileOperation) => {
              if (op.secondaryTarget) {
                entryStr += `\n    - ${op.type}: ${op.target} → ${op.secondaryTarget}`;
              } else {
                entryStr += `\n    - ${op.type}: ${op.target}`;
              }
            });
          }

          return entryStr;
        })
        .join("\n\n");
    }

    const recentFileOps = history
      .filter(
        (entry: CommandHistoryEntry) => entry.fileOperations && entry.fileOperations.length > 0
      )
      .flatMap((entry: CommandHistoryEntry) => entry.fileOperations ?? [])
      .slice(-5);

    let fileOpsText = "";
    if (recentFileOps.length > 0) {
      fileOpsText =
        "\n\n" +
        addHeader(
          "# Recent File Operations",
          recentFileOps
            .map((op: FileOperation) => {
              if (op.secondaryTarget) {
                return `- ${op.type}: ${op.target} → ${op.secondaryTarget}`;
              }
              return `- ${op.type}: ${op.target}`;
            })
            .join("\n")
        );
    }

    const text = `Current Directory: ${cwd}
Allowed Directory: ${allowedDir}

${addHeader("# Shell History (Last 10)", historyText)}${fileOpsText}`;

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
  },
};

export default shellHistoryProvider;
