/**
 * Composed batch pipeline: {@link PriorityQueue} (what to run next) +
 * {@link BatchProcessor} (how to run a slice with concurrency + retries) +
 * {@link TaskDrain} (when the task system ticks). Use {@link BatchQueue} for services that need
 * all three; use layers alone when you only need ordering, or only batch execution, or only
 * repeat-task CRUD — see `docs/BATCH_QUEUE.md`.
 */
import type { RetryConfig } from "../retry.js";
import type { IAgentRuntime } from "../../types/runtime.js";
import { BatchProcessor } from "./batch-processor.js";
import {
	PriorityQueue,
	type PriorityQueueStats,
	type QueuePriority,
} from "./priority-queue.js";
import { TaskDrain } from "./task-drain.js";

export { BatchProcessor, type BatchItemOutcome } from "./batch-processor.js";
export {
	PriorityQueue,
	type PriorityQueueOptions,
	type PriorityQueueStats,
	type QueuePriority,
} from "./priority-queue.js";
export { TaskDrain, type TaskDrainOptions } from "./task-drain.js";
export { Semaphore } from "./semaphore.js";

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
	getPriority: (item: T) => QueuePriority;
	process: (item: T) => Promise<void>;
	maxParallel?: number;
	maxRetriesAfterFailure?: number;
	retryPolicy?: RetryConfig;
	maxSize?: number;
	onPressure?: (queue: PriorityQueue<T>, item: T) => boolean;
	onOverflowWarning?: (sizeAfter: number, maxSize: number) => void;
	onExhausted?: (item: T, error: Error) => void | Promise<void>;
	onDrainComplete?: (stats: DrainStats) => void;
	shouldRetry?: (item: T, error: Error, attempt: number) => boolean;
	/**
	 * When false, only registers the repeat task — caller must register `name` with TaskService
	 * (e.g. `BATCHER_DRAIN`). Default true.
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
 */
export class BatchQueue<T> {
	private readonly priorityQueue: PriorityQueue<T>;
	private readonly batchProcessor: BatchProcessor<T>;
	private taskDrain: TaskDrain | null = null;
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
	 */
	async drain(): Promise<void> {
		if (this.disposed || this.isDraining) {
			return;
		}
		this.isDraining = true;
		const started = Date.now();
		try {
			const batch = this.priorityQueue.dequeueBatch(this.batchSize);
			if (batch.length === 0) {
				return;
			}
			await this.batchProcessor.processBatch(batch);
			const durationMs = Date.now() - started;
			this.options.onDrainComplete?.({
				batchSize: batch.length,
				remaining: this.priorityQueue.size,
				durationMs,
			});
		} finally {
			this.isDraining = false;
		}
	}

	/** Wire `TaskDrain` (worker + repeat task unless `skipRegisterWorker`). */
	async start(runtime: IAgentRuntime): Promise<void> {
		const skip = this.options.skipRegisterWorker ?? false;
		this.taskDrain = new TaskDrain(
			{
				taskName: this.options.name,
				description: this.options.taskDescription,
				intervalMs: this.options.drainIntervalMs,
				taskMetadata: this.options.taskMetadata,
				skipRegisterWorker: skip,
				onDrain: skip
					? undefined
					: async () => {
							await this.drain();
						},
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
			opts?.flushHighPriority ??
			(this.options.drainHighPriorityOnStop !== false);
		if (flush) {
			const high = this.priorityQueue.drain(
				(item) => this.options.getPriority(item) === "high",
			);
			for (const item of high) {
				try {
					await this.options.process(item);
				} catch {
					/* best effort on shutdown */
				}
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
		this.priorityQueue.clear();
	}
}
