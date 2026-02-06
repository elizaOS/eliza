import type { Plugin } from "@elizaos/core";
import {
  changeDirectory,
  editFile,
  executeShell,
  git,
  listFiles,
  readFile,
  searchFiles,
  writeFile,
} from "./actions";
import { coderStatusProvider } from "./providers";
import { CoderService } from "./services/coderService";

export const coderPlugin: Plugin = {
  name: "eliza-coder",
  description: "Coder tools: filesystem, shell, and git (restricted)",
  services: [CoderService],
  actions: [
    readFile,
    listFiles,
    searchFiles,
    writeFile,
    editFile,
    changeDirectory,
    executeShell,
    git,
  ],
  providers: [coderStatusProvider],
};

export default coderPlugin;

// Actions (Eliza Action interface)
export * from "./actions";
// CodingAction system - Claude Code-style function-calling actions
export { configureCodingTools } from "./configureCodingTools";
// Providers
export { coderStatusProvider } from "./providers/coderStatusProvider";
// Services
export { CoderService } from "./services/coderService";
// Other types and utilities
export type {
  CoderConfig,
  CodingAction,
  CodingActionAvailabilityContext,
  CodingActionContentItem,
  CodingActionContext,
  CodingActionResult,
  CodingActionUpdateCallback,
  CodingToolsOptions,
  CommandHistoryEntry,
  CommandResult,
  FileOperation,
  FileOperationType,
} from "./types";
export * from "./utils";
