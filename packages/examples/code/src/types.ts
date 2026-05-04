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

export type TaskTraceLevel = "info" | "warning" | "error";
export type TaskTraceStatus = "paused" | "resumed" | "cancelled";

export interface TaskTraceBase {
  ts: number;
  seq: number;
  [key: string]: JsonValue | undefined;
}

export interface TaskTraceNoteEvent extends TaskTraceBase {
  kind: "note";
  level: TaskTraceLevel;
  message: string;
  [key: string]: JsonValue | undefined;
}

export interface TaskTraceLlmEvent extends TaskTraceBase {
  kind: "llm";
  iteration: number;
  modelType: string;
  response: string;
  responsePreview: string;
  prompt?: string;
  [key: string]: JsonValue | undefined;
}

export interface TaskTraceToolCallEvent extends TaskTraceBase {
  kind: "tool_call";
  iteration: number;
  name: string;
  args: Record<string, string>;
  [key: string]: JsonValue | undefined;
}

export interface TaskTraceToolResultEvent extends TaskTraceBase {
  kind: "tool_result";
  iteration: number;
  name: string;
  success: boolean;
  output: string;
  outputPreview: string;
  [key: string]: JsonValue | undefined;
}

export interface TaskTraceStatusEvent extends TaskTraceBase {
  kind: "status";
  status: TaskTraceStatus;
  message?: string;
  [key: string]: JsonValue | undefined;
}

export type TaskTraceEvent =
  | TaskTraceNoteEvent
  | TaskTraceLlmEvent
  | TaskTraceToolCallEvent
  | TaskTraceToolResultEvent
  | TaskTraceStatusEvent;

// ============================================================================
// Sub-Agent Type Definitions
// ============================================================================

/**
 * Available sub-agent types for task execution.
 * - eliza: Default ElizaOS tool-calling worker using runtime model
 * - claude-code: Claude Agent SDK-based worker
 * - codex: OpenAI Codex SDK-based worker
 * - opencode: OpenCode CLI-based worker (supports 75+ LLM providers)
 * - sweagent: SWE-agent methodology worker (Think/Act pattern, ACI)
 * - elizaos-native: Best-of-all native ElizaOS agent with monologue reasoning
 */
export type SubAgentType =
  | "eliza"
  | "claude"
  | "claude-code"
  | "codex"
  | "opencode"
  | "sweagent"
  | "elizaos-native";

/**
 * Configuration options for sub-agents
 */
export interface SubAgentConfig {
  /** The type of sub-agent to use */
  type: SubAgentType;
  /** Override the model used by the sub-agent */
  model?: string;
  /** Maximum iterations/turns for the sub-agent */
  maxIterations?: number;
  /** Custom system prompt override */
  systemPromptOverride?: string;
  /** Enable Context7 MCP for documentation lookup */
  enableContext7?: boolean;
  /** Enable goals provider in context */
  enableGoals?: boolean;
  /** Enable todo tracking during task execution */
  enableTodos?: boolean;
  /** Enable thinking/monologue output */
  enableThinking?: boolean;
  /** Working directory for the sub-agent */
  workingDirectory?: string;
}

/**
 * Goal data available to sub-agents
 */
export interface SubAgentGoal {
  id: string;
  name: string;
  description?: string;
  isCompleted: boolean;
  tags?: string[];
}

/**
 * Todo item available to sub-agents
 */
export interface SubAgentTodo {
  id: string;
  name: string;
  description?: string;
  type: "daily" | "one-off" | "aspirational";
  priority?: 1 | 2 | 3 | 4;
  isCompleted: boolean;
  isUrgent?: boolean;
}

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
  subAgentType?: SubAgentType | string;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  error?: string;
  updateInterval?: number;
  /** Optional items for UI state selections */
  options?: Array<{ name: string; description: string }>;
  /** Goals context for the sub-agent */
  goals?: SubAgentGoal[];
  /** Todos created during task execution */
  todos?: SubAgentTodo[];
}

/** Code task - uses core Task with typed metadata */
export interface CodeTask extends Omit<CoreTask, "metadata"> {
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
