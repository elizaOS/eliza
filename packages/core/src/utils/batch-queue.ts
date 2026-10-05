import { logger } from "../logger.js";
import type { JsonValue, UUID } from "../types/primitives.js";
import type { IAgentRuntime } from "../types/runtime.js";
import type { Task } from "../types/task.js";

import {
	type BackoffPolicy,
	computeBackoff,
	type RetryConfig,
	resolveRetryConfig,
	sleep,
} from "./retry.js";

export interface DrainStats {
	batchSize: number;
	remaining: number;
	durationMs: number;
}

export interface BatchQueueOptions<T> {
	/** Task worker name and repeat task name (e.g. `EMBEDDING_DRAIN`). */
	name: string;
	batchSize: number;
	drainIntervalMs: number;
	/** Cadence while idle; defaults to max(5 s, 5 × drainIntervalMs). See TaskDrainOptions.idleIntervalMs. */
	idleDrainIntervalMs?: number;
	getPriority: (item: T) => QueuePriority;
	process: (item: T) => Promise<void>;
	/**
	 * Optional batched processor. When provided, a drain calls this ONCE with the
	 * whole dequeued slice (so a provider that supports a batched request — e.g.
	 * embeddings — sends one call instead of N). If it throws, every item falls
	 * back to the per-item {@link process} path; failed item outcomes it returns
	 * fall back the same way, so retry / `onExhausted` semantics are preserved.
	 * Existing per-item callers that don't set this are completely unaffected.
	 */
	processBatch?: (items: T[]) => Promise<BatchItemOutcome<T>[]>;
	maxParallel?: number;
	maxRetriesAfterFailure?: number;
	retryPolicy?: RetryConfig;
	maxSize?: number;
	onPressure?: (queue: PriorityQueue<T>, item: T) => boolean;
	onOverflowWarning?: (sizeAfter: number, maxSize: number) => void;
	onExhausted?: (item: T, error: Error) => void | Promise<void>;
	/** Called after a non-empty batch finishes `processBatch` (includes per-item success/failure). */
	onDrainBatchOutcomes?: (outcomes: BatchItemOutcome<T>[]) => void;
	onDrainComplete?: (stats: DrainStats) => void;
	shouldRetry?: (item: T, error: Error, attempt: number) => boolean;
	/**
	 * When true, skips registering the task worker and only registers the repeat task — caller must
	 * register `name` with TaskService (e.g. `BATCHER_DRAIN`). Default false.
	 */
	skipRegisterWorker?: boolean;
	/** Merged into repeat task metadata (e.g. `{ affinityKey: "room:x" }`). */
	taskMetadata?: Record<string, unknown>;
	/** Optional repeat task description in the task store. */
	taskDescription?: string;
	drainHighPriorityOnStop?: boolean;
}

/**
 * End-to-end queue for “enqueue work, drain on a schedule, process with backpressure.”
 *
 * **Why `isDraining`:** Repeat tasks can fire while a drain is still running; we skip re-entry so
 * two batches don’t process the same logical slice or overlap `process` side effects.
 *
 * **Why `dispose` flushes high priority optionally:** Matches embedding shutdown: best-effort
 * completion for urgent items before deleting the repeat task and clearing the queue.
 *
 * **Flush path:** By default the high-priority shutdown slice runs through a dedicated
 * {@link BatchProcessor} (serial, one attempt per item) so behavior stays aligned with bounded
 * concurrency.
 */
export class BatchQueue<T> {
	private readonly priorityQueue: PriorityQueue<T>;
	private readonly batchProcessor: BatchProcessor<T>;
	private taskDrain: TaskDrain | null = null;
	private runtime?: IAgentRuntime;
	private isDraining = false;
	private disposed = false;
	private readonly batchSize: number;
	private readonly options: BatchQueueOptions<T>;

	constructor(options: BatchQueueOptions<T>) {
		this.options = options;
		this.batchSize = Math.max(1, options.batchSize);
		this.priorityQueue = new PriorityQueue<T>({
			getPriority: options.getPriority,
			maxSize: options.maxSize,
			onPressure: options.onPressure,
			onOverflowWarning: options.onOverflowWarning,
		});
		// Default maxParallel 10: matches prior embedding batch parallelism; callers can set 1 for strict serial.
		this.batchProcessor = new BatchProcessor<T>({
			maxParallel: options.maxParallel ?? 10,
			maxRetriesAfterFailure: options.maxRetriesAfterFailure,
			retryPolicy: options.retryPolicy,
			process: options.process,
			onExhausted: options.onExhausted,
			shouldRetry: options.shouldRetry,
		});
	}

	enqueue(item: T): boolean {
		if (this.disposed) {
			return false;
		}
		return this.priorityQueue.enqueue(item);
	}

	/**
	 * Run one drain cycle (typically from the repeat task worker).
	 * Resolves to the number of items processed (0 when idle, disposed, or
	 * already draining) so callers and the idle-backoff worker share one count.
	 */
	async drain(): Promise<number> {
		return this.drainBatch();
	}

	private async drainBatch(): Promise<number> {
		if (this.disposed || this.isDraining) {
			return 0;
		}
		this.isDraining = true;
		const started = Date.now();
		try {
			const batch = this.priorityQueue.dequeueBatch(this.batchSize);
			if (batch.length === 0) {
				return 0;
			}
			// Prefer the batched processor when provided. A batch-wide throw fails
			// every item; explicit failed outcomes fail only those items. Either
			// way, failures go through the per-item retry / onExhausted path.
			let outcomes: BatchItemOutcome<T>[];
			if (this.options.processBatch) {
				let settled: Array<BatchItemOutcome<T> | undefined>;
				let failures: Array<{ index: number; item: T; error: Error }>;
				try {
					const batchOutcomes = await this.options.processBatch(batch);
					settled = batchOutcomes.map((outcome) =>
						outcome.success ? outcome : undefined,
					);
					failures = [];
					batchOutcomes.forEach((outcome, index) => {
						if (outcome.success) return;
						failures.push({
							index,
							item: outcome.item,
							error:
								outcome.error ??
								new Error(
									`BatchQueue "${this.options.name}" processBatch reported a failed item without an error`,
								),
						});
					});
				} catch (error) {
					// error-policy:J4 A batch-wide provider failure degrades to
					// the per-item retry path and remains observable.
					this.runtime?.reportError("BatchQueue.processBatch", error, {
						queue: this.options.name,
						batchSize: batch.length,
					});
					const failure =
						error instanceof Error ? error : new Error(String(error));
					settled = batch.map(() => undefined);
					failures = batch.map((item, index) => ({
						index,
						item,
						error: failure,
					}));
				}
				// Kept outside the processBatch try: a per-item retry failure must
				// never replay items the batched call already settled.
				outcomes = await this.retryBatchFailures(settled, failures);
			} else {
				outcomes = await this.batchProcessor.processBatch(batch);
			}
			try {
				this.options.onDrainBatchOutcomes?.(outcomes);
			} catch (error) {
				// error-policy:J7 Outcome hooks observe an already completed batch.
				this.runtime?.reportError("BatchQueue.outcomeHook", error, {
					queue: this.options.name,
				});
				// Keep hook failures from failing a completed batch
			}
			const durationMs = Date.now() - started;
			try {
				this.options.onDrainComplete?.({
					batchSize: batch.length,
					remaining: this.priorityQueue.size,
					durationMs,
				});
			} catch (error) {
				// error-policy:J7 Completion hooks observe an already completed batch.
				this.runtime?.reportError("BatchQueue.completionHook", error, {
					queue: this.options.name,
				});
				// Keep hook failures from failing a completed batch
			}
			return batch.length;
		} finally {
			this.isDraining = false;
		}
	}

	/**
	 * Route failed `processBatch` items through the per-item processor, honoring
	 * `shouldRetry` for the failed batched attempt. Outcomes keep batch order.
	 */
	private async retryBatchFailures(
		settled: Array<BatchItemOutcome<T> | undefined>,
		failures: Array<{ index: number; item: T; error: Error }>,
	): Promise<BatchItemOutcome<T>[]> {
		const retryable: Array<{ index: number; item: T }> = [];
		for (const failure of failures) {
			if (
				this.options.shouldRetry?.(failure.item, failure.error, 1) !== false
			) {
				retryable.push(failure);
				continue;
			}
			settled[failure.index] = {
				item: failure.item,
				success: false,
				error: failure.error,
				retryCount: 0,
			};
			try {
				await this.options.onExhausted?.(failure.item, failure.error);
			} catch (callbackError) {
				// error-policy:J7 The original failed outcome remains visible when its reporting callback fails.
				this.runtime?.reportError("BatchQueue.onExhausted", callbackError, {
					queue: this.options.name,
				});
			}
		}
		const retried = await this.batchProcessor.processBatch(
			retryable.map(({ item }) => item),
		);
		retryable.forEach(({ index }, position) => {
			settled[index] = retried[position];
		});
		return settled.filter(
			(outcome): outcome is BatchItemOutcome<T> => outcome !== undefined,
		);
	}

	/** Wire `TaskDrain` (worker + repeat task unless `skipRegisterWorker`). */
	async start(runtime: IAgentRuntime): Promise<void> {
		if (this.disposed) {
			throw new Error(
				`BatchQueue "${this.options.name}" has already been disposed`,
			);
		}
		if (this.taskDrain) {
			return;
		}
		this.runtime = runtime;
		const skip = this.options.skipRegisterWorker ?? false;
		this.taskDrain = new TaskDrain(
			{
				taskName: this.options.name,
				description: this.options.taskDescription,
				intervalMs: this.options.drainIntervalMs,
				taskMetadata: this.options.taskMetadata,
				skipRegisterWorker: skip,
				idleIntervalMs:
					this.options.idleDrainIntervalMs ??
					Math.max(5_000, this.options.drainIntervalMs * 5),
				onDrain: skip ? undefined : async () => this.drainBatch(),
			},
			this.options.drainIntervalMs,
		);
		await this.taskDrain.start(runtime);
	}

	async updateDrainInterval(runtime: IAgentRuntime, ms: number): Promise<void> {
		await this.taskDrain?.updateInterval(runtime, ms);
	}

	async dispose(
		runtime: IAgentRuntime,
		opts?: { flushHighPriority?: boolean },
	): Promise<void> {
		this.disposed = true;
		const flush =
			opts?.flushHighPriority ?? this.options.drainHighPriorityOnStop !== false;
		if (flush) {
			const high = this.priorityQueue.drain(
				(item) => this.options.getPriority(item) === "high",
			);
			if (high.length > 0) {
				const flushProcessor = new BatchProcessor<T>({
					maxParallel: 1,
					maxRetriesAfterFailure: 0,
					maxAttemptsCap: 1,
					process: this.options.process,
					onExhausted: this.options.onExhausted,
					shouldRetry: this.options.shouldRetry,
					retryPolicy: this.options.retryPolicy,
				});
				const flushOutcomes = await flushProcessor.processBatch(high);
				this.options.onDrainBatchOutcomes?.(flushOutcomes);
			}
		}
		await this.taskDrain?.dispose(runtime);
		this.taskDrain = null;
		this.priorityQueue.clear();
	}

	get size(): number {
		return this.priorityQueue.size;
	}

	stats(): PriorityQueueStats {
		return this.priorityQueue.stats();
	}

	clear(): void {
		if (this.disposed) {
			return;
		}
		this.priorityQueue.clear();
	}
}

/**
 * Async semaphore: limits how many in-flight `process` calls run at once (true throttle for I/O).
 *
 * **Contract:** every `acquire()` must be paired with `release()` in a `finally` (or equivalent)
 * so permits return even when the guarded work throws. {@link BatchProcessor} does this; ad-hoc
 * callers must do the same.
 *
 * **Why shared with PromptDispatcher:** One implementation avoids drift; `prompt-batcher/shared`
 * re-exports this module so existing `import { Semaphore } from "./shared"` keeps working.
 */
export class Semaphore {
	private permits: number;
	private waiters: Array<() => void> = [];

	constructor(count: number) {
		this.permits =
			typeof count === "number" && Number.isFinite(count)
				? Math.max(1, Math.floor(count))
				: 1;
	}

	/** Number of currently available permits. */
	get availablePermits(): number {
		return this.permits;
	}

	/** Number of tasks currently queued waiting for a permit. */
	get queueLength(): number {
		return this.waiters.length;
	}

	async acquire(): Promise<void> {
		if (this.permits > 0) {
			this.permits -= 1;
			return;
		}

		await new Promise<void>((resolve) => {
			this.waiters.push(resolve);
		});
	}

	release(): void {
		this.permits += 1;
		const next = this.waiters.shift();
		if (next && this.permits > 0) {
			this.permits -= 1;
			next();
		}
	}
}

export type QueuePriority = "high" | "normal" | "low";

export type PriorityQueueStats = {
	high: number;
	normal: number;
	low: number;
	total: number;
};

export interface PriorityQueueOptions<T> {
	getPriority: (item: T) => QueuePriority;
	/** When set and length >= maxSize before enqueue, see {@link onPressure} / overflow behavior. */
	maxSize?: number;
	/**
	 * Called when maxSize is reached before adding `item`. Return true after making room (e.g. dequeue)
	 * so the new item can be inserted; return false to reject `item` (not enqueued).
	 */
	onPressure?: (queue: PriorityQueue<T>, item: T) => boolean;
	/** When maxSize exceeded and no onPressure: still enqueue but notify (queue grows past maxSize). */
	onOverflowWarning?: (sizeAfter: number, maxSize: number) => void;
}

export class PriorityQueue<T> {
	// Note: Three separate arrays avoid O(n) linear scan per insertion; enqueue is O(1).
	private invalidPriorityWarned = false;
	private readonly highItems: T[] = [];
	private readonly normalItems: T[] = [];
	private readonly lowItems: T[] = [];
	private readonly getPriority: (item: T) => QueuePriority;
	private readonly maxSize?: number;
	private readonly onPressure?: (queue: PriorityQueue<T>, item: T) => boolean;
	private readonly onOverflowWarning?: (
		sizeAfter: number,
		maxSize: number,
	) => void;

	constructor(options: PriorityQueueOptions<T>) {
		this.getPriority = options.getPriority;
		this.maxSize = options.maxSize;
		this.onPressure = options.onPressure;
		this.onOverflowWarning = options.onOverflowWarning;
	}

	/**
	 * Insert by priority. Returns false if rejected (onPressure returned false).
	 */
	enqueue(item: T): boolean {
		const max = this.maxSize;
		if (max !== undefined && this.size >= max) {
			if (this.onPressure) {
				if (!this.onPressure(this, item)) {
					return false;
				}
			} else {
				this.onOverflowWarning?.(this.size + 1, max);
			}
		}

		this.insertByPriority(item);
		return true;
	}

	private insertByPriority(item: T): void {
		const p = this.getPriority(item);
		if (p === "high") {
			this.highItems.push(item);
		} else if (p === "normal") {
			this.normalItems.push(item);
		} else if (p === "low") {
			this.lowItems.push(item);
		} else {
			if (!this.invalidPriorityWarned) {
				this.invalidPriorityWarned = true;
				logger.warn(
					{ src: "utils:priority-queue", priority: String(p) },
					'Invalid queue priority; expected "high" | "normal" | "low". Treating as normal.',
				);
			}
			this.normalItems.push(item);
		}
	}

	/** Remove up to `n` items from the front (highest priority first). */
	dequeueBatch(n: number): T[] {
		if (n <= 0 || this.size === 0) {
			return [];
		}
		const result: T[] = [];
		let remaining = n;

		// Drain from high priority first
		if (remaining > 0 && this.highItems.length > 0) {
			const take = Math.min(remaining, this.highItems.length);
			result.push(...this.highItems.splice(0, take));
			remaining -= take;
		}

		// Then normal priority
		if (remaining > 0 && this.normalItems.length > 0) {
			const take = Math.min(remaining, this.normalItems.length);
			result.push(...this.normalItems.splice(0, take));
			remaining -= take;
		}

		// Then low priority
		if (remaining > 0 && this.lowItems.length > 0) {
			const take = Math.min(remaining, this.lowItems.length);
			result.push(...this.lowItems.splice(0, take));
		}

		return result;
	}

	/** Remove and return all items matching `filter`. */
	drain(filter?: (item: T) => boolean): T[] {
		if (!filter) {
			const all = [...this.highItems, ...this.normalItems, ...this.lowItems];
			this.highItems.length = 0;
			this.normalItems.length = 0;
			this.lowItems.length = 0;
			return all;
		}

		const drainArray = (arr: T[]): T[] => {
			const kept: T[] = [];
			const out: T[] = [];
			for (const item of arr) {
				if (filter(item)) {
					out.push(item);
				} else {
					kept.push(item);
				}
			}
			arr.length = 0;
			arr.push(...kept);
			return out;
		};

		return [
			...drainArray(this.highItems),
			...drainArray(this.normalItems),
			...drainArray(this.lowItems),
		];
	}

	get size(): number {
		return (
			this.highItems.length + this.normalItems.length + this.lowItems.length
		);
	}

	clear(): void {
		this.highItems.length = 0;
		this.normalItems.length = 0;
		this.lowItems.length = 0;
	}

	stats(): PriorityQueueStats {
		return {
			high: this.highItems.length,
			normal: this.normalItems.length,
			low: this.lowItems.length,
			total: this.size,
		};
	}
}

export interface BatchItemOutcome<T> {
	item: T;
	success: boolean;
	error?: Error;
	retryCount: number;
}

export interface BatchProcessorOptions<T> {
	/** Max concurrent `process` calls across the batch. */
	maxParallel: number;
	/**
	 * After a failed attempt, re-try up to this many times (embedding-style).
	 * Total attempts = maxRetriesAfterFailure + 1. Default 3 → 4 total tries.
	 *
	 * **Interaction with per-item `_batchMaxAttempts`:** If the item is an object with numeric
	 * `_batchMaxAttempts`, that value is used as total attempts (unless `maxAttemptsCap` applies).
	 */
	maxRetriesAfterFailure?: number;
	retryPolicy?: RetryConfig;
	/**
	 * Upper bound on attempts per item after resolving per-item `maxRetries` and global retry config.
	 * Use for shutdown-style paths where items may carry large `maxRetries` but only one try is wanted.
	 */
	maxAttemptsCap?: number;
	process: (item: T) => Promise<void>;
	onExhausted?: (item: T, error: Error) => void | Promise<void>;
	shouldRetry?: (item: T, error: Error, attempt: number) => boolean;
}

function defaultShouldRetry(
	_item: unknown,
	_err: Error,
	_attempt: number,
): boolean {
	return true;
}

function toBackoffPolicy(
	resolved: ReturnType<typeof resolveRetryConfig>,
): BackoffPolicy {
	return {
		initialMs: resolved.minDelayMs,
		maxMs: resolved.maxDelayMs,
		factor: 2,
		jitter: resolved.jitter,
	};
}

/**
 * Per-item attempt override via explicit `_batchMaxAttempts` property.
 *
 * Uses `_batchMaxAttempts` (not `maxRetries`) to avoid accidentally duck-typing payload fields
 * that happen to carry `maxRetries` for other purposes. Items must explicitly opt-in to override
 * the queue-level `maxRetriesAfterFailure` by setting `_batchMaxAttempts` (total attempts, not retries).
 */
function getPerItemMaxAttempts(item: unknown, fallback: number): number {
	if (
		item &&
		typeof item === "object" &&
		"_batchMaxAttempts" in item &&
		typeof (item as { _batchMaxAttempts?: unknown })._batchMaxAttempts ===
			"number"
	) {
		const attempts = (item as { _batchMaxAttempts: number })._batchMaxAttempts;
		if (Number.isFinite(attempts) && attempts >= 1) {
			return attempts;
		}
	}
	return fallback;
}

export class BatchProcessor<T> {
	private readonly maxParallel: number;
	private readonly defaultMaxAttempts: number;
	private readonly maxAttemptsCap?: number;
	private readonly policy: BackoffPolicy;
	private readonly process: (item: T) => Promise<void>;
	private readonly onExhausted?: (
		item: T,
		error: Error,
	) => void | Promise<void>;
	private readonly shouldRetry: (
		item: T,
		error: Error,
		attempt: number,
	) => boolean;
	private readonly semaphore: Semaphore;

	constructor(options: BatchProcessorOptions<T>) {
		this.maxParallel = Math.max(1, options.maxParallel);
		// retriesAfter + 1 total attempts: first try + N failures that may retry.
		const retriesAfter = options.maxRetriesAfterFailure ?? 3;
		const resolved = resolveRetryConfig(
			{
				attempts: retriesAfter + 1,
				minDelayMs: 300,
				maxDelayMs: 30_000,
				jitter: 0,
			},
			options.retryPolicy,
		);
		this.defaultMaxAttempts = resolved.attempts;
		this.maxAttemptsCap = options.maxAttemptsCap;
		// Factor 2 in toBackoffPolicy: matches classic exponential backoff between attempts.
		this.policy = toBackoffPolicy(resolved);
		this.process = options.process;
		this.onExhausted = options.onExhausted;
		this.shouldRetry = options.shouldRetry ?? defaultShouldRetry;
		this.semaphore = new Semaphore(this.maxParallel);
	}

	async processBatch(items: T[]): Promise<BatchItemOutcome<T>[]> {
		return Promise.all(items.map((item) => this.processOne(item)));
	}

	private async processOne(item: T): Promise<BatchItemOutcome<T>> {
		const resolved = getPerItemMaxAttempts(item, this.defaultMaxAttempts);
		const maxAttempts = Math.max(
			1,
			this.maxAttemptsCap !== undefined
				? Math.min(resolved, this.maxAttemptsCap)
				: resolved,
		);
		let retryCount = 0;
		let lastError: Error = new Error("unknown");

		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			let exhausted = false;
			await this.semaphore.acquire();
			try {
				await this.process(item);
				return { item, success: true, retryCount };
			} catch (err) {
				// error-policy:J4 Per-item retry is bounded; exhaustion becomes
				// an explicit failed BatchItemOutcome.
				lastError = err instanceof Error ? err : new Error(String(err));
				if (
					attempt >= maxAttempts ||
					!this.shouldRetry(item, lastError, attempt)
				) {
					exhausted = true;
				} else {
					retryCount++;
				}
			} finally {
				this.semaphore.release();
			}
			if (exhausted) {
				if (this.onExhausted) {
					try {
						await this.onExhausted(item, lastError);
					} catch {
						// error-policy:J7 Exhaustion callbacks observe an already
						// failed item and cannot abort independent batch work.
						// Keep callback failures from aborting the whole batch
					}
				}
				return {
					item,
					success: false,
					error: lastError,
					retryCount,
				};
			}
			const delayMs = computeBackoff(this.policy, attempt);
			if (delayMs > 0) {
				await sleep(delayMs);
			}
		}

		// Unreachable when maxAttempts >= 1 (loop always returns), but satisfies the compiler.
		return { item, success: false, error: lastError, retryCount };
	}
}

export interface TaskDrainOptions {
	taskName: string;
	/** Initial interval for repeat task metadata. */
	intervalMs: number;
	/** Optional DB task description (e.g. affinity label). */
	description?: string;
	/** Extra metadata merged into the repeat task (e.g. `{ affinityKey: "default" }`). */
	taskMetadata?: Record<string, unknown>;
	/**
	 * When true, does not call `runtime.registerTaskWorker` — use when a global worker
	 * already handles this task name (e.g. `BATCHER_DRAIN` in the assistant plugin).
	 */
	skipRegisterWorker?: boolean;
	/**
	 * Required unless `skipRegisterWorker` is true. Invoked when the repeat task
	 * fires; may return how many items it processed so an idle queue can back off.
	 */
	onDrain?: (
		runtime: IAgentRuntime,
	) => Promise<void> | Promise<number | undefined>;
	/**
	 * Cadence while the last drain processed nothing. EMBEDDING_DRAIN and
	 * PII_SCRUB_DRAIN rewrote public.tasks every second around the clock while
	 * idle (audit 2026-09-13); the next non-empty drain restores `intervalMs`.
	 */
	idleIntervalMs?: number;
}

export class TaskDrain {
	private readonly taskName: string;
	private readonly taskMetadata: Record<string, unknown>;
	private readonly skipRegisterWorker: boolean;
	private readonly onDrain?: (
		runtime: IAgentRuntime,
	) => Promise<void> | Promise<number | undefined>;
	private readonly idleIntervalMs?: number;
	private intervalMs: number;
	private taskId: UUID | null = null;
	private workerRegistered = false;
	private disposed = false;

	private readonly description: string;

	constructor(options: TaskDrainOptions, initialIntervalMs?: number) {
		this.taskName = options.taskName;
		this.description =
			options.description ?? `Repeat drain: ${options.taskName}`;
		this.taskMetadata = { ...(options.taskMetadata ?? {}) };
		this.skipRegisterWorker = options.skipRegisterWorker ?? false;
		this.onDrain = options.onDrain;
		this.idleIntervalMs = options.idleIntervalMs;
		this.intervalMs = initialIntervalMs ?? options.intervalMs;
	}

	get id(): UUID | null {
		return this.taskId;
	}

	/**
	 * Register worker (unless skipped) and ensure the repeat task exists for this agent.
	 */
	async start(runtime: IAgentRuntime): Promise<void> {
		if (this.disposed) {
			return;
		}
		if (!this.skipRegisterWorker) {
			const onDrain = this.onDrain;
			if (!onDrain) {
				throw new Error(
					"TaskDrain: onDrain is required when registerWorker is enabled",
				);
			}
			runtime.registerTaskWorker({
				name: this.taskName,
				execute: async (
					rt: IAgentRuntime,
					_options: Record<string, JsonValue | object>,
					_task: Task,
				) => {
					const processed = await onDrain(rt);
					if (
						this.idleIntervalMs === undefined ||
						typeof processed !== "number"
					) {
						return undefined;
					}
					return {
						nextInterval: processed > 0 ? this.intervalMs : this.idleIntervalMs,
					};
				},
			});
			this.workerRegistered = true;
		}

		await this.ensureTask(runtime);
	}

	/** Match agent + every key in `taskMetadata` (e.g. affinityKey for batcher drains). */
	private matchesTask(t: Task, agentId: string): boolean {
		if (t.agentId == null || String(t.agentId) !== String(agentId)) {
			return false;
		}
		const tags = Array.isArray(t.tags) ? t.tags : [];
		if (!tags.includes("queue") || !tags.includes("repeat")) {
			return false;
		}
		const meta = (t.metadata ?? {}) as Record<string, unknown>;
		for (const [key, value] of Object.entries(this.taskMetadata)) {
			if (meta[key] !== value) {
				return false;
			}
		}
		return true;
	}

	private async ensureTask(runtime: IAgentRuntime): Promise<void> {
		if (
			typeof runtime.getTasksByName !== "function" ||
			typeof runtime.createTask !== "function"
		) {
			return;
		}
		const agentId = runtime.agentId;
		const existing = await runtime.getTasksByName(this.taskName);
		const matchingTasks = existing.filter((t) =>
			this.matchesTask(t, String(agentId)),
		);
		const mine = matchingTasks[0];
		if (mine?.id) {
			this.taskId = mine.id;
			if (
				matchingTasks.length > 1 &&
				typeof runtime.deleteTask === "function"
			) {
				await Promise.allSettled(
					matchingTasks
						.slice(1)
						.filter((task): task is Task & { id: UUID } => Boolean(task.id))
						.map((task) => runtime.deleteTask(task.id)),
				);
			}
			// Reconcile DB interval/metadata with this drain’s configured interval (stale rows after restart).
			if (
				typeof runtime.getTask === "function" &&
				typeof runtime.updateTask === "function"
			) {
				await this.updateInterval(runtime, this.intervalMs);
			}
			return;
		}
		this.taskId = await runtime.createTask({
			name: this.taskName,
			description: this.description,
			tags: ["queue", "repeat"],
			agentId: agentId as UUID,
			worldId: agentId as UUID,
			metadata: {
				...this.taskMetadata,
				updateInterval: this.intervalMs,
				baseInterval: this.intervalMs,
				updatedAt: Date.now(),
				maxFailures: -1,
			},
		});
	}

	/**
	 * Update repeat interval in DB when scheduling changes (e.g. batcher ideal tick).
	 */
	async updateInterval(
		runtime: IAgentRuntime,
		newIntervalMs: number,
	): Promise<void> {
		this.intervalMs = newIntervalMs;
		const taskId = this.taskId;
		if (
			!taskId ||
			typeof runtime.getTask !== "function" ||
			typeof runtime.updateTask !== "function"
		) {
			return;
		}
		const task = await runtime.getTask(taskId);
		if (!task) {
			this.taskId = null;
			return;
		}
		const current = (task.metadata as Record<string, unknown>)
			?.updateInterval as number | undefined;
		if (current === newIntervalMs) {
			return;
		}
		await runtime.updateTask(taskId, {
			metadata: {
				...task.metadata,
				updateInterval: newIntervalMs,
				baseInterval: newIntervalMs,
			},
		});
	}

	getIntervalMs(): number {
		return this.intervalMs;
	}

	async dispose(runtime: IAgentRuntime): Promise<void> {
		this.disposed = true;
		if (this.taskId && typeof runtime.deleteTask === "function") {
			const taskId = this.taskId;
			// error-policy:J7 diagnostics-must-not-kill-the-loop — dispose must always
			// complete, but a failed delete leaves an orphaned task row; surface it.
			await runtime
				.deleteTask(taskId)
				.catch((err) =>
					runtime.reportError("TaskDrain.dispose", err, { taskId }),
				);
			this.taskId = null;
		}
		// Runtime has no unregisterTaskWorker; a later service may call registerTaskWorker again.
		if (this.workerRegistered) {
			this.workerRegistered = false;
		}
	}
}
