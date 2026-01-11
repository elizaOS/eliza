import type { Task as CoreTask, UUID } from "@elizaos/core";

// ============================================================================
// JSON-safe value types (no `any` / `unknown`)
// ============================================================================

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [key: string]: JsonValue };

// ============================================================================
// Task Types (extends core elizaOS Task)
// ============================================================================

export type TaskStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "paused"
  | "cancelled";

/**
 * User-controlled status for task lifecycle in the UI.
 * This is intentionally separate from execution `TaskStatus` so the agent can
 * finish work while the user decides when a task is "done".
 */
export type TaskUserStatus = "open" | "done";

export interface TaskStep {
  id: string;
  description: string;
  status: TaskStatus;
  output?: string;
}

export interface TaskResult {
  success: boolean;
  summary: string;
  filesModified: string[];
  filesCreated: string[];
  error?: string;
}

export type TaskTraceLevel = "info" | "warning" | "error";
export type TaskTraceStatus = "paused" | "resumed" | "cancelled";

export interface TaskTraceBase {
  ts: number;
  seq: number;
}

export interface TaskTraceNoteEvent extends TaskTraceBase {
  kind: "note";
  level: TaskTraceLevel;
  message: string;
}

export interface TaskTraceLlmEvent extends TaskTraceBase {
  kind: "llm";
  iteration: number;
  modelType: string;
  response: string;
  responsePreview: string;
  prompt?: string;
}

export interface TaskTraceToolCallEvent extends TaskTraceBase {
  kind: "tool_call";
  iteration: number;
  name: string;
  args: Record<string, string>;
}

export interface TaskTraceToolResultEvent extends TaskTraceBase {
  kind: "tool_result";
  iteration: number;
  name: string;
  success: boolean;
  output: string;
  outputPreview: string;
}

export interface TaskTraceStatusEvent extends TaskTraceBase {
  kind: "status";
  status: TaskTraceStatus;
  message?: string;
}

export type TaskTraceEvent =
  | TaskTraceNoteEvent
  | TaskTraceLlmEvent
  | TaskTraceToolCallEvent
  | TaskTraceToolResultEvent
  | TaskTraceStatusEvent;

/** Extended metadata for code tasks */
export interface CodeTaskMetadata {
  status: TaskStatus;
  progress: number;
  output: string[];
  steps: TaskStep[];
  trace?: TaskTraceEvent[];
  result?: TaskResult;
  /**
   * User-controlled lifecycle status (independent of execution status).
   * - open: visible by default, expected to be reviewed/iterated on
   * - done: user has marked the task as finished (may be hidden in UI)
   */
  userStatus?: TaskUserStatus;
  /** Timestamp (ms) when `userStatus` last changed. */
  userStatusUpdatedAt?: number;
  /**
   * Convenience mirrors of the last run result.
   * These are duplicated for quick access in UIs/providers without needing to
   * dereference `result`.
   */
  filesModified?: string[];
  filesCreated?: string[];
  workingDirectory: string;
  subAgentType?: "eliza" | "claude";
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  error?: string;
  updateInterval?: number;
  /** Additional plugin-specific metadata (must be JSON-serializable). */
  [key: string]: JsonValue | undefined;
}

/** Code task - uses core Task with typed metadata */
export interface CodeTask extends CoreTask {
  metadata: CodeTaskMetadata;
}

// ============================================================================
// Progress Update
// ============================================================================

export interface ProgressUpdate {
  taskId: string;
  progress: number;
  message?: string;
  step?: TaskStep;
}

// ============================================================================
// Event Types
// ============================================================================

export type TaskEventType =
  | "task:created"
  | "task:started"
  | "task:progress"
  | "task:output"
  | "task:trace"
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

// ============================================================================
// Chat/Message Types
// ============================================================================

export type MessageRole = "user" | "assistant" | "system";

export interface Message {
  id: string;
  role: MessageRole;
  content: string;
  timestamp: Date;
  roomId: string;
  taskId?: string;
}

export interface ChatRoom {
  id: string;
  name: string;
  messages: Message[];
  createdAt: Date;
  taskIds: string[];
  elizaRoomId: UUID;
}

// ============================================================================
// UI State Types
// ============================================================================

export type PaneFocus = "chat" | "tasks";

// ============================================================================
// UI Layout Types
// ============================================================================

/**
 * Controls whether the task pane is rendered.
 * - auto: show only when there are open tasks
 * - shown: always show
 * - hidden: never show
 */
export type TaskPaneVisibility = "auto" | "shown" | "hidden";
