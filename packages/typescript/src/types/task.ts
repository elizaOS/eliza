import type { Memory } from "./memory";
import type { UUID } from "./primitives";
import type {
  JsonValue,
  Task as ProtoTask,
  TaskMetadata as ProtoTaskMetadata,
  TaskStatus as ProtoTaskStatus,
} from "./proto.js";
import type { IAgentRuntime } from "./runtime";
import type { State } from "./state";

/**
 * Defines the contract for a Task Worker, which is responsible for executing a specific type of task.
 * Task workers are registered with the `AgentRuntime` and are invoked when a `Task` of their designated `name` needs processing.
 * This pattern allows for modular and extensible background task processing.
 */
export interface TaskWorker {
  /** The unique name of the task type this worker handles. This name links `Task` instances to this worker. */
  name: string;
  /**
   * The core execution logic for the task. This function is called by the runtime when a task needs to be processed.
   * It receives the `AgentRuntime`, task-specific `options`, and the `Task` object itself.
   */
  execute: (
    runtime: IAgentRuntime,
    options: Record<string, JsonValue | object>,
    task: Task,
  ) => Promise<void>;
  /**
   * Optional validation function that can be used to determine if a task is valid or should be executed,
   * often based on the current message and state. This might be used by an action or evaluator
   * before creating or queueing a task.
   */
  validate?: (
    runtime: IAgentRuntime,
    message: Memory,
    state: State,
  ) => Promise<boolean>;
}

/**
 * Defines metadata associated with a `Task`.
 * This can include scheduling information like `updateInterval` or UI-related details
 * for presenting task options to a user.
 * The `[key: string]: unknown;` allows for additional, unspecified metadata fields.
 */
export interface TaskMetadata
  extends Omit<ProtoTaskMetadata, "$typeName" | "$unknown" | "values"> {
  targetEntityId?: string;
  reason?: string;
  priority?: "low" | "medium" | "high";
  message?: string;
  status?: string;
  scheduledAt?: string;
  snoozedAt?: string;
  originalScheduledAt?: JsonValue;
  createdAt?: string;
  completedAt?: string;
  completionNotes?: string;
  lastExecuted?: string;
  updatedAt?: number;
  /** Optional. If the task is recurring, this specifies the interval in milliseconds between updates or executions. */
  updateInterval?: number;
  /** Optional. Describes options or parameters that can be configured for this task, often for UI presentation. */
  options?: {
    name: string;
    description: string;
  }[];
  /** Allows for other dynamic metadata properties related to the task. */
  values?: Record<string, JsonValue | object>;
  [key: string]: JsonValue | object | undefined;
}

/**
 * Represents a task to be performed, often in the background or at a later time.
 * Tasks are managed by the `AgentRuntime` and processed by registered `TaskWorker`s.
 * They can be associated with a room, world, and tagged for categorization and retrieval.
 * The `IDatabaseAdapter` handles persistence of task data.
 */
export interface Task
  extends Omit<
    ProtoTask,
    | "$typeName"
    | "$unknown"
    | "id"
    | "roomId"
    | "worldId"
    | "entityId"
    | "metadata"
    | "createdAt"
    | "updatedAt"
    | "dueAt"
    | "status"
  > {
  id?: UUID;
  roomId?: UUID;
  worldId?: UUID;
  entityId?: UUID;
  metadata?: TaskMetadata;
  createdAt?: number | bigint;
  updatedAt?: number | bigint;
  dueAt?: number | bigint;
  status?: ProtoTaskStatus;
}
