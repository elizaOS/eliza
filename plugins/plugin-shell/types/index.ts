import type { ChildProcessWithoutNullStreams } from "node:child_process";

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
  maxOutputChars: number;
  pendingMaxOutputChars: number;
  defaultBackgroundMs: number;
  allowBackground: boolean;
}

// Process session types for background execution
export type ProcessStatus = "running" | "completed" | "failed" | "killed";

export type SessionStdin = {
  write: (data: string, cb?: (err?: Error | null) => void) => void;
  end: () => void;
  destroyed?: boolean;
};

export interface ProcessSession {
  id: string;
  command: string;
  scopeKey?: string;
  sessionKey?: string;
  notifyOnExit?: boolean;
  exitNotified?: boolean;
  child?: ChildProcessWithoutNullStreams;
  stdin?: SessionStdin;
  pid?: number;
  startedAt: number;
  cwd?: string;
  maxOutputChars: number;
  pendingMaxOutputChars?: number;
  totalOutputChars: number;
  pendingStdout: string[];
  pendingStderr: string[];
  pendingStdoutChars: number;
  pendingStderrChars: number;
  aggregated: string;
  tail: string;
  exitCode?: number | null;
  exitSignal?: NodeJS.Signals | number | null;
  exited: boolean;
  truncated: boolean;
  backgrounded: boolean;
}

export interface FinishedSession {
  id: string;
  command: string;
  scopeKey?: string;
  startedAt: number;
  endedAt: number;
  cwd?: string;
  status: ProcessStatus;
  exitCode?: number | null;
  exitSignal?: NodeJS.Signals | number | null;
  aggregated: string;
  tail: string;
  truncated: boolean;
  totalOutputChars: number;
}

// Execution options for the enhanced shell service
export interface ExecuteOptions {
  workdir?: string;
  env?: Record<string, string>;
  yieldMs?: number;
  background?: boolean;
  timeout?: number;
  pty?: boolean;
  conversationId?: string;
  scopeKey?: string;
  sessionKey?: string;
  notifyOnExit?: boolean;
  onUpdate?: (session: ProcessSession) => void;
}

// Result types for exec operations
export type ExecResult =
  | {
      status: "running";
      sessionId: string;
      pid?: number;
      startedAt: number;
      cwd?: string;
      tail?: string;
    }
  | {
      status: "completed" | "failed";
      exitCode: number | null;
      durationMs: number;
      aggregated: string;
      cwd?: string;
      timedOut?: boolean;
      reason?: string;
    };

// Process action types
export type ProcessAction =
  | "list"
  | "poll"
  | "log"
  | "write"
  | "send-keys"
  | "submit"
  | "paste"
  | "kill"
  | "clear"
  | "remove";

export interface ProcessActionParams {
  action: ProcessAction;
  sessionId?: string;
  data?: string;
  keys?: string[];
  hex?: string[];
  literal?: string;
  text?: string;
  bracketed?: boolean;
  eof?: boolean;
  offset?: number;
  limit?: number;
}

// PTY types
export type PtyExitEvent = { exitCode: number; signal?: number };
export type PtyListener<T> = (event: T) => void;
export type PtyHandle = {
  pid: number;
  write: (data: string | Buffer) => void;
  onData: (listener: PtyListener<string>) => void;
  onExit: (listener: PtyListener<PtyExitEvent>) => void;
};
export type PtySpawn = (
  file: string,
  args: string[] | string,
  options: {
    name?: string;
    cols?: number;
    rows?: number;
    cwd?: string;
    env?: Record<string, string>;
  }
) => PtyHandle;
