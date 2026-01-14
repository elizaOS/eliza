export interface CoderConfig {
  enabled: boolean;
  allowedDirectory: string;
  timeoutMs: number;
  forbiddenCommands: string[];
}

export type FileOperationType = "read" | "write" | "edit" | "list" | "search";

export interface FileOperation {
  type: FileOperationType;
  target: string;
}

export interface CommandHistoryEntry {
  timestamp: number;
  workingDirectory: string;
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  fileOperations?: FileOperation[];
}

export interface CommandResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  error?: string;
  executedIn: string;
}
