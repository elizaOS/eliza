import { Plugin } from "@elizaos/core";
import { ShellService } from "./services/shellService";
import { executeCommand, clearHistory } from "./actions";
import { shellHistoryProvider } from "./providers";

export const shellPlugin: Plugin = {
  name: "shell",
  description:
    "Execute shell commands within a restricted directory with history tracking",
  services: [ShellService],
  actions: [executeCommand, clearHistory],
  providers: [shellHistoryProvider],
};

export default shellPlugin;

// Export types and utilities for external use
export type {
  CommandResult,
  CommandHistoryEntry,
  FileOperation,
  FileOperationType,
  ShellConfig,
} from "./types";

export { ShellService } from "./services/shellService";
export { executeCommand } from "./actions/executeCommand";
export { clearHistory } from "./actions/clearHistory";
export { shellHistoryProvider } from "./providers/shellHistoryProvider";
export {
  loadShellConfig,
  DEFAULT_FORBIDDEN_COMMANDS,
  validatePath,
  isSafeCommand,
  extractBaseCommand,
  isForbiddenCommand,
} from "./utils";

