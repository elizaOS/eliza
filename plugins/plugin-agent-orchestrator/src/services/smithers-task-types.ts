/**
 * Types for the durable Smithers-backed coding-task runner.
 *
 * A coding task is modelled as a durable Smithers workflow:
 *   provision → (durable loop of agent turns) → approval gate → submit → summarize
 *
 * Smithers owns scheduling + durable per-step/per-iteration SQLite state (so a
 * crashed agent resumes from the last completed turn). The actual work of each
 * step is delegated back to the host through a {@link TaskStepExecutor}; the
 * runner never drives a coding agent itself — it drives the *control plane* and
 * calls the executor, which in production is backed by the ACP services.
 */

/** A coding task to run on the durable engine. */
export interface TaskRunSpec {
  /** Stable task id (also used to name the per-task SQLite file). */
  taskId: string;
  /**
   * Stable Smithers run id. Re-running with the same id resumes a crashed run
   * from its last completed step/turn. Generate once per task, persist it, and
   * reuse it on restart.
   */
  runId: string;
  /** Initial prompt handed to the agent on the first turn. */
  initialPrompt: string;
  /** Adapter/agent type label (informational; the executor owns spawning). */
  agentType?: string;
  /** Run a provision step (workspace setup) before the agent loop. */
  provision?: boolean;
  /** Run a submit step (commit/push/PR) after the agent loop. */
  submit?: boolean;
  /** Require an approval decision before the submit step. */
  approvalBeforeSubmit?: boolean;
  /** Max agent turns before stopping (replaces the hand-rolled round-trip cap). */
  maxTurns?: number;
  /** Number of agents to fan out in parallel (default 1). */
  parallelAgents?: number;
}

/** Per-step context passed to the executor. */
export interface TaskStepContext {
  taskId: string;
  runId: string;
  /** 1-based turn counter for the current agent loop (best-effort across resume). */
  turn?: number;
  /** 0-based agent index when fanning out (`parallelAgents > 1`). */
  agentIndex?: number;
  /** The task's initial prompt. */
  prompt?: string;
}

export interface TaskProvisionResult {
  workspace: Record<string, unknown>;
}

/** Result of one agent turn. `done: true` ends the loop early (task complete). */
export interface TaskTurnResult {
  done: boolean;
  output?: Record<string, unknown>;
}

export interface TaskApprovalResult {
  approved: boolean;
  reason?: string;
}

export interface TaskSubmitResult {
  output: Record<string, unknown>;
}

/**
 * The seam between the durable control plane and the real coding-agent work.
 * In production this is backed by `AcpService` / `CodingWorkspaceService`; in
 * tests it is a fake. Only `runTurn` is required.
 */
export interface TaskStepExecutor {
  provision?(ctx: TaskStepContext): Promise<TaskProvisionResult>;
  /** Advance the agent one turn; report whether the task is complete. */
  runTurn(ctx: TaskStepContext): Promise<TaskTurnResult>;
  requestApproval?(ctx: TaskStepContext): Promise<TaskApprovalResult>;
  submit?(ctx: TaskStepContext): Promise<TaskSubmitResult>;
}

export type TaskRunStatus = "completed" | "incomplete" | "denied";

export interface TaskRunMetrics {
  turns: number;
  agents: number;
  retries: number;
  durationMs: number;
}

export interface TaskRunResult {
  taskId: string;
  runId: string;
  status: TaskRunStatus;
  /** Total agent turns executed across all agents. */
  turns: number;
  approved: boolean;
  workspace?: Record<string, unknown>;
  submit?: Record<string, unknown>;
  /** Per-agent completion flags (length === parallelAgents). */
  agentsDone: boolean[];
  metrics: TaskRunMetrics;
}
