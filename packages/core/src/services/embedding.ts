import type { EmbeddingGenerationPayload } from "../types/events";
import { EventType } from "../types/events";
import type { Memory } from "../types/memory";
import { ModelType } from "../types/model";
import type { IAgentRuntime } from "../types/runtime";
import { Service } from "../types/service";
import { type BatchItemOutcome, BatchQueue } from "../utils/batch-queue";

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

/**
 * Drain cadence for the embedding queue WHEN a batch handler is registered.
 * A turn's ~19 memories trickle in ~250ms apart across the ~5s turn; the prior
 * 100ms drain caught only 1 each (a "batch of 1" — no real batching). ~1s lets
 * ~4–10 accumulate so one drain embeds them in a single TEXT_EMBEDDING_BATCH
 * request — ~2–5 batched calls instead of ~19 serial, taking post-turn
 * embedding ~30s → ~5–7s. It's background work, so the sub-second drain delay
 * is invisible. Env-tunable (`ELIZA_EMBEDDING_DRAIN_INTERVAL_MS`) for prod.
 */
const EMBEDDING_BATCH_DRAIN_INTERVAL_MS = (() => {
	const raw = Number(
		typeof process !== "undefined"
			? process.env.ELIZA_EMBEDDING_DRAIN_INTERVAL_MS
			: undefined,
	);
	return Number.isFinite(raw) && raw > 0 ? raw : 1000;
})();

export class EmbeddingGenerationService extends Service {
	static serviceType = "embedding-generation";
	capabilityDescription =
		"Handles asynchronous embedding generation for memories";

	private batchQueue: BatchQueue<EmbeddingQueueItem> | null = null;
	private isDisabled = false;

	private static readonly EMBEDDING_DRAIN_TASK = "EMBEDDING_DRAIN";

	static async start(runtime: IAgentRuntime): Promise<Service> {
		runtime.logger.info(
			{
				src: "plugin:basic-capabilities:service:embedding",
				agentId: runtime.agentId,
			},
			"Starting embedding generation service",
		);

		const embeddingModel = runtime.getModel(ModelType.TEXT_EMBEDDING);
		if (!embeddingModel) {
			runtime.logger.warn(
				{
					src: "plugin:basic-capabilities:service:embedding",
					agentId: runtime.agentId,
				},
				"No TEXT_EMBEDDING model registered - service will not be initialized",
			);
			const noOpService = new EmbeddingGenerationService(runtime);
			noOpService.isDisabled = true;
			return noOpService;
		}

		const service = new EmbeddingGenerationService(runtime);
		await service.initialize();
		return service;
	}

	async initialize(): Promise<void> {
		if (this.isDisabled) {
			this.runtime.logger.debug(
				{
					src: "plugin:basic-capabilities:service:embedding",
					agentId: this.runtime.agentId,
				},
				"Service is disabled, skipping initialization",
			);
			return;
		}

		this.runtime.logger.info(
			{
				src: "plugin:basic-capabilities:service:embedding",
				agentId: this.runtime.agentId,
			},
			"Initializing embedding generation service",
		);

		this.runtime.registerEvent(
			EventType.EMBEDDING_GENERATION_REQUESTED,
			this.handleEmbeddingRequest.bind(this),
		);

		// Uses shared `utils/batch-queue` (see `batch-queue.ts` header): same drain/retry/priority
		// model as other services so we do not maintain another bespoke queue + task stack here.
		// Task system owns WHEN (repeat EMBEDDING_DRAIN tick); we own WHAT (dequeue, embed, persist).
		// No maxSize — bottleneck is embedding I/O, not queue length.
		//
		// Only wire the batched drain when the provider actually registers a
		// TEXT_EMBEDDING_BATCH handler. Decided once here (vs a runtime
		// negative-cache) so a non-batching provider (e.g. local gte-small) never
		// pays a doomed batch attempt + per-item fallback on every drain.
		const supportsBatchEmbedding = !!this.runtime.getModel(
			ModelType.TEXT_EMBEDDING_BATCH,
		);
		this.batchQueue = new BatchQueue<EmbeddingQueueItem>({
			name: EmbeddingGenerationService.EMBEDDING_DRAIN_TASK,
			taskDescription: "Embedding generation drain",
			batchSize: 10,
			// Let memories accumulate into real batches when we can batch-embed;
			// keep the original tight 100ms for the per-item path (no accumulation
			// benefit there, and a longer wait would just delay each embed).
			drainIntervalMs: supportsBatchEmbedding
				? EMBEDDING_BATCH_DRAIN_INTERVAL_MS
				: 100,
			getPriority: (item) => item.priority,
			maxParallel: 10,
			maxRetriesAfterFailure: 3,
			process: (item) => this.generateEmbedding(item),
			// Batched drain: embed the whole dequeued slice in ONE model call
			// (TEXT_EMBEDDING_BATCH) when the provider registers it; collapses the
			// ~19 serial single-text round-trips/turn that made post-turn embedding
			// take ~30s. On any batch failure the queue falls back to `process`
			// (per-item) above, preserving retry/onExhausted.
			processBatch: supportsBatchEmbedding
				? (items) => this.generateBatchEmbeddings(items)
				: undefined,
			onExhausted: async (item, error) => {
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
		});

		await this.batchQueue.start(this.runtime);

		this.runtime.logger.info(
			{
				src: "plugin:basic-capabilities:service:embedding",
				agentId: this.runtime.agentId,
			},
			"Started embedding drain task",
		);
	}

	private async handleEmbeddingRequest(
		payload: EmbeddingGenerationPayload,
	): Promise<void> {
		if (this.isDisabled || !this.batchQueue) {
			this.runtime.logger.debug(
				{
					src: "plugin:basic-capabilities:service:embedding",
					agentId: this.runtime.agentId,
				},
				"Service is disabled or queue missing, skipping embedding request",
			);
			return;
		}

		const { memory, priority = "normal", runId } = payload;

		if (memory.embedding) {
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

		this.batchQueue.enqueue(queueItem);

		this.runtime.logger.debug(
			{
				src: "plugin:basic-capabilities:service:embedding",
				agentId: this.runtime.agentId,
				queueSize: this.batchQueue.size,
			},
			"Added memory to queue",
		);
	}

	private async generateEmbedding(item: EmbeddingQueueItem): Promise<void> {
		const { memory } = item;

		const memoryContent = memory.content;
		if (!memoryContent.text) {
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

		// A batched drain may have already persisted this vector before throwing
		// and falling back to this per-item path. Skip it so we don't re-embed or
		// re-emit EMBEDDING_GENERATION_COMPLETED for an already-vectored memory.
		if (memory.embedding) {
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

			if (memory.id) {
				await this.runtime.updateMemory({
					id: memory.id,
					embedding,
				});

				await this.runtime.log({
					entityId: this.runtime.agentId,
					roomId: memory.roomId || this.runtime.agentId,
					type: "embedding_event",
					body: {
						runId: item.runId,
						memoryId: memory.id,
						status: "completed",
						duration,
						source: "embeddingService",
					},
				});

				await this.runtime.emitEvent(EventType.EMBEDDING_GENERATION_COMPLETED, {
					runtime: this.runtime,
					memory: { ...memory, embedding },
					source: "embeddingService",
				});
			}
		} catch (error) {
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
	 * Batched drain path: embed every queued item's text in ONE
	 * `TEXT_EMBEDDING_BATCH` model call, then persist each vector. Wired as the
	 * BatchQueue `processBatch` — on ANY failure it throws, and the queue falls
	 * back to the per-item {@link generateEmbedding} path (which carries the
	 * retry / onExhausted semantics), so this only implements the happy path.
	 * Idempotent: a fallback re-run just re-`updateMemory`s the same vectors.
	 */
	private async generateBatchEmbeddings(
		items: EmbeddingQueueItem[],
	): Promise<BatchItemOutcome<EmbeddingQueueItem>[]> {
		const outcomes: BatchItemOutcome<EmbeddingQueueItem>[] = [];
		const toEmbed: { item: EmbeddingQueueItem; text: string }[] = [];
		for (const item of items) {
			const text = item.memory.content?.text;
			// No text or already vectored -> successful no-op (mirrors per-item skips).
			if (!text || item.memory.embedding) {
				outcomes.push({ item, success: true, retryCount: 0 });
				continue;
			}
			toEmbed.push({ item, text });
		}
		if (toEmbed.length === 0) {
			return outcomes;
		}

		const startTime = Date.now();
		// One request for all texts. Throws on failure -> caller falls back to
		// the per-item path. (A single text still goes through the same batch fn.)
		const embeddings = await this.runtime.useModel(
			ModelType.TEXT_EMBEDDING_BATCH,
			{
				texts: toEmbed.map((t) => t.text),
			},
		);
		const durationMs = Date.now() - startTime;

		if (!Array.isArray(embeddings) || embeddings.length !== toEmbed.length) {
			throw new Error(
				`[embedding] batch returned ${
					Array.isArray(embeddings) ? embeddings.length : "non-array"
				} vectors for ${toEmbed.length} texts`,
			);
		}

		for (let i = 0; i < toEmbed.length; i++) {
			const { item } = toEmbed[i];
			const embedding = embeddings[i];
			const { memory } = item;
			if (memory.id) {
				await this.runtime.updateMemory({ id: memory.id, embedding });
				// Mark the in-flight memory so a fallback re-run of the per-item
				// path (generateEmbedding) skips it instead of double-emitting.
				memory.embedding = embedding;
				await this.runtime.log({
					entityId: this.runtime.agentId,
					roomId: memory.roomId || this.runtime.agentId,
					type: "embedding_event",
					body: {
						runId: item.runId,
						memoryId: memory.id,
						status: "completed",
						duration: durationMs,
						source: "embeddingService:batch",
					},
				});
				await this.runtime.emitEvent(EventType.EMBEDDING_GENERATION_COMPLETED, {
					runtime: this.runtime,
					memory: { ...memory, embedding },
					source: "embeddingService",
				});
			}
			outcomes.push({ item, success: true, retryCount: 0 });
		}
		this.runtime.logger.debug(
			{
				src: "plugin:basic-capabilities:service:embedding",
				agentId: this.runtime.agentId,
				count: toEmbed.length,
				durationMs,
			},
			"Generated batch embeddings",
		);
		return outcomes;
	}

	async stop(): Promise<void> {
		this.runtime.logger.info(
			{
				src: "plugin:basic-capabilities:service:embedding",
				agentId: this.runtime.agentId,
			},
			"Stopping embedding generation service",
		);

		if (this.isDisabled || !this.batchQueue) {
			this.runtime.logger.debug(
				{
					src: "plugin:basic-capabilities:service:embedding",
					agentId: this.runtime.agentId,
				},
				"Service is disabled, nothing to stop",
			);
			return;
		}

		const remaining = this.batchQueue.size;
		await this.batchQueue.dispose(this.runtime, { flushHighPriority: true });

		this.runtime.logger.info(
			{
				src: "plugin:basic-capabilities:service:embedding",
				agentId: this.runtime.agentId,
				remainingItems: remaining,
			},
			"Stopped",
		);

		this.batchQueue = null;
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
