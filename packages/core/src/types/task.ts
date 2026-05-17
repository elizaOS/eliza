import type { Memory } from "./memory";
import type { JsonValue, UUID } from "./primitives";
import type { IAgentRuntime } from "./runtime";
import type { State } from "./state";
import type { TriggerConfig, TriggerRunRecord } from "./trigger";

export const TaskStatus = {
	UNSPECIFIED: "UNSPECIFIED",
	PENDING: "PENDING",
	IN_PROGRESS: "IN_PROGRESS",
	COMPLETED: "COMPLETED",
	FAILED: "FAILED",
	CANCELLED: "CANCELLED",
} as const;

export type TaskStatus = (typeof TaskStatus)[keyof typeof TaskStatus];

/**
 * Defines the contract for a Task Worker, which is responsible for executing a specific type of task.
 * Task workers are registered with the `AgentRuntime` and are invoked when a `Task` of their designated `name` needs processing.
 * WHY two gates: shouldRun (scheduler) has no message/state; canExecute (actions) has full context for auth (e.g. approval roles).
 */
export interface TaskWorker {
	/** The unique name of the task type this worker handles. This name links `Task` instances to this worker. */
	name: string;
	/**
	 * The core execution logic for the task. This function is called by the runtime when a task needs to be processed.
	 * It receives the `AgentRuntime`, task-specific `options`, and the `Task` object itself.
	 * May return `{ nextInterval?: number }` to dynamically adjust the task's updateInterval (recurring tasks only).
	 * WHY return nextInterval: workers can adapt rate (e.g. back off under load) without separate updateTask calls.
	 */
	execute: (
		runtime: IAgentRuntime,
		options: Record<string, JsonValue | object>,
		task: Task,
	) => Promise<undefined | { nextInterval?: number }>;
	/**
	 * Called by the scheduler before each run -- "should this task run now?"
	 * If absent, the task always passes scheduler validation.
	 * WHY separate from execute: scheduler has no message/state; avoids loading context just to skip.
	 */
	shouldRun?: (runtime: IAgentRuntime, task: Task) => Promise<boolean>;
	/**
	 * Called by actions (e.g. choice) to check authorization -- "can this user trigger this task?"
	 * If absent, execution is always allowed.
	 * WHY separate from shouldRun: choice action has message/state for role checks (e.g. approval allowedRoles).
	 */
	canExecute?: (
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
export interface TaskMetadata {
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
	/** Optional. Original interval to restore on success when worker does not return nextInterval. WHY: backoff multiplies interval; we need the original base so we don't compound (exponential-of-exponential). */
	baseInterval?: number;
	/** Optional. Window (ms) before ideal next run when task may run. Earliest run = idealNextRun - notBefore. WHY: allows jitter/earlier run within a window. */
	notBefore?: number;
	/** Optional. Window (ms) after ideal next run; run is considered overdue after idealNextRun + notAfter. WHY: detect and log overdue tasks. */
	notAfter?: number;
	/** Optional. If true, the scheduler skips this task. WHY: operators pause/resume via API without deleting the task. */
	paused?: boolean;
	/** Optional. Consecutive failure count; reset to 0 on success. WHY: drive backoff and auto-pause after maxFailures. */
	failureCount?: number;
	/** Optional. Auto-pause after this many consecutive failures. undefined = 5. Use -1 (not Infinity; JSON loses it) to never auto-pause. WHY: prevent infinite retry storms; operators can resume after fixing. */
	maxFailures?: number;
	/** Optional. Last error message for debugging. WHY: getTaskStatus and logs show why a task failed. */
	lastError?: string;
	/**
	 * Optional. If true (default), the task will block the next scheduled execution while it's running.
	 * Set to false to allow overlapping executions (use with caution - can cause resource contention).
	 * @default true
	 */
	blocking?: boolean;
	/** Optional. Describes options or parameters that can be configured for this task, often for UI presentation. */
	options?: {
		name: string;
		description: string;
	}[];
	/** Allows for other dynamic metadata properties related to the task. */
	values?: Record<string, JsonValue | object>;
	/** Optional. Trigger configuration for trigger-based tasks. */
	trigger?: TriggerConfig;
	/** Optional. History of trigger run records. */
	triggerRuns?: TriggerRunRecord[];
	[key: string]: JsonValue | object | undefined;
}

/**
 * Represents a task to be performed, often in the background or at a later time.
 * Tasks are managed by the `AgentRuntime` and processed by registered `TaskWorker`s.
 * They can be associated with a room, world, and tagged for categorization and retrieval.
 * The `IDatabaseAdapter` handles persistence of task data.
 */
export interface Task {
	id?: UUID;
	name: string;
	description?: string;
	tags?: string[];
	roomId?: UUID;
	worldId?: UUID;
	entityId?: UUID;
	/** Agent that owns this task. WHY: multi-tenant safety; getTasks can filter by agentId so each runtime only sees its tasks. */
	agentId?: UUID;
	metadata?: TaskMetadata;
	createdAt?: number | bigint;
	updatedAt?: number | bigint;
	dueAt?: number | bigint;
	status?: TaskStatus;
}

/**
 * Status returned by TaskService.getTaskStatus for a single task.
 * WHY: operators and UIs need nextRunAt, paused, lastError without reading raw task metadata.
 */
export interface TaskRunStatus {
	task: Task | null;
	paused: boolean;
	executing: boolean;
	nextRunAt?: number;
	lastError?: string;
}
