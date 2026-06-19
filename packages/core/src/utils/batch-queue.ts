/**
 * **Why this module exists (architecture, not a single hot path).**
 *
 * The generic runtime is not “batching-bound”; fixing one hot spot with a few lines (for example
 * a semaphore around `Promise.all` in one service) would be locally sufficient. This package is
 * still **forward-looking consolidation**: today we already had separate ad-hoc patterns for
 * priority queues, bounded concurrency, retry/backoff, and repeat-task / drain scheduling
 * (embedding generation, action-index embedding, prompt-batcher affinity tasks, shared
 * `Semaphore` in the batcher). Each new feature risked copying another half-queue or another
 * `registerTaskWorker` + `createTask` pair.
 *
 * Here, **one composable stack** — {@link PriorityQueue}, {@link BatchProcessor}, {@link TaskDrain},
 * and {@link BatchQueue} when a service needs all three — is the deliberate trade: a small shared
 * surface so we do **not** keep growing incompatible “queuing systems” across the codebase. Callers
 * use only the layers they need (for example `BatchProcessor` alone for a synchronous batch job).
 *
 * Re-exports below; implementation lives under `./batch-queue/`.
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
