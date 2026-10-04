/**
 * Composed batch pipeline: {@link PriorityQueue} (what to run next) +
 * {@link BatchProcessor} (how to run a slice with concurrency + retries) +
 * {@link TaskDrain} (when the task system ticks). Use {@link BatchQueue} for services that need
 * all three; use layers alone when you only need ordering, or only batch execution, or only
 * repeat-task CRUD.
 *
 * **Rationale:** avoid parallel one-off queue + drain + retry implementations as features grow;
 * The same queue, retry, and drain implementation serves all runtime consumers.
 */

import type { IAgentRuntime } from "../../types/runtime.js";
import type { RetryConfig } from "../retry.js";
import { type BatchItemOutcome, BatchProcessor } from "./batch-processor.js";
import {
	PriorityQueue,
	type PriorityQueueStats,
	type QueuePriority,
} from "./priority-queue.js";
import { TaskDrain } from "./task-drain.js";

export { type BatchItemOutcome, BatchProcessor } from "./batch-processor.js";
export {
	PriorityQueue,
	type PriorityQueueOptions,
	type PriorityQueueStats,
	type QueuePriority,
} from "./priority-queue.js";
export { Semaphore } from "./semaphore.js";
export { TaskDrain, type TaskDrainOptions } from "./task-drain.js";

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
