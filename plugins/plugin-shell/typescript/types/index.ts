export interface CommandResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  error?: string;
  executedIn: string;
}

export interface CommandHistoryEntry {
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timestamp: number;
  workingDirectory: string;
  fileOperations?: FileOperation[];
}

export type FileOperationType = "create" | "write" | "read" | "delete" | "mkdir" | "move" | "copy";

export interface FileOperation {
  type: FileOperationType;
  target: string;
  secondaryTarget?: string;
}

export interface ShellConfig {
  enabled: boolean;
  allowedDirectory: string;
  timeout: number;
  forbiddenCommands: string[];
}
