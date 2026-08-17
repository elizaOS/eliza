/**
 * Long-lived singleton that owns asynchronous embedding generation for memories.
 * Registered by the basic-capabilities bundle; it listens for
 * EMBEDDING_GENERATION_REQUESTED events and drains a priority `BatchQueue` on the
 * task scheduler, embedding each memory's text and writing the vector back via
 * `updateMemory`. When a TEXT_EMBEDDING_BATCH model is registered it collapses a
 * per-turn embed burst into one round-trip, falling back per-item on any batch
 * failure. It subscribes before a model exists and starts its drain exactly once
 * when a late canonical embedding handler becomes eligible, preserving requests
 * that arrive during local-model warmup for a later safe retry.
 */
import { normalizeCanonicalEmbedding } from "../constants/embeddings.ts";
import type {
	EmbeddingGenerationPayload,
	ModelRegisteredEventPayload,
} from "../types/events";
import { EventType } from "../types/events";
import type { Memory } from "../types/memory";
import { ModelType } from "../types/model";
import type { IAgentRuntime } from "../types/runtime";
import { Service } from "../types/service";
import { type BatchItemOutcome, BatchQueue } from "../utils/batch-queue";
import {
	isExpectedLocalEmbeddingUnavailability,
	modelProviderFailureDetails,
} from "../utils/expected-local-embedding-unavailability";

interface EmbeddingQueueItem {
	memory: Memory;
	priority: "high" | "normal" | "low";
	runId?: string;
}

/**
 * Service responsible for generating embeddings asynchronously
 * This service listens for EMBEDDING_GENERATION_REQUESTED events
 * and processes them in a queue to avoid blocking the main runtime
 */

export class EmbeddingGenerationService extends Service {
	static serviceType = "embedding-generation";
	private static readonly EMBEDDING_DRAIN_TASK = "EMBEDDING_DRAIN";
	private static readonly MIN_READINESS_WAKE_MS = 100;
	private static readonly MAX_READINESS_WAKE_MS = 2_000;
	capabilityDescription =
		"Handles asynchronous embedding generation for memories";

	private batchQueue: BatchQueue<EmbeddingQueueItem> | null = null;
	private queueStartPromise: Promise<boolean> | null = null;
	private readonly pendingRequests = new Map<string, EmbeddingQueueItem>();
	private pendingRequestSequence = 0;
	private readinessWakeTimer: ReturnType<typeof setTimeout> | null = null;
	private readinessWakePromise: Promise<void> | null = null;
	private readinessWakeDelayMs =
		EmbeddingGenerationService.MIN_READINESS_WAKE_MS;
	private isStopped = false;
	private readonly embeddingRequestHandler = (
		payload: EmbeddingGenerationPayload,
	): Promise<void> => this.handleEmbeddingRequest(payload);
	private readonly modelRegisteredHandler = (
		payload: ModelRegisteredEventPayload,
	): Promise<void> => this.handleModelRegistered(payload);

	static async start(runtime: IAgentRuntime): Promise<Service> {
		runtime.logger.info(
			{
				src: "plugin:basic-capabilities:service:embedding",
				agentId: runtime.agentId,
			},
			"Starting embedding generation service",
		);

		const service = new EmbeddingGenerationService(runtime);
		await service.initialize();
		return service;
	}

	async initialize(): Promise<void> {
		this.runtime.logger.info(
			{
				src: "plugin:basic-capabilities:service:embedding",
				agentId: this.runtime.agentId,
			},
			"Initializing embedding generation service",
		);

		this.runtime.registerEvent(
			EventType.EMBEDDING_GENERATION_REQUESTED,
			this.embeddingRequestHandler,
		);
		this.runtime.registerEvent(
			EventType.MODEL_REGISTERED,
			this.modelRegisteredHandler,
		);

		if (!(await this.ensureQueueStarted())) {
			this.runtime.logger.info(
				{
					src: "plugin:basic-capabilities:service:embedding",
					agentId: this.runtime.agentId,
				},
				"Waiting for an eligible canonical embedding model",
			);
		}
	}

	private hasEmbeddingModel(): boolean {
		return Boolean(
			this.runtime.getModel(ModelType.TEXT_EMBEDDING) ||
				this.runtime.getModel(ModelType.TEXT_EMBEDDING_BATCH),
		);
	}

	private async handleModelRegistered(
		payload: ModelRegisteredEventPayload,
	): Promise<void> {
		if (
			payload.modelType !== ModelType.TEXT_EMBEDDING &&
			payload.modelType !== ModelType.TEXT_EMBEDDING_BATCH
		) {
			return;
		}
		await this.ensureQueueStarted();
		this.scheduleReadinessWake();
	}

	/** Start the shared drain once; concurrent late registrations join one promise. */
	private async ensureQueueStarted(): Promise<boolean> {
		if (this.isStopped) return false;
		if (this.queueStartPromise) return this.queueStartPromise;
		if (this.batchQueue) return true;
		if (!this.hasEmbeddingModel()) return false;

		this.queueStartPromise = this.startQueue();
		try {
			return await this.queueStartPromise;
		} finally {
			this.queueStartPromise = null;
		}
	}

	private async startQueue(): Promise<boolean> {
		if (this.isStopped || this.batchQueue) return Boolean(this.batchQueue);

		// Uses shared `utils/batch-queue` (see `batch-queue.ts` header): same drain/retry/priority
		// model as other services so we do not maintain another bespoke queue + task stack here.
		// Task system owns WHEN (repeat EMBEDDING_DRAIN tick); we own WHAT (dequeue, embed, persist).
		// No maxSize — bottleneck is embedding I/O, not queue length.
		//
		// When a TEXT_EMBEDDING_BATCH model is registered (e.g. the cloud plugin),
		// each drain embeds the whole slice in ONE round-trip instead of N — the
		// per-turn embed burst (2-5 calls) collapses to a single POST /embeddings.
		// `processBatch` throwing falls the WHOLE batch back to the per-item
		// `process` path (BatchQueue.drain), so retry / onExhausted semantics and
		// per-id write-back are preserved on any batch failure.
		const hasBatchModel = Boolean(
			this.runtime.getModel(ModelType.TEXT_EMBEDDING_BATCH),
		);
		const batchQueue = new BatchQueue<EmbeddingQueueItem>({
			name: EmbeddingGenerationService.EMBEDDING_DRAIN_TASK,
			taskDescription: "Embedding generation drain",
			batchSize: 10,
			drainIntervalMs: 100,
			getPriority: (item) => item.priority,
			maxParallel: 10,
			maxRetriesAfterFailure: 3,
			process: (item) => this.generateEmbedding(item),
			processBatch: hasBatchModel
				? (items) => this.generateEmbeddingsBatch(items)
				: undefined,
			onExhausted: async (item, error) => {
				if (
					modelProviderFailureDetails(error).code ===
					"EMBEDDING_SPACE_UNAVAILABLE"
				) {
					// Reconciliation has not opened the canonical space yet. Keep the
					// request instead of converting local warmup ordering into data loss;
					// the bounded readiness wake retries this deduplicated backlog.
					this.rememberPending(item);
					return;
				}
				await this.runtime.log({
					entityId: this.runtime.agentId,
					roomId: item.memory.roomId || this.runtime.agentId,
					type: "embedding_event",
					body: {
						runId: item.runId,
						memoryId: item.memory.id,
						status: "failed",
						error: error.message,
						source: "embeddingService",
					},
				});
				await this.runtime.emitEvent(EventType.EMBEDDING_GENERATION_FAILED, {
					runtime: this.runtime,
					memory: item.memory,
					error: error.message,
					source: "embeddingService",
				});
			},
			shouldRetry: (_item, error) =>
				modelProviderFailureDetails(error).code !==
				"EMBEDDING_SPACE_UNAVAILABLE",
		});

		this.batchQueue = batchQueue;
		try {
			await batchQueue.start(this.runtime);
		} catch (error) {
			this.batchQueue = null;
			throw error;
		}

		this.runtime.logger.info(
			{
				src: "plugin:basic-capabilities:service:embedding",
				agentId: this.runtime.agentId,
			},
			"Started embedding drain task",
		);
		return true;
	}

	private pendingKey(item: EmbeddingQueueItem): string {
		if (item.memory.id) return String(item.memory.id);
		this.pendingRequestSequence += 1;
		return `anonymous:${this.pendingRequestSequence}`;
	}

	private rememberPending(item: EmbeddingQueueItem): void {
		this.pendingRequests.set(this.pendingKey(item), item);
		this.scheduleReadinessWake();
	}

	private flushPendingRequests(queue: BatchQueue<EmbeddingQueueItem>): void {
		if (this.pendingRequests.size === 0) return;
		for (const item of this.pendingRequests.values()) {
			queue.enqueue(item);
		}
		this.pendingRequests.clear();
	}

	/**
	 * Keep retained warmup/reconciliation work live even if no later request is
	 * emitted. The wake interval backs off to a bounded ceiling while the model
	 * or canonical SQL space is unavailable, then resets after a successful
	 * drain. Only one timer and one wake may be active at a time.
	 */
	private scheduleReadinessWake(): void {
		if (
			this.isStopped ||
			this.pendingRequests.size === 0 ||
			this.readinessWakeTimer ||
			this.readinessWakePromise
		) {
			return;
		}

		const delayMs = this.readinessWakeDelayMs;
		this.readinessWakeDelayMs = Math.min(
			delayMs * 2,
			EmbeddingGenerationService.MAX_READINESS_WAKE_MS,
		);
		this.readinessWakeTimer = setTimeout(async () => {
			this.readinessWakeTimer = null;
			await this.wakePendingRequests();
		}, delayMs);
	}

	private async wakePendingRequests(): Promise<void> {
		if (this.readinessWakePromise) return this.readinessWakePromise;
		if (this.isStopped || this.pendingRequests.size === 0) return;

		const wake = this.runReadinessWake();
		this.readinessWakePromise = wake;
		try {
			await wake;
		} finally {
			if (this.readinessWakePromise === wake) {
				this.readinessWakePromise = null;
			}
			this.scheduleReadinessWake();
		}
	}

	private async runReadinessWake(): Promise<void> {
		try {
			if (!(await this.ensureQueueStarted())) return;
			const queue = this.batchQueue;
			if (!queue || this.isStopped) return;

			this.flushPendingRequests(queue);
			await queue.drain();
			if (this.pendingRequests.size === 0) {
				this.readinessWakeDelayMs =
					EmbeddingGenerationService.MIN_READINESS_WAKE_MS;
			}
		} catch (error) {
			this.runtime.reportError("EmbeddingService.readinessWake", error, {
				pendingCount: this.pendingRequests.size,
			});
		}
	}

	private async handleEmbeddingRequest(
		payload: EmbeddingGenerationPayload,
	): Promise<void> {
		const { memory, priority = "normal", runId } = payload;

		if (Array.isArray(memory.embedding) && memory.embedding.length > 0) {
			this.runtime.logger.debug(
				{
					src: "plugin:basic-capabilities:service:embedding",
					agentId: this.runtime.agentId,
					memoryId: memory.id,
				},
				"Memory already has embeddings, skipping",
			);
			return;
		}

		const queueItem: EmbeddingQueueItem = {
			memory,
			priority,
			runId,
		};

		if (!(await this.ensureQueueStarted())) {
			this.rememberPending(queueItem);
			// Close the registration/request race: if a model appeared after the
			// first readiness check, start once and move the just-retained item.
			if (await this.ensureQueueStarted()) {
				const queue = this.batchQueue;
				if (queue) this.flushPendingRequests(queue);
			}
			return;
		}

		const queue = this.batchQueue;
		if (!queue) {
			this.rememberPending(queueItem);
			return;
		}
		this.flushPendingRequests(queue);
		queue.enqueue(queueItem);

		this.runtime.logger.debug(
			{
				src: "plugin:basic-capabilities:service:embedding",
				agentId: this.runtime.agentId,
				queueSize: queue.size,
			},
			"Added memory to queue",
		);
	}

	private async generateEmbedding(item: EmbeddingQueueItem): Promise<void> {
		const { memory } = item;

		const memoryContent = memory.content;
		// Trim-check to match the embedding model contract: backends reject
		// whitespace-only text, and no queue retry can ever change that
		// (live 2026-08-10: image-only messages with whitespace text error-
		// logged on every retry).
		if (!memoryContent.text?.trim()) {
			this.runtime.logger.warn(
				{
					src: "plugin:basic-capabilities:service:embedding",
					agentId: this.runtime.agentId,
					memoryId: memory.id,
				},
				"Memory has no text content",
			);
			return;
		}

		// Idempotency: skip a memory that already carries a vector.
		if (Array.isArray(memory.embedding) && memory.embedding.length > 0) {
			return;
		}

		try {
			const startTime = Date.now();

			const embedding = await this.runtime.useModel(ModelType.TEXT_EMBEDDING, {
				text: memory.content.text ?? "",
			});

			const duration = Date.now() - startTime;
			this.runtime.logger.debug(
				{
					src: "plugin:basic-capabilities:service:embedding",
					agentId: this.runtime.agentId,
					memoryId: memory.id,
					durationMs: duration,
				},
				"Generated embedding",
			);

			await this.persistEmbedding(item, embedding, duration);
		} catch (error) {
			// error-policy:J2 Queue retry policy needs the original failure; rethrow
			// unchanged. Expected local backend/capability absence is designed
			// degraded mode — report only unexpected failures so RECENT_ERRORS
			// and owner escalation are not filled by ordinary keyword-only turns.
			if (!isExpectedLocalEmbeddingUnavailability(error)) {
				this.runtime.reportError("EmbeddingService.generate", error, {
					memoryId: memory.id,
				});
			}
			this.runtime.logger.error(
				{
					src: "plugin:basic-capabilities:service:embedding",
					agentId: this.runtime.agentId,
					memoryId: memory.id,
					error: error instanceof Error ? error.message : String(error),
				},
				"Failed to generate embedding",
			);
			throw error;
		}
	}

	/**
	 * Persist a generated vector to its memory and emit the completion event.
	 * Shared by the per-item ({@link generateEmbedding}) and batched
	 * ({@link generateEmbeddingsBatch}) paths so write-back is identical.
	 */
	private async persistEmbedding(
		item: EmbeddingQueueItem,
		embedding: number[],
		durationMs: number,
	): Promise<void> {
		const { memory } = item;
		if (!memory.id) {
			return;
		}
		if (!Array.isArray(embedding) || embedding.length === 0) {
			// An empty vector is a failed generation, not a real embedding.
			// Persisting it would write nothing yet report success, marking the
			// memory permanently "embedded" with no vector (silent recall gap).
			// Throw so both callers route it through their failure path: the
			// per-item path rethrows; the batch loop records success:false and
			// retries. A real semantic embedding must also pass the canonical
			// width/finite/non-zero validator below.
			throw new Error(
				`[EmbeddingGenerationService] refusing to persist an empty embedding for memory ${memory.id}; the embedding model returned no vector`,
			);
		}
		const canonicalEmbedding = normalizeCanonicalEmbedding(embedding);
		await this.runtime.updateMemory({
			id: memory.id,
			embedding: canonicalEmbedding,
		});
		await this.runtime.log({
			entityId: this.runtime.agentId,
			roomId: memory.roomId || this.runtime.agentId,
			type: "embedding_event",
			body: {
				runId: item.runId,
				memoryId: memory.id,
				status: "completed",
				duration: durationMs,
				source: "embeddingService",
			},
		});
		await this.runtime.emitEvent(EventType.EMBEDDING_GENERATION_COMPLETED, {
			runtime: this.runtime,
			memory: { ...memory, embedding: canonicalEmbedding },
			source: "embeddingService",
		});
	}

	/**
	 * Batched drain path: embed every queued text in ONE TEXT_EMBEDDING_BATCH
	 * round-trip, then write each vector back to its own memory id.
	 *
	 * Returns a {@link BatchItemOutcome} per item so the queue applies its normal
	 * retry / `onExhausted` accounting. Items with no text or an already-present
	 * vector are skipped (counted as success — nothing to do). If the single
	 * batch model call throws, this throws too, which makes `BatchQueue.drain`
	 * fall the WHOLE slice back to the per-item {@link generateEmbedding} path —
	 * preserving the per-item fallback and per-id write-back guarantees.
	 */
	private async generateEmbeddingsBatch(
		items: EmbeddingQueueItem[],
	): Promise<BatchItemOutcome<EmbeddingQueueItem>[]> {
		// Partition: only items that actually need an embed go in the batch call.
		const toEmbed: { item: EmbeddingQueueItem; text: string }[] = [];
		const skipped: EmbeddingQueueItem[] = [];
		for (const item of items) {
			const text = item.memory.content.text;
			// Same trim rule as the per-item path — backends reject
			// whitespace-only text as terminally invalid.
			if (
				!text?.trim() ||
				(Array.isArray(item.memory.embedding) &&
					item.memory.embedding.length > 0)
			) {
				skipped.push(item);
			} else {
				toEmbed.push({ item, text });
			}
		}

		if (toEmbed.length === 0) {
			return items.map((item) => ({ item, success: true, retryCount: 0 }));
		}

		const startTime = Date.now();
		// A throw here propagates to BatchQueue.drain, which falls the whole batch
		// back to per-item `process` (generateEmbedding) — the safe fallback.
		const vectors = await this.runtime.useModel(
			ModelType.TEXT_EMBEDDING_BATCH,
			{ texts: toEmbed.map((entry) => entry.text) },
		);
		const duration = Date.now() - startTime;

		if (!Array.isArray(vectors) || vectors.length !== toEmbed.length) {
			// Shape mismatch can't be mapped back to ids safely — fall the whole
			// batch back to the per-item path.
			throw new Error(
				`TEXT_EMBEDDING_BATCH returned ${Array.isArray(vectors) ? vectors.length : "non-array"} vectors for ${toEmbed.length} texts`,
			);
		}

		this.runtime.logger.debug(
			{
				src: "plugin:basic-capabilities:service:embedding",
				agentId: this.runtime.agentId,
				count: toEmbed.length,
				durationMs: duration,
			},
			"Generated embeddings (batch)",
		);

		// Write each vector back to its own memory id. A single id's write-back
		// failure is recorded against that item only — it does not poison the
		// rest of the batch or trigger a whole-batch fallback.
		const outcomes: BatchItemOutcome<EmbeddingQueueItem>[] = skipped.map(
			(item) => ({ item, success: true, retryCount: 0 }),
		);
		for (let i = 0; i < toEmbed.length; i++) {
			const { item } = toEmbed[i];
			try {
				await this.persistEmbedding(item, vectors[i], duration);
				outcomes.push({ item, success: true, retryCount: 0 });
			} catch (error) {
				// error-policy:J1 Batch outcomes are the queue boundary's explicit
				// per-item failure channel; successful siblings remain valid.
				const err = error instanceof Error ? error : new Error(String(error));
				this.runtime.reportError("EmbeddingService.persistBatchItem", err, {
					memoryId: item.memory.id,
				});
				this.runtime.logger.error(
					{
						src: "plugin:basic-capabilities:service:embedding",
						agentId: this.runtime.agentId,
						memoryId: item.memory.id,
						error: err.message,
					},
					"Failed to persist batched embedding",
				);
				outcomes.push({ item, success: false, error: err, retryCount: 0 });
			}
		}
		return outcomes;
	}

	async stop(): Promise<void> {
		this.isStopped = true;
		if (this.readinessWakeTimer) {
			clearTimeout(this.readinessWakeTimer);
			this.readinessWakeTimer = null;
		}
		await this.readinessWakePromise;
		this.runtime.unregisterEvent(
			EventType.EMBEDDING_GENERATION_REQUESTED,
			this.embeddingRequestHandler,
		);
		this.runtime.unregisterEvent(
			EventType.MODEL_REGISTERED,
			this.modelRegisteredHandler,
		);
		this.runtime.logger.info(
			{
				src: "plugin:basic-capabilities:service:embedding",
				agentId: this.runtime.agentId,
			},
			"Stopping embedding generation service",
		);

		if (!this.batchQueue) {
			this.runtime.logger.debug(
				{
					src: "plugin:basic-capabilities:service:embedding",
					agentId: this.runtime.agentId,
				},
				"No embedding drain is active",
			);
			this.pendingRequests.clear();
			return;
		}

		const remaining = this.batchQueue.size;
		const fastShutdown = process.env.ELIZA_FAST_SHUTDOWN === "1";
		if (fastShutdown) {
			this.batchQueue.clear();
		}
		await this.batchQueue.dispose(this.runtime, {
			flushHighPriority: !fastShutdown,
		});

		this.runtime.logger.info(
			{
				src: "plugin:basic-capabilities:service:embedding",
				agentId: this.runtime.agentId,
				remainingItems: remaining,
			},
			"Stopped",
		);

		this.batchQueue = null;
		this.pendingRequests.clear();
	}

	getQueueSize(): number {
		return this.batchQueue?.size ?? 0;
	}

	getQueueStats(): {
		high: number;
		normal: number;
		low: number;
		total: number;
	} {
		return this.batchQueue?.stats() ?? { high: 0, normal: 0, low: 0, total: 0 };
	}

	clearQueue(): void {
		const size = this.batchQueue?.size ?? 0;
		this.batchQueue?.clear();
		this.runtime.logger.info(
			{
				src: "plugin:basic-capabilities:service:embedding",
				agentId: this.runtime.agentId,
				clearedCount: size,
			},
			"Cleared queue",
		);
	}
}

export default EmbeddingGenerationService;
