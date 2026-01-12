import type { Plugin } from "@elizaos/core";
import { clearHistory, executeCommand } from "./actions";
import { shellHistoryProvider } from "./providers";
import { ShellService } from "./services/shellService";

export const shellPlugin: Plugin = {
  name: "shell",
  description: "Execute shell commands within a restricted directory with history tracking",
  services: [ShellService],
  actions: [executeCommand, clearHistory],
  providers: [shellHistoryProvider],
};

export default shellPlugin;

export { clearHistory } from "./actions/clearHistory";
export { executeCommand } from "./actions/executeCommand";
export { shellHistoryProvider } from "./providers/shellHistoryProvider";
export { ShellService } from "./services/shellService";
export type {
  CommandHistoryEntry,
  CommandResult,
  FileOperation,
  FileOperationType,
  ShellConfig,
} from "./types";
export {
  DEFAULT_FORBIDDEN_COMMANDS,
  extractBaseCommand,
  isForbiddenCommand,
  isSafeCommand,
  loadShellConfig,
  validatePath,
} from "./utils";
