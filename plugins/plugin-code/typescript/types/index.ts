import type { IAgentRuntime, Service, State } from "@elizaos/core";

// ============================================================================
// Shell Service Types (local definitions to avoid circular dependency)
// ============================================================================

/**
 * Process session for background command execution.
 * Mirrors @elizaos/plugin-shell ProcessSession.
 */
export interface ProcessSession {
  id: string;
  command: string;
  scopeKey?: string;
  sessionKey?: string;
  notifyOnExit?: boolean;
  exitNotified?: boolean;
  pid?: number;
  startedAt: number;
  cwd?: string;
  maxOutputChars: number;
  pendingMaxOutputChars?: number;
  totalOutputChars: number;
  aggregated: string;
  tail: string;
  exitCode?: number | null;
  exitSignal?: NodeJS.Signals | number | null;
  exited: boolean;
  truncated: boolean;
  backgrounded: boolean;
}

/**
 * Options for shell exec command.
 */
export interface ShellExecuteOptions {
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

/**
 * Result from shell exec command.
 */
export type ShellExecResult =
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

/**
 * Process action types.
 */
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

/**
 * Parameters for process actions.
 */
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

/**
 * Shell service interface (subset used by plugin-code).
 */
export interface ShellService extends Service {
  exec(
    command: string,
    options?: ShellExecuteOptions,
  ): Promise<ShellExecResult>;
  processAction(params: ProcessActionParams): Promise<Record<string, unknown>>;
}

// ============================================================================
// Coder Configuration Types
// ============================================================================

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

// ============================================================================
// CodingAction Types - Claude Code-style actions for coding agents
// ============================================================================

/**
 * Content item in a coding action result
 */
export interface CodingActionContentItem {
  type: "text" | "image";
  text?: string;
  source?: { type: string; data: string; mimeType: string };
}

/**
 * Result returned from a CodingAction execute function
 */
export interface CodingActionResult {
  content: CodingActionContentItem[];
  details?: Record<string, unknown>;
}

/**
 * Callback for streaming action updates
 */
export type CodingActionUpdateCallback = (update: CodingActionResult) => void;

/**
 * Context for checking if a CodingAction is available
 */
export interface CodingActionAvailabilityContext {
  runtime: IAgentRuntime;
  roomId?: string;
  state?: State;
}

/**
 * Context provided to CodingAction execute function
 */
export interface CodingActionContext {
  toolCallId: string;
  args: Record<string, unknown>;
  signal?: AbortSignal;
  onUpdate?: CodingActionUpdateCallback;
  runtime: IAgentRuntime;
  roomId?: string;
  conversationId?: string;
  state?: State;
}

/**
 * CodingAction interface - Claude Code-style actions for coding operations.
 *
 * These are structured function-calling actions with:
 * - JSON Schema parameters for LLM function calling
 * - Room/context-scoped availability
 * - Abort signal support
 * - Streaming update support
 */
export interface CodingAction {
  /** Unique action name (e.g., "exec", "read_file", "write_file") */
  name: string;

  /** Optional display label */
  label?: string;

  /** Description for the LLM to understand when to use this action */
  description: string;

  /** JSON Schema for action parameters */
  parameters: Record<string, unknown>;

  /**
   * Check if this action is available in the given context.
   * Used for room-scoped capability filtering.
   */
  isAvailable?: (
    context: CodingActionAvailabilityContext,
  ) => boolean | Promise<boolean>;

  /**
   * Execute the action with full context
   */
  execute: (context: CodingActionContext) => Promise<CodingActionResult>;
}

/**
 * Options for configuring coding tools
 */
export interface CodingToolsOptions {
  /** Working directory for file operations */
  cwd?: string;

  /** Scope key for session management */
  scopeKey?: string;

  /** Session key for tracking */
  sessionKey?: string;

  /** Notify on background process exit */
  notifyOnExit?: boolean;

  /** Default milliseconds before backgrounding commands */
  backgroundMs?: number;

  /** Default timeout in seconds */
  timeoutSec?: number;

  /** Conversation/room ID for context */
  conversationId?: string;
}
