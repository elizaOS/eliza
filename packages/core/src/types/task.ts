import type { Memory } from './memory';
import type { UUID } from './primitives';
import type { IAgentRuntime } from './runtime';
import type { State } from './state';

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
    options: { [key: string]: unknown },
    task: Task
  ) => Promise<void>;
  /**
   * Optional validation function that can be used to determine if a task is valid or should be executed,
   * often based on the current message and state. This might be used by an action or evaluator
   * before creating or queueing a task.
   */
  validate?: (runtime: IAgentRuntime, message: Memory, state: State) => Promise<boolean>;
}

/**
 * Defines metadata associated with a `Task`.
 * This can include scheduling information like `updateInterval` or UI-related details
 * for presenting task options to a user.
 * The `[key: string]: unknown;` allows for additional, unspecified metadata fields.
 */
export type TaskMetadata = {
  /** Optional. If the task is recurring, this specifies the interval in milliseconds between updates or executions. */
  updateInterval?: number;
  /** Optional. Describes options or parameters that can be configured for this task, often for UI presentation. */
  options?: {
    name: string;
    description: string;
  }[];
  /** Allows for other dynamic metadata properties related to the task. */
  [key: string]: unknown;
};

/**
 * Represents a task to be performed, often in the background or at a later time.
 * Tasks are managed by the `AgentRuntime` and processed by registered `TaskWorker`s.
 * They can be associated with a room, world, and tagged for categorization and retrieval.
 * The `IDatabaseAdapter` handles persistence of task data.
 */
export interface Task {
  /** Optional. A Universally Unique Identifier for the task. Generated if not provided. */
  id?: UUID;
  /** The name of the task, which should correspond to a registered `TaskWorker.name`. */
  name: string;
  /** Optional. Timestamp of the last update to this task. */
  updatedAt?: number;
  /** Optional. Metadata associated with the task, conforming to `TaskMetadata`. */
  metadata?: TaskMetadata;
  /** A human-readable description of what the task does or its purpose. */
  description: string;
  /** Optional. The UUID of the room this task is associated with. */
  roomId?: UUID;
  /** Optional. The UUID of the world this task is associated with. */
  worldId?: UUID;
  entityId?: UUID;
  tags: string[];
}
