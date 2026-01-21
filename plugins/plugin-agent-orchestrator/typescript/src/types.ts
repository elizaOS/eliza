import type { Task as CoreTask, UUID } from "@elizaos/core";

// ============================================================================
// JSON-safe value types (no `any` / `unknown`)
// ============================================================================

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

// ============================================================================
// Task model
// ============================================================================

export type TaskStatus = "pending" | "running" | "completed" | "failed" | "paused" | "cancelled";

/**
 * User-controlled lifecycle status (separate from execution status).
 * Used by UIs to hide/show finished tasks without deleting history.
 */
export type TaskUserStatus = "open" | "done";

export interface TaskStep {
  id: string;
  description: string;
  status: TaskStatus;
  output?: string;
  /** Additional metadata for the step */
  metadata?: Record<string, JsonValue>;
}

export interface TaskResult {
  success: boolean;
  summary: string;
  filesModified: string[];
  filesCreated: string[];
  error?: string;
  /** Additional metadata for the result */
  metadata?: Record<string, JsonValue>;
}

export type AgentProviderId = string;

export interface OrchestratedTaskMetadata {
  status: TaskStatus;
  progress: number;
  output: string[];
  steps: TaskStep[];
  result?: TaskResult;
  error?: string;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;

  providerId: AgentProviderId;
  /**
   * Optional label (e.g. "Claude Code", "Codex", "SWE-agent") to show in UIs.
   * Not used for routing execution (use `providerId`).
   */
  providerLabel?: string;

  /**
   * A working directory string for display/prompting purposes.
   * The orchestrator plugin does not read/verify the filesystem.
   */
  workingDirectory: string;

  /** Compatibility field for UIs that still refer to "subAgentType". */
  subAgentType?: string;

  /** User-controlled status for UI filtering. */
  userStatus?: TaskUserStatus;
  userStatusUpdatedAt?: number;

  /** Optional result mirrors for UIs. */
  filesCreated?: string[];
  filesModified?: string[];
}

export interface OrchestratedTask extends Omit<CoreTask, "metadata"> {
  metadata: OrchestratedTaskMetadata;
}

// ============================================================================
// Execution
// ============================================================================

export interface ProviderTaskExecutionContext {
  runtimeAgentId: UUID;
  roomId?: UUID;
  worldId?: UUID;
  workingDirectory: string;

  /** Best-effort telemetry channels back into task history */
  appendOutput: (line: string) => Promise<void>;
  updateProgress: (progress: number) => Promise<void>;
  updateStep: (stepId: string, status: TaskStatus, output?: string) => Promise<void>;

  /** Cooperative cancellation/pause. Providers should poll these. */
  isCancelled: () => boolean;
  isPaused: () => boolean;
}

export interface AgentProvider {
  id: AgentProviderId;
  label: string;
  description?: string;

  executeTask: (task: OrchestratedTask, ctx: ProviderTaskExecutionContext) => Promise<TaskResult>;
}

export interface AgentOrchestratorPluginOptions {
  /**
   * Providers available to the orchestrator.
   *
   * Examples:
   * - "claude-code" (Claude Agent SDK)
   * - "codex" (OpenAI Codex SDK)
   * - "sweagent" (SWE-agent methodology worker)
   * - "eliza+plugin-code" (Eliza worker that has @elizaos/plugin-code)
   * - any custom provider id
   */
  providers: readonly AgentProvider[];

  /** Default provider id when user hasn’t selected one. */
  defaultProviderId: AgentProviderId;

  /**
   * Function to supply a working directory string.
   * The orchestrator plugin does not verify the path.
   */
  getWorkingDirectory: () => string;

  /**
   * Environment variable that controls which provider is active for new tasks.
   * Defaults to `ELIZA_CODE_ACTIVE_SUB_AGENT` for compatibility with `examples/code`.
   */
  activeProviderEnvVar?: string;
}

// ============================================================================
// Events
// ============================================================================

export type TaskEventType =
  | "task:created"
  | "task:started"
  | "task:progress"
  | "task:output"
  | "task:completed"
  | "task:failed"
  | "task:cancelled"
  | "task:paused"
  | "task:resumed"
  | "task:message";

export interface TaskEvent {
  type: TaskEventType;
  taskId: string;
  data?: Record<string, JsonValue>;
}
