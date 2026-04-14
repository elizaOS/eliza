import type { EmbeddingGenerationPayload } from "../types/events";
import { EventType } from "../types/events";
import type { Memory } from "../types/memory";
import { ModelType } from "../types/model";
import type { IAgentRuntime } from "../types/runtime";
import { Service } from "../types/service";
import { BatchQueue } from "../utils/batch-queue";

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
		this.batchQueue = new BatchQueue<EmbeddingQueueItem>({
			name: EmbeddingGenerationService.EMBEDDING_DRAIN_TASK,
			taskDescription: "Embedding generation drain",
			batchSize: 10,
			drainIntervalMs: 100,
			getPriority: (item) => item.priority,
			maxParallel: 10,
			maxRetriesAfterFailure: 3,
			process: (item) => this.generateEmbedding(item),
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
		if (!memoryContent?.text) {
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
