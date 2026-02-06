/**
 * Shared types for sandbox operations.
 * Used by both SandboxService and AppBuilderAISDK.
 *
 * Types are aligned with Vercel Sandbox SDK v1.x
 * @see https://vercel.com/docs/vercel-sandbox/sdk-reference
 */

export interface RunCommandOptions {
  cmd: string;
  args?: string[];
  cwd?: string;
  stderr?: NodeJS.WritableStream;
  stdout?: NodeJS.WritableStream;
  detached?: boolean;
  sudo?: boolean;
  env?: Record<string, string>;
}

export interface CommandResult {
  cmdId: string;
  exitCode: number | null;
  cwd: string;
  startedAt: number;
  stdout: (opts?: { signal?: AbortSignal }) => Promise<string>;
  stderr: (opts?: { signal?: AbortSignal }) => Promise<string>;
  output: (
    stream: "stdout" | "stderr" | "both",
    opts?: { signal?: AbortSignal },
  ) => Promise<string>;
  logs: (opts?: {
    signal?: AbortSignal;
  }) => AsyncGenerator<{ stream: "stdout" | "stderr"; data: string }>;
  wait: (opts?: { signal?: AbortSignal }) => Promise<CommandFinished>;
  kill: (
    signal?: string,
    opts?: { abortSignal?: AbortSignal },
  ) => Promise<void>;
}

export interface CommandFinished extends CommandResult {
  exitCode: number;
}

export interface SandboxFile {
  path: string;
  content: Buffer;
}

export interface SandboxInstance {
  sandboxId: string;
  status: "pending" | "running" | "stopping" | "stopped" | "failed";
  timeout: number;
  createdAt: Date;
  domain: (port: number) => string;

  // Command execution
  runCommand: (
    params: RunCommandOptions | string,
    args?: string[],
    opts?: { signal?: AbortSignal },
  ) => Promise<CommandResult>;
  getCommand: (
    cmdId: string,
    opts?: { signal?: AbortSignal },
  ) => Promise<CommandResult>;

  // File operations (native SDK methods)
  readFile: (
    file: { path: string; cwd?: string },
    opts?: { signal?: AbortSignal },
  ) => Promise<ReadableStream | null>;
  writeFiles: (
    files: SandboxFile[],
    opts?: { signal?: AbortSignal },
  ) => Promise<void>;
  mkDir: (path: string, opts?: { signal?: AbortSignal }) => Promise<void>;

  // Lifecycle
  stop: (opts?: { signal?: AbortSignal }) => Promise<void>;
  extendTimeout: (
    durationMs: number,
    opts?: { signal?: AbortSignal },
  ) => Promise<void>;

  // Snapshotting (optional - may not be available on all sandbox instances)
  snapshot?: (opts?: { signal?: AbortSignal }) => Promise<{ snapshotId: string }>;
}

export type SandboxProgress =
  | { step: "creating"; message: string }
  | { step: "installing"; message: string }
  | { step: "starting"; message: string }
  | { step: "restoring"; message: string }
  | { step: "ready"; message: string }
  | { step: "error"; message: string };

export interface SandboxConfig {
  templateUrl?: string;
  timeout?: number;
  vcpus?: number;
  ports?: number[];
  env?: Record<string, string>;
  organizationId?: string;
  projectId?: string;
  onProgress?: (progress: SandboxProgress) => void;

  // Snapshot options
  /** Use a specific snapshot ID instead of cloning from git */
  snapshotId?: string;
  /** Template key for snapshot lookup (e.g., "default", "chat") */
  templateKey?: string;
  /** Skip snapshot lookup and always create from git */
  skipSnapshotLookup?: boolean;
}

export interface SandboxSessionData {
  sandboxId: string;
  sandboxUrl: string;
  status: "initializing" | "ready" | "generating" | "error" | "stopped";
  devServerUrl?: string;
  startedAt?: Date;
  /** Whether this sandbox was created from a snapshot */
  createdFromSnapshot?: boolean;
}
