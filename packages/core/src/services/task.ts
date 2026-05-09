// registered to runtime through plugin

import type { JsonValue } from "../types";
import type { UUID } from "../types/primitives";
import type { IAgentRuntime } from "../types/runtime";
import { promptRunnerTaskWorker } from "../features/basic-capabilities/prompt-runner-task";
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
	if (task.dueAt != null) {
		if (typeof task.dueAt === "number") return task.dueAt;
		if (typeof task.dueAt === "bigint") return Number(task.dueAt);
		return new Date(String(task.dueAt)).getTime();
	}
	const scheduledAt = (task.metadata as TaskMetadata | undefined)?.scheduledAt;
	if (scheduledAt == null) return null;
	if (typeof scheduledAt === "number") return scheduledAt;
	const t = new Date(scheduledAt).getTime();
	return Number.isNaN(t) ? null : t;
}

/**
 * TaskService class representing a service that schedules and executes tasks.
 * @extends Service
 * @property {NodeJS.Timeout|null} timer - Timer for executing tasks
 * @property {number} TICK_INTERVAL - Interval in milliseconds to check for tasks
 * @property {ServiceTypeName} serviceType - Service type of TASK
 * @property {string} capabilityDescription - Description of the service's capability
 * @static
 * @method start - Static method to start the TaskService
 * @method createTestTasks - Method to create test tasks
 * @method startTimer - Public method to start the timer for checking tasks
 * @method validateTasks - Private method to validate tasks
 * @method checkTasks - Private method to check tasks and execute them
 * @method executeTask - Private method to execute a task
 * @static
 * @method stop - Static method to stop the TaskService
 * @method stop - Method to stop the TaskService
 */
/**
 * Start the TaskService with the given runtime.
 * @param {IAgentRuntime} runtime - The runtime for the TaskService.
 */
export class TaskService extends Service {
	private timer: NodeJS.Timeout | null = null;
	private activeTick: Promise<void> | null = null;
	private readonly TICK_INTERVAL = 1000; // Check every second
	/** Tracks task IDs currently being executed to prevent overlapping runs. WHY: blocking tasks must not run again until current run finishes. */
	private executingTasks: Set<string> = new Set();
	/** Tracks in-flight task promises so stop() can await a clean drain before runtime.close(). */
	private executingTaskPromises = new Set<Promise<void>>();
	/** When false, checkTasks skips the DB query. Set true by markDirty(); start true so first tick always queries. WHY: avoid redundant getTasks every second when nothing changed. */
	private tasksDirty = true;
	/** Set true in stop(). runTick is a no-op when true (daemon may call runTick after unregister). */
	private stopped = false;
	static serviceType = ServiceType.TASK;
	capabilityDescription = "The agent is able to schedule and execute tasks";

	/**
	 * Start the TaskService with the given runtime.
	 * @param {IAgentRuntime} runtime - The runtime for the TaskService.
	 * @returns {Promise<Service>} A promise that resolves with the TaskService instance.
	 */
	static async start(runtime: IAgentRuntime): Promise<Service> {
		const service = new TaskService(runtime);
		// WHY: batcher owns HOW (sections, packing, cache); task system owns WHEN. One scheduler for all periodic drains.
		runtime.registerTaskWorker({
			name: "BATCHER_DRAIN",
			execute: async (rt, options) => {
				const affinityKey = options.affinityKey as string;
				if (!rt.promptBatcher || !affinityKey) return undefined;
				await rt.promptBatcher.drainAffinityGroup(affinityKey);
				return undefined;
			},
		});
		// Generic scheduled-prompt worker: lets users (and the UI) schedule
		// arbitrary natural-language jobs via metadata.prompt without a bespoke
		// worker per prompt. Discriminated by metadata.kind = 'prompt'.
		runtime.registerTaskWorker(promptRunnerTaskWorker);
		await service.startTimer();
		// await service.createTestTasks();
		return service;
	}

	/**
	 * Asynchronously creates test tasks by registering task workers for repeating and one-time tasks,
	 * validates the tasks, executes the tasks, and creates the tasks if they do not already exist.
	 */
	async createTestTasks() {
		// Register task worker for repeating task
		this.runtime.registerTaskWorker({
			name: "REPEATING_TEST_TASK",
			shouldRun: async () => {
				this.runtime.logger.debug(
					{
						src: "plugin:basic-capabilities:service:task",
						agentId: this.runtime.agentId,
					},
					"Validating repeating test task",
				);
				return true;
			},
			execute: async (_runtime, _options) => {
				this.runtime.logger.debug(
					{
						src: "plugin:basic-capabilities:service:task",
						agentId: this.runtime.agentId,
					},
					"Executing repeating test task",
				);
				return undefined;
			},
		});

		// Register task worker for one-time task
		this.runtime.registerTaskWorker({
			name: "ONETIME_TEST_TASK",
			shouldRun: async () => {
				this.runtime.logger.debug(
					{
						src: "plugin:basic-capabilities:service:task",
						agentId: this.runtime.agentId,
					},
					"Validating one-time test task",
				);
				return true;
			},
			execute: async (_runtime, _options) => {
				this.runtime.logger.debug(
					{
						src: "plugin:basic-capabilities:service:task",
						agentId: this.runtime.agentId,
					},
					"Executing one-time test task",
				);
				return undefined;
			},
		});

		// check if the task exists
		const tasks = await this.runtime.getTasksByName("REPEATING_TEST_TASK");

		if (tasks.length === 0) {
			// Create repeating task
			await this.runtime.createTask({
				name: "REPEATING_TEST_TASK",
				description: "A test task that repeats every minute",
				metadata: {
					updatedAt: Date.now(), // Use timestamp instead of Date object
					updateInterval: 1000 * 60, // 1 minute
				},
				tags: ["queue", "repeat", "test"],
			});
		}

		// Create one-time task
		await this.runtime.createTask({
			name: "ONETIME_TEST_TASK",
			description: "A test task that runs once",
			metadata: {
				updatedAt: Date.now(),
			},
			tags: ["queue", "test"],
		});
	}

	/**
	 * Start the task poll timer. Call explicitly in daemon mode; not started automatically.
	 * WHY public: initialize() does not start the task service or timer. Daemon entry points
	 * that need scheduled tasks call getService("task") then startTimer(). Edge/ephemeral
	 * runtimes typically do not call this.
	 * Priority: (1) serverless -> no timer, host calls runDueTasks(); (2) daemon present -> register, no local timer; (3) else local setInterval.
	 * WHY serverless first: no long-lived process; WHY daemon second: one shared getTasks(agentIds) per tick for all agents.
	 */
	startTimer() {
		if (this.runtime.serverless === true) {
			return;
		}
		if (getTaskSchedulerAdapter() != null) {
			registerTaskSchedulerRuntime(this.runtime, this);
			return;
		}
		if (this.timer) {
			clearInterval(this.timer);
		}

		this.timer = setInterval(() => {
			if (this.activeTick) {
				return;
			}
			const tick = this.checkTasks()
				.catch((error) => {
					this.runtime.logger.error(
						{
							src: "plugin:basic-capabilities:service:task",
							agentId: this.runtime.agentId,
							error,
						},
						"Task timer tick failed",
					);
				})
				.finally(() => {
					if (this.activeTick === tick) {
						this.activeTick = null;
					}
				});
			this.activeTick = tick;
		}, this.TICK_INTERVAL) as NodeJS.Timeout;
	}

	/**
	 * Validates an array of Task objects.
	 * Skips tasks without IDs or if no worker is found for the task.
	 * Uses worker.shouldRun(runtime, task) when present; otherwise the task passes.
	 * @param {Task[]} tasks - An array of Task objects to validate.
	 * @returns {Promise<Task[]>} - A Promise that resolves with an array of validated Task objects.
	 */
	private async validateTasks(tasks: Task[]): Promise<Task[]> {
		const validatedTasks: Task[] = [];

		for (const task of tasks) {
			if (!task.id) {
				continue;
			}

			const worker = this.runtime.getTaskWorker(task.name);
			if (!worker) {
				continue;
			}

			if (worker.shouldRun) {
				const shouldRun = await worker.shouldRun(this.runtime, task);
				if (!shouldRun) {
					continue;
				}
			}

			validatedTasks.push(task);
		}

		return validatedTasks;
	}

	/**
	 * Asynchronous method that checks tasks with "queue" tag, validates them, then executes via runTick.
	 * Skips the DB query when tasksDirty is false. WHY: avoid redundant getTasks every second when nothing changed.
	 * If a task's execute() creates/updates tasks and calls markDirty(), the next tick will re-query; tasks created mid-loop run next tick.
	 *
	 * @returns {Promise<void>} Promise that resolves once all tasks are checked and executed
	 */
	private async checkTasks() {
		if (this.stopped || !this.tasksDirty) {
			return;
		}
		this.tasksDirty = false;

		// WHY queue only: approval/follow-up etc. are stored but run on user trigger or external cron; one place for "scheduled by tick".
		const allTasks = await this.runtime.getTasks({
			tags: ["queue"],
			agentIds: [this.runtime.agentId],
		});

		if (!allTasks) {
			return;
		}

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
		const validated = await this.validateTasks(tasks);
		const now = Date.now();

		for (const task of validated) {
			// Non-repeat tasks: run when due (or immediately if no dueAt/scheduledAt). WHY: one-shot "run at time X" (e.g. follow-up) uses dueAt or metadata.scheduledAt.
			if (!task.tags?.includes("repeat")) {
				const dueMs = resolveDueTime(task);
				if (dueMs != null && now < dueMs) continue;
				await this.executeTask(task);
				continue;
			}

			// Repeat tasks: skip if paused
			if (task.metadata?.paused === true) {
				continue;
			}

			// Resolve lastRan (updatedAt) with backward-compat fallback
			let lastRan: number;
			if (
				task.metadata?.updatedAt != null &&
				typeof task.metadata.updatedAt === "number"
			) {
				lastRan = task.metadata.updatedAt;
			} else if (typeof task.updatedAt === "number") {
				lastRan = task.updatedAt;
			} else if (typeof task.updatedAt === "bigint") {
				lastRan = Number(task.updatedAt);
			} else if (task.updatedAt) {
				lastRan = new Date(String(task.updatedAt)).getTime();
			} else {
				lastRan = 0;
			}

			const taskMetadata = task.metadata as TaskMetadata | undefined;
			const updateIntervalMs = taskMetadata?.updateInterval ?? 0;
			const notBeforeMs = taskMetadata?.notBefore ?? 0;
			const notAfterMs = taskMetadata?.notAfter;

			const idealNextRun = lastRan + updateIntervalMs;
			const earliest = idealNextRun - notBeforeMs;

			if (now < earliest) {
				continue;
			}

			if (
				notAfterMs != null &&
				typeof notAfterMs === "number" &&
				now > idealNextRun + notAfterMs
			) {
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
			await this.executeTask(task);
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
		const execution = this.executeTaskInternal(task);
		this.executingTaskPromises.add(execution);
		try {
			await execution;
		} finally {
			this.executingTaskPromises.delete(execution);
		}
	}

	private async executeTaskInternal(task: Task) {
		if (!task?.id) {
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

		this.executingTasks.add(task.id);
		const startTime = Date.now();

		try {
			const taskOptions = (task.metadata ?? {}) as Record<
				string,
				JsonValue | object
			>;
			const result = await worker.execute(this.runtime, taskOptions, task);

			if (task.tags?.includes("repeat")) {
				const latestTask = await this.runtime.getTask(task.id);
				if (!latestTask) {
					return;
				}
				const meta = latestTask.metadata as TaskMetadata | undefined;
				const baseInterval = meta?.baseInterval ?? meta?.updateInterval;
				const newMeta: TaskMetadata = {
					...meta,
					updatedAt: Date.now(),
					failureCount: 0,
					lastError: undefined,
				};
				const nextInterval =
					result != null &&
					typeof result === "object" &&
					"nextInterval" in result
						? (result as { nextInterval?: number }).nextInterval
						: undefined;
				if (nextInterval != null) {
					newMeta.updateInterval = nextInterval;
				} else if (baseInterval != null && typeof baseInterval === "number") {
					newMeta.updateInterval = baseInterval;
				}
				await this.runtime.updateTask(task.id, { metadata: newMeta });
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
			if (task.tags?.includes("repeat")) {
				const latestTask = await this.runtime.getTask(task.id);
				if (!latestTask) {
					return;
				}
				const meta = latestTask.metadata as TaskMetadata | undefined;
				const failureCount = (meta?.failureCount ?? 0) + 1;
				const rawMax = meta?.maxFailures;
				const neverPause = rawMax === Infinity || rawMax === -1;
				const maxFailures = neverPause ? Infinity : (rawMax ?? 5);
				const newMeta: TaskMetadata & Record<string, unknown> = {
					...(meta ?? {}),
					updatedAt: Date.now(),
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
					newMeta.updateInterval = Math.min(
						baseInterval * 2 ** failureCount,
						300_000,
					);
				}
				await this.runtime.updateTask(task.id, { metadata: newMeta });
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
			this.runtime.logger.error(
				{ taskName: task.name, taskId: task.id, error },
				"Task execution failed",
			);
		} finally {
			this.executingTasks.delete(task.id);
			const durationMs = Date.now() - startTime;
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

	/** Marks the task list as dirty so the next checkTasks tick will re-query the DB. When the daemon is running, notifies it instead of setting local flag. */
	markDirty(): void {
		if (getTaskSchedulerAdapter() != null) {
			markTaskSchedulerDirty(this.runtime.agentId);
			return;
		}
		this.tasksDirty = true;
	}

	/**
	 * Run due queue tasks once. For serverless: call from cron or on each request.
	 * Does getTasks for this agent's queue tasks then runTick (validate + execute due).
	 * WHY separate from timer: serverless has no long-lived process; host drives execution explicitly.
	 */
	async runDueTasks(): Promise<void> {
		const allTasks = await this.runtime.getTasks({
			tags: ["queue"],
			agentIds: [this.runtime.agentId],
		});
		if (allTasks?.length) {
			await this.runTick(allTasks);
		}
	}

	/**
	 * Executes a task by ID. Loads the task, then runs it via executeTask.
	 * @param taskId - UUID of the task.
	 */
	async executeTaskById(taskId: UUID): Promise<void> {
		const task = await this.runtime.getTask(taskId);
		if (!task) {
			throw new Error(`Task ${taskId} not found`);
		}
		await this.executeTask(task);
	}

	/**
	 * Pauses a task. The scheduler will skip it until resumed.
	 * Preserves existing metadata (updatedAt, updateInterval, etc.).
	 */
	async pauseTask(taskId: UUID): Promise<void> {
		const task = await this.runtime.getTask(taskId);
		if (!task) {
			throw new Error(`Task ${taskId} not found`);
		}
		await this.runtime.updateTask(taskId, {
			metadata: { ...task.metadata, paused: true } as TaskMetadata,
		});
	}

	/**
	 * Resumes a task. If runImmediately is true, runs the task once after unpausing.
	 * Unpauses before executing so a failed run does not leave the task paused.
	 */
	async resumeTask(taskId: UUID, runImmediately?: boolean): Promise<void> {
		const task = await this.runtime.getTask(taskId);
		if (!task) {
			throw new Error(`Task ${taskId} not found`);
		}
		await this.runtime.updateTask(taskId, {
			metadata: { ...task.metadata, paused: false } as TaskMetadata,
		});
		if (runImmediately) {
			const updated = await this.runtime.getTask(taskId);
			if (updated) {
				await this.executeTask(updated);
			}
		}
	}

	/**
	 * Returns run status for a task: task, paused, executing, nextRunAt (repeat only), lastError.
	 */
	async getTaskStatus(taskId: UUID): Promise<TaskRunStatus> {
		const task = await this.runtime.getTask(taskId);
		if (!task) {
			return { task: null, paused: false, executing: false };
		}
		const paused = (task.metadata as TaskMetadata)?.paused === true;
		const executing = task.id ? this.executingTasks.has(task.id) : false;
		let nextRunAt: number | undefined;
		if (task.tags?.includes("repeat")) {
			let lastRan: number;
			const meta = task.metadata as TaskMetadata | undefined;
			if (meta?.updatedAt != null && typeof meta.updatedAt === "number") {
				lastRan = meta.updatedAt;
			} else if (typeof task.updatedAt === "number") {
				lastRan = task.updatedAt;
			} else if (typeof task.updatedAt === "bigint") {
				lastRan = Number(task.updatedAt);
			} else {
				lastRan = 0;
			}
			const interval = meta?.updateInterval ?? 0;
			const notBefore = meta?.notBefore ?? 0;
			nextRunAt = lastRan + interval - notBefore;
		}
		return {
			task,
			paused,
			executing,
			nextRunAt,
			lastError: (task.metadata as TaskMetadata)?.lastError,
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

	/**
	 * Stops the timer if it is currently running.
	 */

	async stop() {
		this.stopped = true;
		unregisterTaskSchedulerRuntime(this.runtime.agentId);
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
		if (this.activeTick) {
			await this.activeTick;
		}
		const inFlight = Array.from(this.executingTaskPromises);
		if (inFlight.length > 0) {
			await Promise.allSettled(inFlight);
		}
		// Clear executing tasks set on stop
		this.executingTasks.clear();
	}
}
