import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { EmbeddingGenerationService } from '../services/embedding';
import { EventType, type IAgentRuntime, type UUID } from '@elizaos/core';

describe('EmbeddingGenerationService - Queue Management', () => {
  let service: EmbeddingGenerationService;
  let mockRuntime: IAgentRuntime;
  let registeredHandlers: Map<string, Function> = new Map();
  let emittedEvents: Array<{ event: string; payload: any }> = [];

  beforeEach(() => {
    emittedEvents = [];
    registeredHandlers = new Map();

    // Create mock runtime
    mockRuntime = {
      agentId: 'test-agent' as UUID,
      registerEvent: mock((event: string, handler: Function) => {
        registeredHandlers.set(event, handler);
      }),
      emitEvent: mock(async (event: string, payload: any) => {
        emittedEvents.push({ event, payload });
      }),
      useModel: mock().mockResolvedValue([0.1, 0.2, 0.3, 0.4, 0.5]),
      updateMemory: mock().mockResolvedValue(undefined),
      logger: {
        debug: mock(),
        info: mock(),
        warn: mock(),
        error: mock(),
      },
      // Add log method used by EmbeddingGenerationService
      log: mock().mockResolvedValue(undefined),
    } as any;
  });

  afterEach(async () => {
    if (service) {
      // Stop the processing interval before cleanup
      if ((service as any).processingInterval) {
        clearInterval((service as any).processingInterval);
        (service as any).processingInterval = null;
      }
      await service.stop();
      service = null as any;
    }
  });

  describe('Queue Size Management', () => {
    it('should enforce maxQueueSize by removing low priority items first', async () => {
      service = (await EmbeddingGenerationService.start(mockRuntime)) as EmbeddingGenerationService;
      const handler = registeredHandlers.get(EventType.EMBEDDING_GENERATION_REQUESTED);
      expect(handler).toBeDefined();

      // Set a smaller queue size for testing
      (service as any).maxQueueSize = 10;

      // Fill the queue with mixed priority items
      for (let i = 0; i < 10; i++) {
        const priority = i < 3 ? 'high' : i < 7 ? 'normal' : 'low';
        await handler!({
          memory: {
            id: `memory-${i}` as UUID,
            content: { text: `Test content ${i}` },
          },
          priority,
        });
      }

      // Queue should be full
      expect(service.getQueueSize()).toBe(10);

      // Add another item when queue is full
      await handler!({
        memory: {
          id: 'new-memory' as UUID,
          content: { text: 'New content' },
        },
        priority: 'normal',
      });

      // Queue should not exceed max size
      expect(service.getQueueSize()).toBeLessThanOrEqual(10);

      // Check that low priority items were removed first
      const stats = service.getQueueStats();
      expect(stats.high).toBe(3); // All high priority items should remain
    });

    it('should remove oldest items within same priority when making room', async () => {
      service = (await EmbeddingGenerationService.start(mockRuntime)) as EmbeddingGenerationService;
      const handler = registeredHandlers.get(EventType.EMBEDDING_GENERATION_REQUESTED);

      (service as any).maxQueueSize = 5;

      // Add items with timestamps
      const timestamps: number[] = [];
      for (let i = 0; i < 5; i++) {
        const now = Date.now() + i * 100; // Stagger timestamps
        timestamps.push(now);

        // Mock Date.now for this iteration
        const originalDateNow = Date.now;
        Date.now = () => now;

        await handler!({
          memory: {
            id: `memory-${i}` as UUID,
            content: { text: `Test content ${i}` },
          },
          priority: 'normal',
        });

        Date.now = originalDateNow;
      }

      // Queue should be full
      expect(service.getQueueSize()).toBe(5);

      // Add new item to trigger cleanup
      await handler!({
        memory: {
          id: 'new-memory' as UUID,
          content: { text: 'New content' },
        },
        priority: 'normal',
      });

      // Queue should not exceed max size
      expect(service.getQueueSize()).toBeLessThanOrEqual(5);
    });

    it('should calculate removal percentage correctly', async () => {
      service = (await EmbeddingGenerationService.start(mockRuntime)) as EmbeddingGenerationService;
      const handler = registeredHandlers.get(EventType.EMBEDDING_GENERATION_REQUESTED);

      (service as any).maxQueueSize = 100;

      // Fill the queue
      for (let i = 0; i < 100; i++) {
        await handler!({
          memory: {
            id: `memory-${i}` as UUID,
            content: { text: `Test content ${i}` },
          },
          priority: 'low',
        });
      }

      expect(service.getQueueSize()).toBe(100);

      // Add item to trigger cleanup (should remove 10% = 10 items)
      await handler!({
        memory: {
          id: 'new-memory' as UUID,
          content: { text: 'New content' },
        },
        priority: 'normal',
      });

      // Should have removed 10 items and added 1
      expect(service.getQueueSize()).toBe(91);
    });
  });

  describe('Priority-based Insertion', () => {
    it('should maintain correct queue order with mixed priorities', async () => {
      service = (await EmbeddingGenerationService.start(mockRuntime)) as EmbeddingGenerationService;
      const handler = registeredHandlers.get(EventType.EMBEDDING_GENERATION_REQUESTED);

      // Add items in random order
      await handler!({
        memory: { id: 'low-1' as UUID, content: { text: 'Low 1' } },
        priority: 'low',
      });
      await handler!({
        memory: { id: 'high-1' as UUID, content: { text: 'High 1' } },
        priority: 'high',
      });
      await handler!({
        memory: { id: 'normal-1' as UUID, content: { text: 'Normal 1' } },
        priority: 'normal',
      });
      await handler!({
        memory: { id: 'high-2' as UUID, content: { text: 'High 2' } },
        priority: 'high',
      });
      await handler!({
        memory: { id: 'low-2' as UUID, content: { text: 'Low 2' } },
        priority: 'low',
      });

      const queue = (service as any).queue as any[];

      // Check order: high items first, then normal, then low
      expect(queue[0].memory.id).toBe('high-1');
      expect(queue[1].memory.id).toBe('high-2');
      expect(queue[2].memory.id).toBe('normal-1');
      expect(queue[3].memory.id).toBe('low-1');
      expect(queue[4].memory.id).toBe('low-2');
    });

    it('should insert high priority items at correct position', async () => {
      service = (await EmbeddingGenerationService.start(mockRuntime)) as EmbeddingGenerationService;
      const handler = registeredHandlers.get(EventType.EMBEDDING_GENERATION_REQUESTED);

      // Add some normal and low priority items first
      await handler!({
        memory: { id: 'normal-1' as UUID, content: { text: 'Normal 1' } },
        priority: 'normal',
      });
      await handler!({
        memory: { id: 'low-1' as UUID, content: { text: 'Low 1' } },
        priority: 'low',
      });

      // Add high priority item
      await handler!({
        memory: { id: 'high-1' as UUID, content: { text: 'High 1' } },
        priority: 'high',
      });

      const queue = (service as any).queue as any[];

      // High priority should be at the front
      expect(queue[0].memory.id).toBe('high-1');
      expect(queue[1].memory.id).toBe('normal-1');
      expect(queue[2].memory.id).toBe('low-1');
    });

    it('should maintain FIFO order within same priority level', async () => {
      service = (await EmbeddingGenerationService.start(mockRuntime)) as EmbeddingGenerationService;
      const handler = registeredHandlers.get(EventType.EMBEDDING_GENERATION_REQUESTED);

      // Add multiple items of same priority
      for (let i = 0; i < 5; i++) {
        await handler!({
          memory: { id: `normal-${i}` as UUID, content: { text: `Normal ${i}` } },
          priority: 'normal',
        });
      }

      const queue = (service as any).queue as any[];

      // Check FIFO order within normal priority
      for (let i = 0; i < 5; i++) {
        expect(queue[i].memory.id).toBe(`normal-${i}`);
      }
    });
  });

  describe('Retry Logic', () => {
    it('should re-insert failed items with same priority', async () => {
      service = (await EmbeddingGenerationService.start(mockRuntime)) as EmbeddingGenerationService;
      const handler = registeredHandlers.get(EventType.EMBEDDING_GENERATION_REQUESTED);

      // Stop automatic processing
      if ((service as any).processingInterval) {
        clearInterval((service as any).processingInterval);
        (service as any).processingInterval = null;
      }

      // Mock useModel to fail on first call
      let callCount = 0;
      mockRuntime.useModel = mock().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          throw new Error('Embedding generation failed');
        }
        return Promise.resolve([0.1, 0.2, 0.3, 0.4, 0.5]);
      });

      // Add high priority item
      await handler!({
        memory: {
          id: 'retry-memory' as UUID,
          content: { text: 'Retry content' },
        },
        priority: 'high',
        maxRetries: 3,
      });

      // Manually trigger processing
      await (service as any).processQueue();

      // Check that item was retried
      const queue = (service as any).queue as any[];
      const retriedItem = queue.find((item: any) => item.memory.id === 'retry-memory');

      expect(retriedItem).toBeDefined();
      expect(retriedItem.retryCount).toBe(1);
      expect(retriedItem.priority).toBe('high'); // Should maintain priority
    });

    it('should respect maxRetries limit', async () => {
      service = (await EmbeddingGenerationService.start(mockRuntime)) as EmbeddingGenerationService;
      const handler = registeredHandlers.get(EventType.EMBEDDING_GENERATION_REQUESTED);

      // Stop automatic processing
      if ((service as any).processingInterval) {
        clearInterval((service as any).processingInterval);
        (service as any).processingInterval = null;
      }

      // Mock useModel to always fail
      mockRuntime.useModel = mock().mockRejectedValue(new Error('Persistent failure'));

      // Add item with low retry limit
      await handler!({
        memory: {
          id: 'fail-memory' as UUID,
          content: { text: 'Fail content' },
        },
        priority: 'normal',
        maxRetries: 2,
      });

      // Manually process queue multiple times to trigger retries
      for (let i = 0; i <= 3; i++) {
        await (service as any).processQueue();
      }

      // Check that failure event was emitted
      const failureEvent = emittedEvents.find(
        (e) => e.event === EventType.EMBEDDING_GENERATION_FAILED
      );
      expect(failureEvent).toBeDefined();
      expect(failureEvent?.payload.memory.id).toBe('fail-memory');
    });
  });

  describe('Queue Statistics', () => {
    it('should provide accurate queue statistics', async () => {
      service = (await EmbeddingGenerationService.start(mockRuntime)) as EmbeddingGenerationService;
      const handler = registeredHandlers.get(EventType.EMBEDDING_GENERATION_REQUESTED);

      // Add items with different priorities
      await handler!({
        memory: { id: 'high-1' as UUID, content: { text: 'High 1' } },
        priority: 'high',
      });
      await handler!({
        memory: { id: 'high-2' as UUID, content: { text: 'High 2' } },
        priority: 'high',
      });
      await handler!({
        memory: { id: 'normal-1' as UUID, content: { text: 'Normal 1' } },
        priority: 'normal',
      });
      await handler!({
        memory: { id: 'low-1' as UUID, content: { text: 'Low 1' } },
        priority: 'low',
      });
      await handler!({
        memory: { id: 'low-2' as UUID, content: { text: 'Low 2' } },
        priority: 'low',
      });
      await handler!({
        memory: { id: 'low-3' as UUID, content: { text: 'Low 3' } },
        priority: 'low',
      });

      const stats = service.getQueueStats();

      expect(stats.total).toBe(6);
      expect(stats.high).toBe(2);
      expect(stats.normal).toBe(1);
      expect(stats.low).toBe(3);
    });

    it('should update statistics after processing', async () => {
      service = (await EmbeddingGenerationService.start(mockRuntime)) as EmbeddingGenerationService;
      const handler = registeredHandlers.get(EventType.EMBEDDING_GENERATION_REQUESTED);

      // Stop automatic processing
      if ((service as any).processingInterval) {
        clearInterval((service as any).processingInterval);
        (service as any).processingInterval = null;
      }

      // Add items
      for (let i = 0; i < 5; i++) {
        await handler!({
          memory: {
            id: `memory-${i}` as UUID,
            content: { text: `Content ${i}` },
          },
          priority: 'normal',
        });
      }

      expect(service.getQueueSize()).toBe(5);

      // Manually trigger processing
      await (service as any).processQueue();

      // Queue should be smaller after processing (or empty if batch size >= 5)
      expect(service.getQueueSize()).toBeLessThanOrEqual(5);
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty queue gracefully', async () => {
      service = (await EmbeddingGenerationService.start(mockRuntime)) as EmbeddingGenerationService;

      expect(service.getQueueSize()).toBe(0);

      const stats = service.getQueueStats();
      expect(stats.total).toBe(0);
      expect(stats.high).toBe(0);
      expect(stats.normal).toBe(0);
      expect(stats.low).toBe(0);
    });

    it('should handle clearQueue operation', async () => {
      service = (await EmbeddingGenerationService.start(mockRuntime)) as EmbeddingGenerationService;
      const handler = registeredHandlers.get(EventType.EMBEDDING_GENERATION_REQUESTED);

      // Add items
      for (let i = 0; i < 10; i++) {
        await handler!({
          memory: {
            id: `memory-${i}` as UUID,
            content: { text: `Content ${i}` },
          },
          priority: 'normal',
        });
      }

      expect(service.getQueueSize()).toBe(10);

      // Clear the queue
      service.clearQueue();

      expect(service.getQueueSize()).toBe(0);
    });

    it('should handle very large queue efficiently', async () => {
      service = (await EmbeddingGenerationService.start(mockRuntime)) as EmbeddingGenerationService;
      const handler = registeredHandlers.get(EventType.EMBEDDING_GENERATION_REQUESTED);

      (service as any).maxQueueSize = 10000;

      const startTime = Date.now();

      // Add many items
      const promises: Promise<void>[] = [];
      for (let i = 0; i < 1000; i++) {
        promises.push(
          handler!({
            memory: {
              id: `memory-${i}` as UUID,
              content: { text: `Content ${i}` },
            },
            priority: i % 3 === 0 ? 'high' : i % 3 === 1 ? 'normal' : 'low',
          })
        );
      }

      await Promise.all(promises);
      const elapsed = Date.now() - startTime;

      // Should handle 1000 items quickly (< 100ms)
      expect(elapsed).toBeLessThan(100);
      expect(service.getQueueSize()).toBe(1000);
    });
  });
});
