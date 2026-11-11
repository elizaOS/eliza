/**
 * TaskService: the runtime singleton that polls `queue`-tagged tasks and runs
 * their registered worker when due. Owns the tick loop — a local timer armed
 * for the earliest due task, a shared task-scheduler daemon, or serverless
 * `runDueTasks()` — plus repeat-task cadence, failure backoff and auto-pause,
 * and overlap suppression for blocking runs. Registered by the basic-capabilities plugin and reached
 * via `runtime.getService(ServiceType.TASK)`.
 */

import { ElizaError } from "../errors";
import { withStandaloneTrajectory } from "../trajectory-utils";
import type { UUID } from "../types/primitives";
import type { JsonValue } from "../types/primitives.js";
import type { IAgentRuntime } from "../types/runtime";
import { Service, ServiceType } from "../types/service";
import type { Task, TaskMetadata, TaskRunStatus } from "../types/task";
import {
	getTaskSchedulerAdapter,
	markTaskSchedulerDirty,
	registerTaskSchedulerRuntime,
	unregisterTaskSchedulerRuntime,
} from "./task-scheduler";

/** Resolve task due time (ms) from dueAt or metadata.scheduledAt. Returns null if not set (run immediately). */
function resolveDueTime(task: Task): number | null {
	// Callers only pass tasks whose dueAt passed invalidScheduleField: a finite number or bigint.
	if (task.dueAt != null) return Number(task.dueAt);
	const scheduledAt = task.metadata?.scheduledAt;
	if (scheduledAt == null) return null;
	if (typeof scheduledAt === "number") return scheduledAt;
	const t = new Date(scheduledAt).getTime();
	return Number.isNaN(t) ? null : t;
}

/** Time (ms) a task last ran: metadata.updatedAt, else the row's updatedAt, else 0. */
function lastRanAt(task: Task): number {
	if (typeof task.metadata?.updatedAt === "number") {
		return task.metadata.updatedAt;
	}
	if (typeof task.updatedAt === "number") return task.updatedAt;
	if (typeof task.updatedAt === "bigint") return Number(task.updatedAt);
	if (task.updatedAt) return new Date(String(task.updatedAt)).getTime();
	return 0;
}

/** Earliest time (ms) a repeat task may run: its interval less notBefore, or an atomic wake. */
function repeatDueAt(task: Task, atomicWake: boolean): number {
	const meta = task.metadata;
	const idealNextRun = lastRanAt(task) + (meta?.updateInterval ?? 0);
	const wakeAt = atomicWake && !meta?.failureCount ? meta?.wakeAt : undefined;
	return Math.min(idealNextRun - (meta?.notBefore ?? 0), wakeAt ?? Infinity);
}

/**
 * Wake delay (ms) after a task change, and the retry delay for a due task that
 * did not run (a false shouldRun, a blocking run in progress, a preserved task).
 * This is the old fixed tick, so no task runs later than before.
 */
const MIN_TICK_MS = 1000;
/**
 * Default longest sleep with a non-empty queue. A queue row written without a
 * runtime task write (another process sharing the database) is seen within
 * this time, not within 1 s as with the old fixed poll. Multi-process hosts
 * should use the task-scheduler daemon or set TASK_TICK_MAX_MS=1000.
 */
const DEFAULT_MAX_TICK_MS = 60_000;
/** Largest delay setTimeout accepts. */
const MAX_TIMEOUT_MS = 2_147_483_647;
/**
 * Runtime setting that overrides the longest sleep (ms, MIN_TICK_MS to
 * MAX_TIMEOUT_MS). 1000 keeps the old 1 s poll.
 */
export const TASK_TICK_MAX_MS_SETTING = "TASK_TICK_MAX_MS";
/**
 * The system clock checks the wall clock this often during a long sleep, with
 * no query. Timers count monotonic time, which stops while the device is
 * suspended and ignores wall-clock changes; this check keeps an overdue task
 * within 1 s of resume or of a clock jump, as with the old poll.
 */
export const WALL_CLOCK_CHECK_MS = 1000;

function readMaxTickMs(runtime: IAgentRuntime): number {
	const raw = runtime.getSetting(TASK_TICK_MAX_MS_SETTING);
	if (raw == null || raw === "") return DEFAULT_MAX_TICK_MS;
	const value = Number(raw);
	if (!(value >= MIN_TICK_MS && value <= MAX_TIMEOUT_MS)) {
		throw new ElizaError(
			`${TASK_TICK_MAX_MS_SETTING} must be ${MIN_TICK_MS} to ${MAX_TIMEOUT_MS} milliseconds`,
			{
				code: "TASK_TICK_MAX_INVALID",
				context: { value: String(raw) },
				severity: "fatal",
			},
		);
	}
	return value;
}

/** Opaque handle returned by an injected task-service timer implementation. */
export type TaskServiceTimerHandle = unknown;

/** A one-shot timer clock. `setTimeout` fires once, at or after now() + delayMs. */
export interface TaskServiceTimeoutClock {
	now(): number;
	setTimeout(
		callback: () => Promise<void>,
		delayMs: number,
	): TaskServiceTimerHandle;
	clearTimeout(handle: TaskServiceTimerHandle): void;
}

/** @deprecated The old repeating-timer clock shape; give setTimeout/clearTimeout instead. */
export interface TaskServiceIntervalClock {
	now(): number;
	setInterval(
		callback: () => Promise<void>,
		intervalMs: number,
	): TaskServiceTimerHandle;
	clearInterval(handle: TaskServiceTimerHandle): void;
}

/**
 * Time boundary used by TaskService. Production uses the system clock and
 * timeout APIs; deterministic hosts can supply a virtual clock without
 * replacing task persistence, validation, or worker execution. The old
 * setInterval/clearInterval shape still works and is used one shot at a time.
 */
export type TaskServiceClock =
	| TaskServiceTimeoutClock
	| TaskServiceIntervalClock;

function toTimeoutClock(clock: TaskServiceClock): TaskServiceTimeoutClock {
	if ("setTimeout" in clock) return clock;
	return {
		now: () => clock.now(),
		setTimeout: (callback, delayMs) => {
			let fired = false;
			const handle = clock.setInterval(async () => {
				if (fired) return;
				fired = true;
				clock.clearInterval(handle);
				await callback();
			}, delayMs);
			return handle;
		},
		clearTimeout: (handle) => clock.clearInterval(handle),
	};
}

/**
 * Fire `callback` once Date.now() reaches now + delayMs. Sleeps in pieces of
 * at most WALL_CLOCK_CHECK_MS so a suspend or a wall-clock jump forward
 * delays it by at most one piece.
 */
export const systemTaskServiceClock: TaskServiceTimeoutClock = {
	now: () => Date.now(),
	setTimeout: (callback, delayMs) => {
		const target = Date.now() + delayMs;
		const handle: { native?: ReturnType<typeof setTimeout> } = {};
		const step = () => {
			const left = target - Date.now();
			if (left <= 0) {
				handle.native = undefined;
				void callback();
				return;
			}
			handle.native = setTimeout(step, Math.min(left, WALL_CLOCK_CHECK_MS));
		};
		handle.native = setTimeout(
			step,
			Math.max(0, Math.min(delayMs, WALL_CLOCK_CHECK_MS)),
		);
		return handle;
	},
	clearTimeout: (handle) => {
		const h = handle as { native?: ReturnType<typeof setTimeout> };
		if (h.native !== undefined) clearTimeout(h.native);
		h.native = undefined;
	},
};

/**
 * Each tick validates due `queue` tasks against their worker's `shouldRun`,
 * then runs `worker.execute`. Repeat tasks reschedule on their interval (with
 * failure backoff); one-shot tasks are deleted after running. A task paused via
 * `metadata.paused` (operator or API) is skipped by every tick regardless of
 * tags — a paused one-shot stays in the store until it is resumed.
 */
export class TaskService extends Service {
	private timer: TaskServiceTimerHandle;
	private hasTimer = false;
	/** Time (ms) the armed timer fires. */
	private timerAt = 0;
	/** True once startTimer() runs the local timer (not serverless, no daemon). */
	private localTimer = false;
	private maxTickMs = DEFAULT_MAX_TICK_MS;
	private activeTick: Promise<void> | null = null;
	private schedulerDrain: Promise<void> | undefined;
	private readonly clock: TaskServiceTimeoutClock;
	/** Count overlapping invocations so exclusivity sees every active owner. */
	private executingTasks = new Map<string, number>();
	/** Admitted execution operations include preflight, storage reads and worker settlement. */
	private pendingOperations = new Set<Promise<void>>();
	/** Tracks tasks quarantined for missing workers, preventing repeated diagnostics while pause/delete operations settle. */
	private quarantinedOrphans = new Set<string>();
	/**
	 * Service construction time (epoch-ms). A missing worker inside
	 * {@link TaskService.ORPHAN_GRACE_MS} of this moment is treated as "not
	 * registered YET" (boot ordering: the first tick can start before every plugin
	 * has registered its workers), not as an orphan. WHY: without the grace, a
	 * healthy task whose plugin registers a beat later was wrongly quarantined —
	 * repeat tasks auto-paused, one-shots DELETED — and the first tick emitted
	 * the TASK_WORKER_MISSING diagnostic that painted red system lines into the
	 * owner's chat view on every boot.
	 */
	private readonly startedAt: number;
	/** Closes admission synchronously before runtime teardown; active work still drains. */
	private stopped = false;
	/**
	 * Boot grace window (ms) during which a missing worker is skipped silently
	 * instead of quarantined. 60s comfortably covers slow plugin boots (remote
	 * capability sync, late schema migrations) while still healing a genuinely
	 * orphaned row within the first minute of steady-state.
	 */
	private static readonly ORPHAN_GRACE_MS = 60_000;
	static serviceType = ServiceType.TASK;
	capabilityDescription = "The agent is able to schedule and execute tasks";

	constructor(
		runtime?: IAgentRuntime,
		clock: TaskServiceClock = systemTaskServiceClock,
	) {
		super(runtime);
		this.clock = toTimeoutClock(clock);
		this.startedAt = clock.now();
	}

	/**
	 * Start the TaskService with the given runtime.
	 * @param {IAgentRuntime} runtime - The runtime for the TaskService.
	 * @returns {Promise<Service>} A promise that resolves with the TaskService instance.
	 */
	static async start(runtime: IAgentRuntime): Promise<Service> {
		const service = new TaskService(runtime);
		await service.startTimer();
		return service;
	}

	/**
	 * Start the task poll timer. Call explicitly in daemon mode; not started automatically.
	 * WHY public: initialize() does not start the task service or timer. Daemon entry points
	 * that need scheduled tasks call getService("task") then startTimer(). Edge/ephemeral
	 * runtimes typically do not call this.
	 * Priority: (1) serverless -> no timer, host calls runDueTasks(); (2) daemon present -> register, no local timer; (3) else a local timer.
	 * WHY serverless first: no long-lived process; WHY daemon second: one shared getTasks(agentIds) per tick for all agents.
	 * The local timer sleeps until the earliest due task (at most TASK_TICK_MAX_MS) and markDirty() wakes it.
	 */
	startTimer() {
		if (this.stopped) return;
		if (this.runtime.serverless === true) {
			return;
		}
		if (getTaskSchedulerAdapter() != null) {
			registerTaskSchedulerRuntime(this.runtime, this);
			return;
		}
		this.maxTickMs = readMaxTickMs(this.runtime);
		this.clearTimer();
		this.localTimer = true;
		this.armTimer(this.clock.now() + MIN_TICK_MS);
	}

	/** Make sure a tick runs at or before `at`. A later timer is replaced; an earlier one is kept. */
	private armTimer(at: number): void {
		if (this.stopped || !this.localTimer) return;
		if (this.hasTimer && this.timerAt <= at) return;
		this.clearTimer();
		this.timerAt = at;
		this.timer = this.clock.setTimeout(
			() => this.onTimer(),
			Math.max(0, at - this.clock.now()),
		);
		this.hasTimer = true;
	}

	private clearTimer(): void {
		if (!this.hasTimer) return;
		this.hasTimer = false;
		this.clock.clearTimeout(this.timer);
	}

	private async onTimer(): Promise<void> {
		this.hasTimer = false;
		if (this.stopped) return;
		if (this.activeTick) {
			// A host runDueTasks() or an earlier tick is still running; tick after it.
			void this.activeTick.then(() =>
				this.armTimer(this.clock.now() + MIN_TICK_MS),
			);
			return;
		}
		const wake: { at: number | null } = {
			at: this.clock.now() + MIN_TICK_MS,
		};
		const tick = this.checkTasks(wake)
			.catch((error) => {
				// error-policy:J7 Timer-driven task processing reports failures while
				// keeping the scheduler alive for the next tick.
				this.runtime.reportError("TaskService.timer", error, {
					agentId: this.runtime.agentId,
				});
			})
			.finally(() => {
				if (this.activeTick === tick) {
					this.activeTick = null;
				}
			});
		this.activeTick = tick;
		await tick;
		if (wake.at !== null) this.armTimer(wake.at);
	}

	/**
	 * Next tick time for a non-empty queue: the earliest due task, or now +
	 * MIN_TICK_MS when a task is already due, capped at now + maxTickMs.
	 * Paused, quarantined and invalid tasks never run from a tick, so they are
	 * left out; a resume or fix is a task write, and that calls markDirty().
	 * The rows are the ones read before this tick runs them, so a task that runs
	 * now is still "due" here and gets one more check MIN_TICK_MS later; that
	 * check sees its new lastRan and sleeps until its next run.
	 */
	private nextWakeAt(tasks: Task[]): number {
		const now = this.clock.now();
		const atomicWake = this.runtime.adapter?.supportsAtomicTaskWake === true;
		let at = now + this.maxTickMs;
		for (const task of tasks) {
			if (
				!task.id ||
				task.metadata?.paused ||
				this.quarantinedOrphans.has(task.id) ||
				task.scheduleError !== undefined ||
				this.invalidScheduleField(task)
			) {
				continue;
			}
			const due = task.tags?.includes("repeat")
				? repeatDueAt(task, atomicWake)
				: (resolveDueTime(task) ?? now);
			at = Math.min(at, due > now ? due : now + MIN_TICK_MS);
		}
		return at;
	}

	/**
	 * Validates an array of Task objects.
	 * Skips tasks without IDs or if no worker is found for the task.
	 * Uses worker.shouldRun(runtime, task) when present; otherwise the task passes.
	 * @param {Task[]} tasks - An array of Task objects to validate.
	 * @returns {Promise<Task[]>} - A Promise that resolves with an array of validated Task objects.
	 */
	private async validateTasks(
		tasks: Task[],
	): Promise<{ tasks: Task[]; errors: ElizaError[] }> {
		const validatedTasks: Task[] = [];
		const errors: ElizaError[] = [];

		for (const task of tasks) {
			// Validation can await another worker before reaching this task.
			if (this.stopped) break;
			const context = { taskId: task.id, taskName: task.name };
			const metadata = task.metadata;
			if (metadata?.paused) {
				// Heal in BOTH directions: a repeat task WE paused for a missing
				// worker (orphanedNoWorker marker) must resume once a redeploy
				// re-registers that worker. Without this, the paused check here (which
				// runs before the worker lookup) stranded healed tasks paused forever.
				// Operator-paused tasks (no marker) are never touched.
				if (
					task.tags?.includes("repeat") &&
					metadata.orphanedNoWorker === true &&
					task.id &&
					this.runtime.getTaskWorker(task.name)
				) {
					await this.resumeHealedOrphanTask(task, metadata);
				}
				// Resumed or not, skip this tick; a resumed task runs when next due.
				// Skipping every paused task here also keeps a paused one-shot out
				// of the orphan path below, which would otherwise delete it when
				// its worker is unregistered.
				continue;
			}
			if (!task.id) {
				errors.push(
					new ElizaError("Scheduled task is missing an id", {
						code: "TASK_INVALID_ID",
						context,
						severity: "fatal",
					}),
				);
				continue;
			}

			if (task.scheduleError !== undefined) {
				errors.push(
					new ElizaError(task.scheduleError, {
						code: "TASK_SCHEDULE_INVALID",
						context: { ...context, field: "metadata.scheduledAt" },
						severity: "fatal",
					}),
				);
				continue;
			}

			const worker = this.runtime.getTaskWorker(task.name);
			if (!worker) {
				// Boot ordering: the tick can run before every plugin has registered
				// its workers. Inside the grace window a missing worker is "not
				// registered YET" — skip silently (no error, no heal). Quarantining
				// here wrongly paused/DELETED healthy tasks and emitted the
				// TASK_WORKER_MISSING noise seen on every staging boot.
				if (this.clock.now() - this.startedAt < TaskService.ORPHAN_GRACE_MS) {
					continue;
				}
				// Orphaned task: no worker registered in THIS build. Self-heal instead
				// of re-erroring every tick (the TASK_WORKER_MISSING → TASK_TICK_FAILED
				// loop that narrated into chat 9×). Emit the diagnostic ONCE per orphan.
				if (!this.quarantinedOrphans.has(task.id)) {
					await this.quarantineOrphanTask(task, errors);
				}
				continue;
			}
			// Worker is back (e.g. plugin reloaded / build redeployed): drop the
			// quarantine mark so a future disappearance re-heals + re-diagnoses once.
			if (this.quarantinedOrphans.has(task.id)) {
				this.quarantinedOrphans.delete(task.id);
			}

			const invalidField = this.invalidScheduleField(task);
			if (invalidField) {
				errors.push(
					new ElizaError(`Task ${task.name} has invalid ${invalidField}`, {
						code: "TASK_SCHEDULE_INVALID",
						context: { ...context, field: invalidField },
						severity: "fatal",
					}),
				);
				continue;
			}

			if (worker.shouldRun) {
				let shouldRun: unknown;
				try {
					shouldRun = await worker.shouldRun(this.runtime, task);
				} catch (cause) {
					// error-policy:J1 Preflight failures are collected into the
					// structured TASK_TICK_FAILED boundary below.
					errors.push(
						new ElizaError(`Task ${task.name} preflight failed`, {
							code: "TASK_PREFLIGHT_FAILED",
							context,
							cause,
							severity: "ephemeral",
						}),
					);
					continue;
				}
				if (typeof shouldRun !== "boolean") {
					errors.push(
						new ElizaError(
							`Task ${task.name} preflight returned a non-boolean`,
							{
								code: "TASK_PREFLIGHT_INVALID",
								context: { ...context, resultType: typeof shouldRun },
								severity: "fatal",
							},
						),
					);
					continue;
				}
				if (!shouldRun) continue;
			}

			validatedTasks.push(task);
		}

		return { tasks: validatedTasks, errors };
	}

	/**
	 * Self-heal an orphaned task whose worker is not registered in this build.
	 * Repeat orphans are PAUSED (survive a redeploy that re-registers the worker,
	 * and can be un-paused/inspected by an operator); non-repeat orphans are
	 * DELETED (a one-shot with no worker can never run — keeping it would re-fail
	 * every tick with no backoff). Marks the id quarantined and emits the
	 * diagnostic ONCE. WHY once: without the mark, every tick re-emitted
	 * TASK_WORKER_MISSING which the RECENT_ERRORS provider + repeat-escalation
	 * narrated into the owner's chat repeatedly (the observed 9× slop). A best-
	 * effort persistence failure is reported (once) but still marks quarantined
	 * so we don't renarrate on the next tick; the row will simply be re-healed if
	 * it reappears (idempotent pause/delete).
	 */
	private async quarantineOrphanTask(
		task: Task,
		errors: ElizaError[],
	): Promise<void> {
		if (!task.id) return;
		const context = { taskId: task.id, taskName: task.name };
		const isRepeat = task.tags?.includes("repeat") === true;
		try {
			if (isRepeat) {
				if (task.metadata?.paused !== true) {
					await this.runtime.updateTask(task.id, {
						metadata: {
							...task.metadata,
							paused: true,
							// Marks the pause as OURS so validateTasks can auto-resume it
							// when the worker re-registers. Operator pauses lack this flag
							// and are never auto-resumed.
							orphanedNoWorker: true,
							lastError: `No worker registered for task ${task.name} (orphan auto-paused)`,
							updatedAt: this.clock.now(),
						},
					});
				}
				this.runtime.logger.warn(
					{
						src: "plugin:basic-capabilities:service:task",
						agentId: this.runtime.agentId,
						...context,
					},
					"Orphaned repeat task auto-paused (no worker registered)",
				);
			} else {
				await this.runtime.deleteTask(task.id);
				this.runtime.logger.warn(
					{
						src: "plugin:basic-capabilities:service:task",
						agentId: this.runtime.agentId,
						...context,
					},
					"Orphaned one-shot task deleted (no worker registered)",
				);
			}
		} catch (cause) {
			// error-policy:J1 Quarantine failures join the single structured
			// task-validation failure reported by the tick boundary.
			// Persistence failed: still mark quarantined so we don't renarrate every
			// tick. Surface the heal failure ONCE (severity ephemeral so it can't push
			// the tick to fatal on its own). Report via the collected errors list so
			// it flows through the SAME single-diagnostic path, not a per-tick spam.
			errors.push(
				new ElizaError(`Failed to quarantine orphaned task ${task.name}`, {
					code: "TASK_ORPHAN_QUARANTINE_FAILED",
					context,
					cause,
					severity: "ephemeral",
				}),
			);
		}
		this.quarantinedOrphans.add(task.id);
	}

	/**
	 * Resume a repeat task that quarantineOrphanTask paused (orphanedNoWorker
	 * marker) now that its worker is registered again (plugin reloaded / build
	 * redeployed). Clears the pause + marker + lastError and drops the in-memory
	 * quarantine mark so a FUTURE disappearance re-heals and re-diagnoses once.
	 * Best-effort: a failed resume write is logged and retried on the next tick
	 * (the task simply stays paused until the write succeeds).
	 */
	private async resumeHealedOrphanTask(
		task: Task,
		metadata: TaskMetadata,
	): Promise<void> {
		if (!task.id) return;
		try {
			await this.runtime.updateTask(task.id, {
				metadata: {
					...metadata,
					paused: false,
					orphanedNoWorker: false,
					lastError: undefined,
					updatedAt: this.clock.now(),
				},
			});
			this.quarantinedOrphans.delete(task.id);
			this.runtime.logger.info(
				{
					src: "plugin:basic-capabilities:service:task",
					agentId: this.runtime.agentId,
					taskId: task.id,
					taskName: task.name,
				},
				"Orphan-paused task auto-resumed (worker registered again)",
			);
		} catch (cause) {
			// error-policy:J4 Resume is retried on the next tick; report the
			// still-paused state without failing unrelated scheduled tasks.
			// Logged only — resume is retried on the next tick; failing the whole
			// tick over a resume write would recreate the noise this path removes.
			this.runtime.logger.warn(
				{
					src: "plugin:basic-capabilities:service:task",
					agentId: this.runtime.agentId,
					taskId: task.id,
					taskName: task.name,
					err: cause,
				},
				"Failed to auto-resume orphan-paused task; will retry next tick",
			);
			this.runtime.reportError("TaskService.resumeOrphan", cause, {
				taskId: task.id,
				taskName: task.name,
			});
		}
	}

	private invalidScheduleField(task: Task): string | undefined {
		const finite = (value: unknown) =>
			typeof value === "number" && Number.isFinite(value);
		const metadata = task.metadata;
		if (task.dueAt != null) {
			const validDueAt =
				finite(task.dueAt) ||
				(typeof task.dueAt === "bigint" && Number.isFinite(Number(task.dueAt)));
			if (!validDueAt) return "dueAt";
		}
		if (
			metadata?.scheduledAt != null &&
			!finite(metadata.scheduledAt) &&
			Number.isNaN(new Date(String(metadata.scheduledAt)).getTime())
		) {
			return "metadata.scheduledAt";
		}
		if (!task.tags?.includes("repeat")) return undefined;
		if (
			!finite(metadata?.updateInterval) ||
			(metadata?.updateInterval ?? 0) <= 0
		)
			return "metadata.updateInterval";
		for (const field of ["updatedAt", "notBefore", "notAfter"] as const) {
			const value = metadata?.[field];
			if (value != null && (!finite(value) || value < 0))
				return `metadata.${field}`;
		}
		for (const field of ["wakeAt", "wakeRevision"] as const) {
			const value = metadata?.[field];
			if (value != null && (!Number.isSafeInteger(value) || value < 0))
				return `metadata.${field}`;
		}
		const failureCount = metadata?.failureCount;
		if (failureCount != null && (!finite(failureCount) || failureCount < 0)) {
			return "metadata.failureCount";
		}
		const baseInterval = metadata?.baseInterval;
		if (baseInterval != null && (!finite(baseInterval) || baseInterval <= 0)) {
			return "metadata.baseInterval";
		}
		const maxFailures = metadata?.maxFailures;
		if (
			maxFailures != null &&
			maxFailures !== Infinity &&
			!finite(maxFailures)
		) {
			return "metadata.maxFailures";
		}
		return undefined;
	}

	/**
	 * Checks tasks with the "queue" tag, validates them, then executes via runTick.
	 * Sets `wake.at` to the next tick time before running. An empty queue sets it to
	 * null: the timer then sleeps until markDirty(). A failed query leaves the caller's
	 * retry time.
	 */
	private async checkTasks(wake: { at: number | null }) {
		if (this.stopped) {
			wake.at = null;
			return;
		}

		// WHY queue only: approval/follow-up etc. are stored but run on user trigger or external cron; one place for "scheduled by tick".
		let allTasks: Task[];
		try {
			allTasks = await this.runtime.getTasks({
				tags: ["queue"],
				agentIds: [this.runtime.agentId],
			});
		} catch (error) {
			// error-policy:J2 Rethrow with task-query context. The caller keeps its
			// retry time, so a transient getTasks rejection does not stop the timer.
			throw new ElizaError("Task queue query failed", {
				code: "TASK_QUERY_FAILED",
				context: { agentId: this.runtime.agentId },
				cause: error,
				severity: "ephemeral",
			});
		}

		if (!allTasks || allTasks.length === 0) {
			// Empty queue: sleep until markDirty() (createTask/updateTask).
			wake.at = null;
			return;
		}

		wake.at = this.nextWakeAt(allTasks);

		if (this.stopped) {
			return;
		}
		await this.runTick(allTasks);
	}

	/**
	 * Validate and execute due tasks. Used by checkTasks (local timer) and by the task-scheduler daemon (batch tick).
	 * Does NOT call getTasks — caller must pass the task list. WHY: daemon does one getTasks(agentIds) then dispatches to N runTicks.
	 * No-op when service is already stopped (daemon may call after unregister).
	 */
	async runTick(tasks: Task[]): Promise<void> {
		if (this.stopped) return;
		return this.withExecutionAdmission(() => this.runTickInternal(tasks));
	}

	private async runTickInternal(tasks: Task[]): Promise<void> {
		const validation = await this.validateTasks(tasks);
		if (this.stopped) return;
		const failures: ElizaError[] = [...validation.errors];
		const now = this.clock.now();

		for (const task of validation.tasks) {
			if (this.stopped) break;
			// validateTasks already dropped paused tasks (pauseTask() promises later
			// ticks skip the row; a tick that captured its snapshot before the pause
			// persisted may still run it once, per pauseTask()).
			// Non-repeat tasks: run when due (or immediately if no dueAt/scheduledAt). WHY: one-shot "run at time X" (e.g. follow-up) uses dueAt or metadata.scheduledAt.
			if (!task.tags?.includes("repeat")) {
				const dueMs = resolveDueTime(task);
				if (dueMs != null && now < dueMs) continue;
				await this.executeTaskCollectingFailure(task, failures);
				continue;
			}

			const taskMetadata = task.metadata;
			const updateIntervalMs = taskMetadata?.updateInterval ?? 0;
			const notAfterMs = taskMetadata?.notAfter;
			const idealNextRun = lastRanAt(task) + updateIntervalMs;
			const earliest = repeatDueAt(
				task,
				this.runtime.adapter?.supportsAtomicTaskWake === true,
			);

			if (now < earliest) {
				continue;
			}

			if (notAfterMs != null && now > idealNextRun + notAfterMs) {
				this.runtime.logger.warn(
					{
						src: "plugin:basic-capabilities:service:task",
						agentId: this.runtime.agentId,
						taskName: task.name,
						taskId: task.id,
						overdueMs: now - (idealNextRun + notAfterMs),
					},
					"Task overdue",
				);
			}

			const isBlocking = task.metadata?.blocking !== false;
			if (isBlocking && task.id && this.executingTasks.has(task.id)) {
				this.runtime.logger.debug(
					{
						src: "plugin:basic-capabilities:service:task",
						agentId: this.runtime.agentId,
						taskName: task.name,
						taskId: task.id,
					},
					"Skipping task - already executing (blocking enabled)",
				);
				continue;
			}

			this.runtime.logger.debug(
				{
					src: "plugin:basic-capabilities:service:task",
					agentId: this.runtime.agentId,
					taskName: task.name,
					intervalMs: updateIntervalMs,
				},
				"Executing task - interval elapsed",
			);
			await this.executeTaskCollectingFailure(task, failures);
		}
		if (failures.length > 0) {
			throw new ElizaError(`${failures.length} scheduled task failure(s)`, {
				code: "TASK_TICK_FAILED",
				context: {
					failureCodes: failures.map((failure) => failure.code),
					failures: failures.map((failure) => ({
						code: failure.code,
						...(typeof failure.context?.taskId === "string"
							? { taskId: failure.context.taskId }
							: {}),
						...(typeof failure.context?.taskName === "string"
							? { taskName: failure.context.taskName }
							: {}),
					})),
				},
				cause: new AggregateError(failures),
				severity: failures.some((failure) => failure.severity === "fatal")
					? "fatal"
					: "ephemeral",
			});
		}
	}

	private async executeTaskCollectingFailure(
		task: Task,
		failures: ElizaError[],
	): Promise<void> {
		try {
			await this.executeTask(task);
		} catch (error) {
			// error-policy:J1 Independent task failures are aggregated into
			// the structured tick failure after all due tasks run.
			failures.push(
				error instanceof ElizaError
					? error
					: new ElizaError(`Task ${task.name} execution failed`, {
							code: "TASK_EXECUTION_FAILED",
							context: { taskId: task.id, taskName: task.name },
							cause: error,
						}),
			);
		}
	}

	private assertAcceptingExecution(): void {
		if (this.stopped) {
			throw new ElizaError("Task service has stopped accepting execution", {
				code: "TASK_SERVICE_STOPPED",
				severity: "ephemeral",
			});
		}
	}

	private releaseExecution(taskId: string): void {
		const remaining = (this.executingTasks.get(taskId) ?? 1) - 1;
		if (remaining > 0) this.executingTasks.set(taskId, remaining);
		else this.executingTasks.delete(taskId);
	}

	private async withExecutionAdmission<T>(
		operation: () => Promise<T>,
	): Promise<T> {
		this.assertAcceptingExecution();
		let settle!: () => void;
		const completion = new Promise<void>((resolve) => {
			settle = resolve;
		});
		this.pendingOperations.add(completion);
		try {
			return await operation();
		} finally {
			this.pendingOperations.delete(completion);
			settle();
		}
	}

	/**
	 * Executes a given task asynchronously.
	 * Tracks execution state to prevent overlapping runs of the same task.
	 * On success: resets failureCount, applies nextInterval if returned, writes updatedAt. Non-repeat tasks are deleted.
	 * On failure: repeat tasks get backoff (using baseInterval so we don't compound), auto-pause after maxFailures; non-repeat tasks are deleted so they don't retry forever.
	 * WHY delete non-repeat on failure: otherwise they stay in DB and run every tick with no backoff (infinite retry loop).
	 * WHY backoff uses baseInterval: after N failures updateInterval is already large; using it again would be exponential-of-exponential.
	 *
	 * @param {Task} task - The task to be executed.
	 */
	private async executeTask(task: Task) {
		this.assertAcceptingExecution();
		if (!task.id) {
			this.runtime.logger.debug(
				{
					src: "plugin:basic-capabilities:service:task",
					agentId: this.runtime.agentId,
				},
				"Task not found",
			);
			return;
		}

		const worker = this.runtime.getTaskWorker(task.name);
		if (!worker) {
			this.runtime.logger.debug(
				{
					src: "plugin:basic-capabilities:service:task",
					agentId: this.runtime.agentId,
					taskName: task.name,
				},
				"No worker found for task type",
			);
			return;
		}

		// One-shots and blocking repeats run exclusively on every path (timer,
		// daemon, runDueTasks, executeTaskById, resumeTask).
		const isRepeat = task.tags?.includes("repeat") === true;
		if (
			(!isRepeat || task.metadata?.blocking !== false) &&
			this.executingTasks.has(task.id)
		) {
			return;
		}
		this.executingTasks.set(
			task.id,
			(this.executingTasks.get(task.id) ?? 0) + 1,
		);
		if (!isRepeat) {
			// A one-shot from a stale snapshot may already have run and been
			// deleted. The read sits outside the failure path below, so a failed
			// read propagates and leaves the row in place.
			let current: Task | null;
			try {
				current = await this.runtime.getTask(task.id);
			} catch (error) {
				this.releaseExecution(task.id);
				throw error;
			}
			if (!current || this.stopped) {
				this.releaseExecution(task.id);
				return;
			}
		}
		const startTime = this.clock.now();
		const observedWakeRevision = task.metadata?.wakeRevision;
		const observedWakeAt = task.metadata?.wakeAt;

		try {
			const taskOptions = (task.metadata ?? {}) as Record<
				string,
				JsonValue | object
			>;
			const result = await withStandaloneTrajectory(
				this.runtime,
				{
					source: "task",
					metadata: { taskId: task.id, taskName: task.name },
					deferUntilModelCall: true,
				},
				() => worker.execute(this.runtime, taskOptions, task),
			);
			if (result?.preserveTask) {
				return;
			}

			if (task.tags?.includes("repeat")) {
				const latestTask = await this.runtime.getTask(task.id);
				if (!latestTask) {
					return;
				}
				const meta = latestTask.metadata;
				const baseInterval = meta?.baseInterval ?? meta?.updateInterval;
				const bookkeeping: Partial<TaskMetadata> = {
					updatedAt: this.clock.now(),
					failureCount: 0,
				};
				const cleared: (keyof TaskMetadata)[] = ["lastError"];
				const nextInterval =
					result != null &&
					typeof result === "object" &&
					"nextInterval" in result
						? (result as { nextInterval?: number }).nextInterval
						: undefined;
				if (
					nextInterval != null &&
					(typeof nextInterval !== "number" ||
						!Number.isFinite(nextInterval) ||
						nextInterval <= 0)
				) {
					throw new ElizaError(
						`Task ${task.name} returned an invalid nextInterval`,
						{
							code: "TASK_ADAPTIVE_INTERVAL_INVALID",
							context: { taskId: task.id, taskName: task.name, nextInterval },
							severity: "fatal",
						},
					);
				}
				if (nextInterval != null) {
					bookkeeping.updateInterval = nextInterval;
					cleared.push("baseInterval");
				} else if (baseInterval != null) {
					bookkeeping.updateInterval = baseInterval;
				}
				const nextWakeAt = result?.nextWakeAt;
				if (
					nextWakeAt !== undefined &&
					(!Number.isSafeInteger(nextWakeAt) || nextWakeAt < 0)
				)
					throw new ElizaError("Task returned an invalid absolute wake", {
						code: "TASK_WAKE_INVALID",
					});
				if (
					this.runtime.adapter?.supportsAtomicTaskWake === true &&
					(observedWakeAt !== undefined || nextWakeAt !== undefined)
				) {
					const outcome = await this.runtime.patchTaskMetadata(task.id, {
						set: bookkeeping,
						unset: cleared,
						wake: {
							consumeRevision: observedWakeRevision ?? 0,
							...(nextWakeAt !== undefined ? { requestAt: nextWakeAt } : {}),
						},
					});
					if (outcome === "unsupported")
						throw new ElizaError("Atomic task wake capability was withdrawn", {
							code: "TASK_WAKE_UNSUPPORTED",
						});
				} else {
					if (nextWakeAt !== undefined)
						this.runtime.reportError(
							"TaskService.absoluteWake",
							new ElizaError(
								"Adapter retains interval cadence; atomic wake unavailable",
								{ code: "TASK_WAKE_UNSUPPORTED" },
							),
							{ taskId: task.id, diagnosticOnly: true },
						);
					await this.persistTaskMetadata(task.id, meta, bookkeeping, cleared);
				}
			} else {
				await this.runtime.deleteTask(task.id);
				this.runtime.logger.debug(
					{
						src: "plugin:basic-capabilities:service:task",
						agentId: this.runtime.agentId,
						taskName: task.name,
						taskId: task.id,
					},
					"Deleted non-repeating task after execution",
				);
			}
		} catch (error) {
			// error-policy:J2 Persist failure state and rethrow a typed task error
			// that preserves both execution and persistence causes.
			let persistenceError: unknown;
			try {
				if (task.tags?.includes("repeat")) {
					const latestTask = await this.runtime.getTask(task.id);
					if (!latestTask) {
						return;
					}
					const meta = latestTask.metadata;
					const failureCount = (meta?.failureCount ?? 0) + 1;
					const rawMax = meta?.maxFailures;
					// maxFailures <= 0 (or Infinity) = never auto-pause. WHY: critical heartbeats (e.g. the
					// LifeOps scheduler) must survive transient failure storms; a paused heartbeat is a
					// permanently-dead subsystem until an operator notices. 0/-1 survive JSON round-trips.
					const neverPause =
						rawMax === Infinity || (typeof rawMax === "number" && rawMax <= 0);
					const maxFailures = neverPause ? Infinity : (rawMax ?? 5);
					const failedAt = this.clock.now();
					const newMeta: Partial<TaskMetadata> = {
						updatedAt: failedAt,
						failureCount,
						lastError: error instanceof Error ? error.message : String(error),
					};
					if (!neverPause && failureCount >= maxFailures) {
						newMeta.paused = true;
						this.runtime.logger.warn(
							{
								taskName: task.name,
								taskId: task.id,
								failureCount,
							},
							"Task auto-paused after max failures",
						);
					} else {
						const baseInterval =
							meta?.baseInterval ?? meta?.updateInterval ?? 1000;
						// Persist the resolved base the FIRST time we back off. Without it,
						// the next failure's fallback reads the already-doubled
						// updateInterval (the exponential-of-exponential this branch exists
						// to prevent) and a later success "restores" updateInterval to the
						// inflated backoff value permanently instead of the original cadence.
						newMeta.baseInterval = baseInterval;
						newMeta.updateInterval = Math.min(
							baseInterval * 2 ** failureCount,
							300_000,
						);
						if (
							error instanceof ElizaError &&
							typeof error.retryAt === "number" &&
							Number.isFinite(error.retryAt)
						) {
							// Provider deadlines are floors, not capped exponential backoff.
							// Compensate for the scheduler's optional early-run tolerance.
							newMeta.updateInterval = Math.max(
								newMeta.updateInterval,
								error.retryAt - failedAt + (meta?.notBefore ?? 0),
							);
						}
					}
					await this.persistTaskMetadata(task.id, meta, newMeta);
				} else if (task.id) {
					await this.runtime.deleteTask(task.id);
					this.runtime.logger.debug(
						{
							src: "plugin:basic-capabilities:service:task",
							agentId: this.runtime.agentId,
							taskName: task.name,
							taskId: task.id,
						},
						"Deleted non-repeating task after execution failure",
					);
				}
			} catch (cause) {
				// error-policy:J2 The outer handler combines this persistence
				// failure with the original execution failure.
				persistenceError = cause;
			}
			const cause = persistenceError
				? new AggregateError(
						[error, persistenceError],
						"Task execution and state transition failed",
					)
				: error;
			const failure =
				!persistenceError && error instanceof ElizaError
					? error
					: new ElizaError(`Task ${task.name} execution failed`, {
							code: persistenceError
								? "TASK_EXECUTION_STATE_FAILED"
								: "TASK_EXECUTION_FAILED",
							context: { taskName: task.name, taskId: task.id },
							cause,
							severity: persistenceError ? "fatal" : "ephemeral",
						});
			this.runtime.logger.error(
				{ taskName: task.name, taskId: task.id, error: failure },
				"Task execution failed",
			);
			throw failure;
		} finally {
			this.releaseExecution(task.id);
			const durationMs = this.clock.now() - startTime;
			this.runtime.logger.debug(
				{
					src: "plugin:basic-capabilities:service:task",
					agentId: this.runtime.agentId,
					taskName: task.name,
					taskId: task.id,
					durationMs,
				},
				"Task execution completed",
			);
		}
	}

	/**
	 * Called after a task write. Wakes the local timer within MIN_TICK_MS (the old
	 * tick bound) so a new or changed task is seen. When the daemon is running,
	 * notifies it instead. Hosts with their own resume or time-change signal may
	 * call it too; the system clock already re-reads the wall clock each second.
	 */
	markDirty(): void {
		if (getTaskSchedulerAdapter() != null) {
			markTaskSchedulerDirty(this.runtime.agentId);
			return;
		}
		this.armTimer(this.clock.now() + MIN_TICK_MS);
	}

	/**
	 * Run due queue tasks once. For serverless: call from cron or on each request.
	 * Does getTasks for this agent's queue tasks then runTick (validate + execute due).
	 * WHY separate from timer: serverless has no long-lived process; host drives execution explicitly.
	 */
	async runDueTasks(): Promise<void> {
		if (this.stopped) return;
		while (this.activeTick) {
			await this.activeTick;
		}
		if (this.stopped) return;
		const run = (async () => {
			const allTasks = await this.runtime.getTasks({
				tags: ["queue"],
				agentIds: [this.runtime.agentId],
			});
			if (allTasks.length) {
				await this.runTick(allTasks);
			}
		})();
		const tick = run.then(
			() => undefined,
			() => undefined,
		);
		this.activeTick = tick;
		try {
			await run;
		} finally {
			if (this.activeTick === tick) {
				this.activeTick = null;
			}
		}
	}

	/**
	 * Executes a task by ID. Loads the task, then runs it via executeTask.
	 * @param taskId - UUID of the task.
	 */
	async executeTaskById(taskId: UUID): Promise<void> {
		return this.withExecutionAdmission(async () => {
			const task = await this.runtime.getTask(taskId);
			if (!task) {
				throw new Error(`Task ${taskId} not found`);
			}
			await this.executeTask(task);
		});
	}

	/**
	 * Writes a key-level metadata change. The adapter's atomic patch keeps a
	 * concurrent writer's keys intact (an operator pause landing during a run's
	 * bookkeeping, or vice versa); when the adapter has no atomic patch, the
	 * change is merged over the freshest snapshot the caller read and written
	 * whole. `unset` keys are removed in both modes.
	 */
	private async persistTaskMetadata(
		taskId: UUID,
		snapshot: TaskMetadata | undefined,
		set: Partial<TaskMetadata>,
		unset: readonly (keyof TaskMetadata)[] = [],
	): Promise<void> {
		const outcome = await this.runtime.patchTaskMetadata(taskId, {
			set,
			unset,
		});
		if (outcome !== "unsupported") return;
		const merged: Record<string, unknown> = { ...(snapshot ?? {}), ...set };
		for (const key of unset) delete merged[key];
		await this.runtime.updateTask(taskId, {
			metadata: merged as TaskMetadata,
		});
	}

	/**
	 * Pauses a task. Every scheduler tick AFTER the pause is persisted skips
	 * the task until it is resumed, and a paused task is never deleted by the
	 * tick loop.
	 *
	 * Already-selected-work semantics: Task rows carry no version column, so
	 * pause is not CAS-atomic with tick selection. A tick that captured its
	 * Task snapshot BEFORE the pause landed may execute that one selection to
	 * completion (including the normal one-shot delete). Everything selected
	 * afterwards observes `metadata.paused` and skips. Callers needing
	 * hard at-most-zero execution must gate the worker itself (e.g. check
	 * paused inside worker.execute).
	 *
	 * Preserves existing metadata (updatedAt, updateInterval, etc.).
	 */
	async pauseTask(taskId: UUID): Promise<void> {
		const task = await this.runtime.getTask(taskId);
		if (!task) {
			throw new Error(`Task ${taskId} not found`);
		}
		await this.persistTaskMetadata(taskId, task.metadata, { paused: true });
	}

	/**
	 * Resumes a task. If runImmediately is true, runs the task once after unpausing.
	 * Unpauses before executing so a failed run does not leave the task paused.
	 */
	async resumeTask(taskId: UUID, runImmediately?: boolean): Promise<void> {
		return this.withExecutionAdmission(async () => {
			const task = await this.runtime.getTask(taskId);
			if (!task) {
				throw new Error(`Task ${taskId} not found`);
			}
			await this.persistTaskMetadata(taskId, task.metadata, { paused: false });
			if (runImmediately) {
				const updated = await this.runtime.getTask(taskId);
				if (updated) {
					await this.executeTask(updated);
				}
			}
		});
	}

	/**
	 * Returns run status for a task: task, paused, executing, nextRunAt (repeat only), lastError.
	 */
	async getTaskStatus(taskId: UUID): Promise<TaskRunStatus> {
		const task = await this.runtime.getTask(taskId);
		if (!task) {
			return { task: null, paused: false, executing: false };
		}
		const paused = task.metadata?.paused === true;
		const executing = task.id ? this.executingTasks.has(task.id) : false;
		let nextRunAt: number | undefined;
		if (task.tags?.includes("repeat")) {
			const meta = task.metadata;
			const interval = meta?.updateInterval ?? 0;
			const notBefore = meta?.notBefore ?? 0;
			nextRunAt = lastRanAt(task) + interval - notBefore;
		}
		return {
			task,
			paused,
			executing,
			nextRunAt,
			lastError: task.metadata?.lastError,
		};
	}

	/**
	 * Stops the TASK service in the given agent runtime.
	 *
	 * @param {IAgentRuntime} runtime - The agent runtime containing the service.
	 * @returns {Promise<void>} - A promise that resolves once the service has been stopped.
	 */
	static async stop(runtime: IAgentRuntime) {
		const service = runtime.getService(ServiceType.TASK);
		if (service) {
			await service.stop();
		}
	}

	/** Stop new ticks before the runtime closes room admissions. */
	prepareStop() {
		this.stopped = true;
		this.schedulerDrain = unregisterTaskSchedulerRuntime(
			this.runtime.agentId,
			this,
		);
		this.localTimer = false;
		this.clearTimer();
	}

	async stop() {
		this.prepareStop();
		await this.schedulerDrain;
		if (this.activeTick) {
			await this.activeTick;
		}
		const inFlight = Array.from(this.pendingOperations);
		if (inFlight.length > 0) {
			await Promise.allSettled(inFlight);
		}
		// Every admitted execution has settled.
		this.executingTasks.clear();
	}
}
