import {
  type IAgentRuntime,
  type Memory,
  Service,
  EventType,
  ModelType,
  type EmbeddingGenerationPayload,
  logger,
} from '@elizaos/core';

interface EmbeddingQueueItem {
  memory: Memory;
  priority: 'high' | 'normal' | 'low';
  retryCount: number;
  maxRetries: number;
  addedAt: number;
}

/**
 * Service responsible for generating embeddings asynchronously
 * This service listens for EMBEDDING_GENERATION_REQUESTED events
 * and processes them in a queue to avoid blocking the main runtime
 */
export class EmbeddingGenerationService extends Service {
  static serviceType = 'embedding-generation';
  capabilityDescription = 'Handles asynchronous embedding generation for memories';

  private queue: EmbeddingQueueItem[] = [];
  private isProcessing = false;
  private processingInterval: NodeJS.Timeout | null = null;
  private maxQueueSize = 1000;
  private batchSize = 10; // Process up to 10 embeddings at a time
  private processingIntervalMs = 100; // Check queue every 100ms

  static async start(runtime: IAgentRuntime): Promise<Service> {
    logger.info('[EmbeddingService] Starting embedding generation service');
    const service = new EmbeddingGenerationService(runtime);
    await service.initialize();
    return service;
  }

  async initialize(): Promise<void> {
    logger.info('[EmbeddingService] Initializing embedding generation service');

    // Register event handlers
    this.runtime.registerEvent(
      EventType.EMBEDDING_GENERATION_REQUESTED,
      this.handleEmbeddingRequest.bind(this)
    );

    // Start the processing loop
    this.startProcessing();
  }

  private async handleEmbeddingRequest(payload: EmbeddingGenerationPayload): Promise<void> {
    const { memory, priority = 'normal', retryCount = 0, maxRetries = 3 } = payload;

    // Skip if memory already has embeddings
    if (memory.embedding) {
      logger.debug('[EmbeddingService] Memory already has embeddings, skipping');
      return;
    }

    // Check queue size
    if (this.queue.length >= this.maxQueueSize) {
      logger.warn('[EmbeddingService] Queue is full, dropping oldest normal priority items');
      // Remove oldest normal priority items to make room
      this.queue = this.queue.filter((item, index) => {
        return item.priority !== 'normal' || index > this.queue.length - this.maxQueueSize + 10;
      });
    }

    // Add to queue
    const queueItem: EmbeddingQueueItem = {
      memory,
      priority,
      retryCount,
      maxRetries,
      addedAt: Date.now(),
    };

    // Insert based on priority
    if (priority === 'high') {
      // Add to front of queue
      this.queue.unshift(queueItem);
    } else if (priority === 'low') {
      // Add to end of queue
      this.queue.push(queueItem);
    } else {
      // Normal priority - add after high priority items
      const highPriorityCount = this.queue.filter((item) => item.priority === 'high').length;
      this.queue.splice(highPriorityCount, 0, queueItem);
    }

    logger.debug(`[EmbeddingService] Added memory to queue. Queue size: ${this.queue.length}`);
  }

  private startProcessing(): void {
    if (this.processingInterval) {
      return;
    }

    this.processingInterval = setInterval(async () => {
      if (!this.isProcessing && this.queue.length > 0) {
        await this.processQueue();
      }
    }, this.processingIntervalMs);

    logger.info('[EmbeddingService] Started processing loop');
  }

  private async processQueue(): Promise<void> {
    if (this.isProcessing || this.queue.length === 0) {
      return;
    }

    this.isProcessing = true;

    try {
      // Process a batch of items
      const batch = this.queue.splice(0, Math.min(this.batchSize, this.queue.length));

      logger.debug(
        `[EmbeddingService] Processing batch of ${batch.length} items. Remaining in queue: ${this.queue.length}`
      );

      // Process items in parallel
      const promises = batch.map(async (item) => {
        try {
          await this.generateEmbedding(item);
        } catch (error) {
          logger.error(
            { error, memoryId: item.memory.id },
            '[EmbeddingService] Error processing item:'
          );

          // Retry if under max retries
          if (item.retryCount < item.maxRetries) {
            item.retryCount++;
            // Re-add to queue with lower priority
            this.queue.push(item);
            logger.debug(
              `[EmbeddingService] Re-queued item for retry (${item.retryCount}/${item.maxRetries})`
            );
          } else {
            // Emit failure event
            await this.runtime.emitEvent(EventType.EMBEDDING_GENERATION_FAILED, {
              runtime: this.runtime,
              memory: item.memory,
              error: error instanceof Error ? error.message : String(error),
              source: 'embeddingService',
            });
          }
        }
      });

      await Promise.all(promises);
    } finally {
      this.isProcessing = false;
    }
  }

  private async generateEmbedding(item: EmbeddingQueueItem): Promise<void> {
    const { memory } = item;

    if (!memory.content?.text) {
      logger.warn({ memoryId: memory.id }, '[EmbeddingService] Memory has no text content');
      return;
    }

    try {
      const startTime = Date.now();

      // Generate embedding
      const embedding = await this.runtime.useModel(ModelType.TEXT_EMBEDDING, {
        text: memory.content.text,
      });

      const duration = Date.now() - startTime;
      logger.debug(
        `[EmbeddingService] Generated embedding in ${duration}ms for memory ${memory.id}`
      );

      // Update memory with embedding
      if (memory.id) {
        await this.runtime.updateMemory({
          id: memory.id,
          embedding: embedding as number[],
        });

        // Emit completion event
        await this.runtime.emitEvent(EventType.EMBEDDING_GENERATION_COMPLETED, {
          runtime: this.runtime,
          memory: { ...memory, embedding },
          source: 'embeddingService',
        });
      }
    } catch (error) {
      logger.error(
        { error, memoryId: memory.id },
        '[EmbeddingService] Failed to generate embedding:'
      );
      throw error; // Re-throw to trigger retry logic
    }
  }

  async stop(): Promise<void> {
    logger.info('[EmbeddingService] Stopping embedding generation service');

    if (this.processingInterval) {
      clearInterval(this.processingInterval);
      this.processingInterval = null;
    }

    // Process remaining high priority items before shutdown
    const highPriorityItems = this.queue.filter((item) => item.priority === 'high');
    if (highPriorityItems.length > 0) {
      logger.info(
        `[EmbeddingService] Processing ${highPriorityItems.length} high priority items before shutdown`
      );
      for (const item of highPriorityItems) {
        try {
          await this.generateEmbedding(item);
        } catch (error) {
          logger.error({ error }, '[EmbeddingService] Error during shutdown processing:');
        }
      }
    }

    logger.info(`[EmbeddingService] Stopped. ${this.queue.length} items remaining in queue`);
  }

  // Public methods for monitoring
  getQueueSize(): number {
    return this.queue.length;
  }

  getQueueStats(): { high: number; normal: number; low: number; total: number } {
    const stats = {
      high: 0,
      normal: 0,
      low: 0,
      total: this.queue.length,
    };

    for (const item of this.queue) {
      stats[item.priority]++;
    }

    return stats;
  }

  clearQueue(): void {
    const size = this.queue.length;
    this.queue = [];
    logger.info(`[EmbeddingService] Cleared ${size} items from queue`);
  }
}

export default EmbeddingGenerationService;
