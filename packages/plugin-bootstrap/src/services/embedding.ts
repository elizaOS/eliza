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
  runId?: string;
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
  private isDisabled = false; // Flag to indicate if service is disabled due to missing embedding model

  static async start(runtime: IAgentRuntime): Promise<Service> {
    logger.info('[EmbeddingService] Starting embedding generation service');

    // Check if TEXT_EMBEDDING model is registered
    const embeddingModel = runtime.getModel(ModelType.TEXT_EMBEDDING);
    if (!embeddingModel) {
      logger.warn(
        '[EmbeddingService] No TEXT_EMBEDDING model registered. Embedding service will not be initialized.'
      );
      // Return a no-op service that does nothing
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
      logger.debug('[EmbeddingService] Service is disabled, skipping initialization');
      return;
    }

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
    // Skip if service is disabled
    if (this.isDisabled) {
      logger.debug('[EmbeddingService] Service is disabled, skipping embedding request');
      return;
    }

    const { memory, priority = 'normal', retryCount = 0, maxRetries = 3, runId } = payload;

    // Skip if memory already has embeddings
    if (memory.embedding) {
      logger.debug('[EmbeddingService] Memory already has embeddings, skipping');
      return;
    }

    // Check queue size and make room if needed
    if (this.queue.length >= this.maxQueueSize) {
      logger.warn(
        `[EmbeddingService] Queue is full (${this.queue.length}/${this.maxQueueSize}), making room`
      );
      this.makeRoomInQueue();
    }

    // Add to queue
    const queueItem: EmbeddingQueueItem = {
      memory,
      priority,
      retryCount,
      maxRetries,
      addedAt: Date.now(),
      runId,
    };

    // Insert based on priority
    this.insertItemByPriority(queueItem);

    logger.debug(`[EmbeddingService] Added memory to queue. Queue size: ${this.queue.length}`);
  }

  /**
   * Make room in the queue by removing items based on priority and age
   * Removes 10% of the queue (minimum 1, maximum 10 items)
   */
  private makeRoomInQueue(): void {
    // Remove 10% of queue, but at least 1 and at most 10 items
    const tenPercent = Math.floor(this.maxQueueSize * 0.1);
    const itemsToRemove = Math.min(10, Math.max(1, tenPercent));

    // Create array with items and their original indices
    const itemsWithIndex = this.queue.map((item, index) => ({ item, originalIndex: index }));

    // Sort by priority (low first for removal) and age (oldest first)
    itemsWithIndex.sort((a, b) => {
      // Priority order for removal: low > normal > high
      const priorityOrder = { low: 0, normal: 1, high: 2 };
      const priorityDiff = priorityOrder[a.item.priority] - priorityOrder[b.item.priority];

      if (priorityDiff !== 0) return priorityDiff;

      // Within same priority, remove older items first
      return a.item.addedAt - b.item.addedAt;
    });

    // Get the original indices of items to remove (first N items after sorting)
    const indicesToRemove = new Set(
      itemsWithIndex
        .slice(0, Math.min(itemsToRemove, itemsWithIndex.length))
        .map(({ originalIndex }) => originalIndex)
    );

    // Keep items that are not in the removal set
    const newQueue = this.queue.filter((_, index) => !indicesToRemove.has(index));
    const removedCount = this.queue.length - newQueue.length;

    this.queue = newQueue;

    logger.info(
      `[EmbeddingService] Removed ${removedCount} items from queue. New size: ${this.queue.length}`
    );
  }

  /**
   * Insert an item into the queue based on its priority
   * High priority items go to the front, normal in the middle, low at the end
   */
  private insertItemByPriority(queueItem: EmbeddingQueueItem): void {
    if (queueItem.priority === 'high') {
      // Find the position after the last high priority item
      let insertIndex = 0;
      for (let i = 0; i < this.queue.length; i++) {
        if (this.queue[i].priority !== 'high') break;
        insertIndex = i + 1;
      }
      this.queue.splice(insertIndex, 0, queueItem);
    } else if (queueItem.priority === 'low') {
      // Add to end of queue
      this.queue.push(queueItem);
    } else {
      // Normal priority - add after high priority items but before low priority items
      let insertIndex = 0;

      // First, skip all high priority items
      for (let i = 0; i < this.queue.length; i++) {
        if (this.queue[i].priority !== 'high') {
          insertIndex = i;
          break;
        }
        insertIndex = i + 1;
      }

      // Then find where low priority items start
      for (let i = insertIndex; i < this.queue.length; i++) {
        if (this.queue[i].priority === 'low') {
          insertIndex = i;
          break;
        }
        insertIndex = i + 1;
      }

      this.queue.splice(insertIndex, 0, queueItem);
    }
  }

  private startProcessing(): void {
    if (this.isDisabled) {
      logger.debug('[EmbeddingService] Service is disabled, not starting processing loop');
      return;
    }

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
            // Re-add to queue with same priority using proper insertion
            this.insertItemByPriority(item);
            logger.debug(
              `[EmbeddingService] Re-queued item for retry (${item.retryCount}/${item.maxRetries})`
            );
          } else {
            // Log embedding failure
            await this.runtime.log({
              entityId: this.runtime.agentId,
              roomId: item.memory.roomId || this.runtime.agentId,
              type: 'embedding_event',
              body: {
                runId: item.runId,
                memoryId: item.memory.id,
                status: 'failed',
                error: error instanceof Error ? error.message : String(error),
                source: 'embeddingService',
              },
            });

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

        // Log embedding completion
        await this.runtime.log({
          entityId: this.runtime.agentId,
          roomId: memory.roomId || this.runtime.agentId,
          type: 'embedding_event',
          body: {
            runId: item.runId,
            memoryId: memory.id,
            status: 'completed',
            duration,
            source: 'embeddingService',
          },
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

    if (this.isDisabled) {
      logger.debug('[EmbeddingService] Service is disabled, nothing to stop');
      return;
    }

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
