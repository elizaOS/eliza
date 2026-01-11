/**
 * Shell plugin type definitions
 */

/**
 * Result of a command execution
 */
export interface CommandResult {
  /** Whether the command executed successfully */
  success: boolean;
  /** Standard output from the command */
  stdout: string;
  /** Standard error output from the command */
  stderr: string;
  /** Exit code of the command (null if terminated abnormally) */
  exitCode: number | null;
  /** Error message if command failed */
  error?: string;
  /** Directory where the command was executed */
  executedIn: string;
}

/**
 * Entry in the command history
 */
export interface CommandHistoryEntry {
  /** The command that was executed */
  command: string;
  /** Standard output from the command */
  stdout: string;
  /** Standard error output from the command */
  stderr: string;
  /** Exit code of the command */
  exitCode: number | null;
  /** Unix timestamp when the command was executed */
  timestamp: number;
  /** Working directory when the command was executed */
  workingDirectory: string;
  /** File operations performed by the command */
  fileOperations?: FileOperation[];
}

/**
 * Type of file operation detected
 */
export type FileOperationType =
  | "create"
  | "write"
  | "read"
  | "delete"
  | "mkdir"
  | "move"
  | "copy";

/**
 * File operation performed by a command
 */
export interface FileOperation {
  /** Type of file operation */
  type: FileOperationType;
  /** Target file or directory path */
  target: string;
  /** Secondary target for move/copy operations */
  secondaryTarget?: string;
}

/**
 * Shell plugin configuration
 */
export interface ShellConfig {
  /** Whether the shell plugin is enabled */
  enabled: boolean;
  /** The directory that commands are restricted to */
  allowedDirectory: string;
  /** Maximum command execution timeout in milliseconds */
  timeout: number;
  /** List of forbidden commands/patterns */
  forbiddenCommands: string[];
}


