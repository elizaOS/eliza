import type { IAgentRuntime, Memory } from "@elizaos/core";

/** Specification for a task to be executed */
export interface TaskSpec {
  id: string;
  description: string;
  type: string;
  metadata?: Record<string, unknown>;
  agentType?: string;
  message?: Memory;
}

/** Result from a completed task */
export interface TaskResult {
  taskId: string;
  success: boolean;
  output?: string;
  artifacts?: Array<{ name: string; path: string; type: string }>;
  error?: string;
  durationMs?: number;
}

/** Interface for task executors that handle specific task types */
export interface TaskExecutor {
  /** Unique type identifier (e.g., "coding", "research", "content") */
  readonly type: string;

  /** Human-readable description of what this executor handles */
  readonly description: string;

  /** Check if this executor can handle the given task */
  canHandle(spec: TaskSpec, runtime: IAgentRuntime): boolean;

  /** Execute the task and return results */
  execute(spec: TaskSpec, runtime: IAgentRuntime): Promise<TaskResult>;

  /** Abort a running task */
  abort(taskId: string): Promise<void>;
}

/** Registry for task executors */
export class TaskExecutorRegistry {
  private executors: Map<string, TaskExecutor> = new Map();

  register(executor: TaskExecutor): void {
    this.executors.set(executor.type, executor);
  }

  unregister(type: string): void {
    this.executors.delete(type);
  }

  /** Find the best executor for a task spec */
  findExecutor(
    spec: TaskSpec,
    runtime: IAgentRuntime,
  ): TaskExecutor | undefined {
    // If task has explicit type, try that first
    if (spec.type) {
      const explicit = this.executors.get(spec.type);
      if (explicit?.canHandle(spec, runtime)) return explicit;
    }
    // Otherwise, find first executor that can handle it
    for (const executor of this.executors.values()) {
      if (executor.canHandle(spec, runtime)) return executor;
    }
    return undefined;
  }

  getAll(): TaskExecutor[] {
    return Array.from(this.executors.values());
  }

  get(type: string): TaskExecutor | undefined {
    return this.executors.get(type);
  }
}
