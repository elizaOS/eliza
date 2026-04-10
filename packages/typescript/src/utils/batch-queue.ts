/**
 * Composable batch processing for background work: priority queues, concurrency-limited
 * batches with retries, and task-system-driven drains.
 *
 * See `docs/BATCH_QUEUE.md` in this package for architecture, consumers, and WHYs.
 */
export {
	type BatchItemOutcome,
	BatchProcessor,
	BatchQueue,
	type BatchQueueOptions,
	type DrainStats,
	PriorityQueue,
	type PriorityQueueOptions,
	type PriorityQueueStats,
	type QueuePriority,
	Semaphore,
	TaskDrain,
	type TaskDrainOptions,
} from "./batch-queue/index.js";
