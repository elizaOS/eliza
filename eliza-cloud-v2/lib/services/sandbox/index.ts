/**
 * Sandbox utilities - shared code for sandbox operations.
 *
 * This module provides:
 * - Types for sandbox interactions
 * - Security validation for commands and paths
 * - File operations (read, write, list)
 * - Package manager operations
 * - Build checking and type validation
 * - Tool schemas and execution
 */

// Types
export type {
  RunCommandOptions,
  CommandResult,
  CommandFinished,
  SandboxFile,
  SandboxInstance,
  SandboxProgress,
  SandboxConfig,
  SandboxSessionData,
} from "./types";

// Security
export {
  ALLOWED_COMMANDS,
  BLOCKED_COMMAND_PATTERNS,
  ALLOWED_DIRECTORIES,
  ALLOWED_ROOT_PATTERNS,
  isCommandAllowed,
  isPathAllowed,
} from "./security";

// File operations (using native SDK methods with shell fallback)
export {
  readFileViaSh,
  writeFileViaSh,
  writeFilesViaSh,
  mkDirViaSh,
  listFilesViaSh,
} from "./file-ops";

// Package manager
export { installPackages, installDependencies } from "./package-manager";

// Build tools (with native SDK streaming support)
export {
  checkBuild,
  waitForDevServer,
  streamBuildOutput,
  runProductionBuild,
  getCommandOutputStreaming,
} from "./build-tools";

// Tool schemas
export { toolSchemas, type ToolName } from "./tool-schemas";

// Tool executor
export { executeToolCall, type ToolExecutionResult } from "./tool-executor";

// Sandbox management (admin utilities)
export {
  listSandboxes,
  getSandbox,
  cleanupStaleSandboxes,
  streamCommandLogs,
  collectCommandOutput,
  getSandboxStats,
  type SandboxSummary,
  type SandboxPagination,
  type ListSandboxesResult,
  type ListSandboxesOptions,
  type GetSandboxOptions,
} from "./sandbox-manager";
