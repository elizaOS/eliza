import {
  addHeader,
  type IAgentRuntime,
  logger,
  type Memory,
  type Provider,
  type State,
} from "@elizaos/core";
import { requireProviderSpec } from "../generated/specs/spec-helpers";
import type { CoderService } from "../services/coderService";
import type { CommandHistoryEntry, FileOperation } from "../types";

const MAX_OUTPUT_LENGTH = 8000;
const TRUNCATE_SEGMENT_LENGTH = 4000;

const spec = requireProviderSpec("coderStatusProvider");

export const coderStatusProvider: Provider = {
  name: spec.name,
  description:
    "Provides current working directory, allowed directory, and recent shell/file operations",
  position: 99,
  get: async (runtime: IAgentRuntime, message: Memory, _state: State) => {
    const svc = runtime.getService<CoderService>("coder");

    if (!svc) {
      logger.warn("[coderStatusProvider] Coder service not found");
      return {
        values: {
          coderStatus: "Coder service is not available",
          currentWorkingDirectory: "N/A",
          allowedDirectory: "N/A",
        },
        text: addHeader("# Coder Status", "Coder service is not available"),
        data: { historyCount: 0, cwd: "N/A", allowedDir: "N/A" },
      };
    }

    const conversationId = message.roomId ?? message.agentId ?? runtime.agentId;
    const history = svc.getCommandHistory(conversationId, 10);
    const cwd = svc.getCurrentDirectory(conversationId);
    const allowedDir = svc.getAllowedDirectory();

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
              entryStr += `\n    - ${op.type}: ${op.target}`;
            });
          }

          return entryStr;
        })
        .join("\n\n");
    }

    const recentFileOps = history
      .filter((h) => (h.fileOperations?.length ?? 0) > 0)
      .flatMap((h) => h.fileOperations ?? [])
      .slice(-8);

    const fileOpsText =
      recentFileOps.length > 0
        ? `\n\n${addHeader(
            "# Recent File Operations",
            recentFileOps.map((op) => `- ${op.type}: ${op.target}`).join("\n"),
          )}`
        : "";

    const text = `Current Directory: ${cwd}
Allowed Directory: ${allowedDir}

${addHeader("# Recent Commands (Last 10)", historyText)}${fileOpsText}`;

    return {
      values: {
        coderStatus: historyText,
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
