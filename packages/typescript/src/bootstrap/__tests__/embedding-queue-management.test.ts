import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EmbeddingGenerationService } from "../../services/embedding";
import type {
  EventPayload,
  IAgentRuntime,
  Memory,
  UUID,
} from "../../types/index.ts";
import { EventType } from "../../types/index.ts";

// Test interface for accessing private properties
interface EmbeddingQueueItem {
  memory: Memory;
  priority: "high" | "normal" | "low";
  retryCount: number;
  addedAt: number;
  runId?: string;
}

// Interface for accessing private properties in tests
interface TestableEmbeddingService {
  processingInterval: NodeJS.Timeout | null;
  queue: EmbeddingQueueItem[];
  maxQueueSize: number;
  processQueue(): Promise<void>;
}

// Factory function to create a properly typed mock runtime
function createMockRuntime(
  registeredHandlers: Map<string, (params: EventPayload) => Promise<void>>,
  emittedEvents: Array<{ event: string; payload: EventPayload }>,
): Partial<IAgentRuntime> {
  return {
    agentId: "test-agent" as UUID,
    registerEvent: vi.fn(
      (event: string, handler: (params: EventPayload) => Promise<void>) => {
        registeredHandlers.set(event, handler);
      },
    ),
    emitEvent: vi.fn(async (event: string, payload: EventPayload) => {
      emittedEvents.push({ event, payload });
    }),
    useModel: vi.fn().mockResolvedValue([0.1, 0.2, 0.3, 0.4, 0.5]),
    getModel: vi
      .fn()
      .mockReturnValue(vi.fn().mockResolvedValue([0.1, 0.2, 0.3, 0.4, 0.5])),
    updateMemory: vi.fn().mockResolvedValue(undefined),
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    // Add log method used by EmbeddingGenerationService
    log: vi.fn().mockResolvedValue(undefined),
  };
}

describe("EmbeddingGenerationService - Queue Management", () => {
  let service: EmbeddingGenerationService | null;
  let agentRuntime: IAgentRuntime;
  let registeredHandlers: Map<string, (params: EventPayload) => Promise<void>> =
    new Map();
  let emittedEvents: Array<{ event: string; payload: EventPayload }> = [];

  beforeEach(() => {
    emittedEvents = [];
    registeredHandlers = new Map();

    // Create mock runtime using factory function
    agentRuntime = createMockRuntime(
      registeredHandlers,
      emittedEvents,
    ) as IAgentRuntime;
  });

  afterEach(async () => {
    if (service) {
      // Stop the processing interval before cleanup
      const testService = service as TestableEmbeddingService;
      if (testService.processingInterval) {
        clearInterval(testService.processingInterval);
        testService.processingInterval = null;
      }
      await service.stop();
      service = null;
    }
  });

  describe("Queue Size Management", () => {
    it("should enforce maxQueueSize by removing low priority items first", async () => {
      service = (await EmbeddingGenerationService.start(
        agentRuntime,
      )) as EmbeddingGenerationService;
      const handler = registeredHandlers.get(
        EventType.EMBEDDING_GENERATION_REQUESTED,
      );
      expect(handler).toBeDefined();

      // Set a smaller queue size for testing
      (service as TestableEmbeddingService).maxQueueSize = 10;

      // Fill the queue with mixed priority items
      for (let i = 0; i < 10; i++) {
        const priority = i < 3 ? "high" : i < 7 ? "normal" : "low";
        if (handler) {
          await handler({
            memory: {
              id: `memory-${i}` as UUID,
              content: { text: `Test content ${i}` },
            },
            priority,
          });
        }
      }

      // Queue should be full
      expect(service.getQueueSize()).toBe(10);

      // Add another item when queue is full
      if (handler) {
        await handler({
          memory: {
            id: "new-memory" as UUID,
            content: { text: "New content" },
          },
          priority: "normal",
        });
      }

      // Queue should not exceed max size
      expect(service.getQueueSize()).toBeLessThanOrEqual(10);

      // Check that low priority items were removed first
      const stats = service.getQueueStats();
      expect(stats.high).toBe(3); // All high priority items should remain
    });

    it("should remove oldest items within same priority when making room", async () => {
      service = (await EmbeddingGenerationService.start(
        agentRuntime,
      )) as EmbeddingGenerationService;
      const handler = registeredHandlers.get(
        EventType.EMBEDDING_GENERATION_REQUESTED,
      );

      (service as TestableEmbeddingService).maxQueueSize = 5;

      // Add items with timestamps
      const timestamps: number[] = [];
      for (let i = 0; i < 5; i++) {
        const now = Date.now() + i * 100; // Stagger timestamps
        timestamps.push(now);

        // Mock Date.now for this iteration
        const originalDateNow = Date.now;
        Date.now = () => now;

        if (handler) {
          await handler({
            memory: {
              id: `memory-${i}` as UUID,
              content: { text: `Test content ${i}` },
            },
            priority: "normal",
          });
        }

        Date.now = originalDateNow;
      }

      // Queue should be full
      expect(service.getQueueSize()).toBe(5);

      // Add new item to trigger cleanup
      if (handler) {
        await handler({
          memory: {
            id: "new-memory" as UUID,
            content: { text: "New content" },
          },
          priority: "normal",
        });
      }

      // Queue should not exceed max size
      expect(service.getQueueSize()).toBeLessThanOrEqual(5);
    });

    it("should calculate removal percentage correctly", async () => {
      service = (await EmbeddingGenerationService.start(
        agentRuntime,
      )) as EmbeddingGenerationService;
      const handler = registeredHandlers.get(
        EventType.EMBEDDING_GENERATION_REQUESTED,
      );

      (service as TestableEmbeddingService).maxQueueSize = 100;

      // Fill the queue
      for (let i = 0; i < 100; i++) {
        if (handler) {
          await handler({
            memory: {
              id: `memory-${i}` as UUID,
              content: { text: `Test content ${i}` },
            },
            priority: "low",
          });
        }
      }

      expect(service.getQueueSize()).toBe(100);

      // Add item to trigger cleanup (should remove 10% = 10 items)
      if (handler) {
        await handler({
          memory: {
            id: "new-memory" as UUID,
            content: { text: "New content" },
          },
          priority: "normal",
        });
      }

      // Should have removed 10 items and added 1
      expect(service.getQueueSize()).toBe(91);
    });
  });

  describe("Priority-based Insertion", () => {
    it("should maintain correct queue order with mixed priorities", async () => {
      service = (await EmbeddingGenerationService.start(
        agentRuntime,
      )) as EmbeddingGenerationService;
      const handler = registeredHandlers.get(
        EventType.EMBEDDING_GENERATION_REQUESTED,
      );

      // Add items in random order
      if (handler) {
        await handler({
          memory: { id: "low-1" as UUID, content: { text: "Low 1" } },
          priority: "low",
        });
        await handler({
          memory: { id: "high-1" as UUID, content: { text: "High 1" } },
          priority: "high",
        });
        await handler({
          memory: { id: "normal-1" as UUID, content: { text: "Normal 1" } },
          priority: "normal",
        });
        await handler({
          memory: { id: "high-2" as UUID, content: { text: "High 2" } },
          priority: "high",
        });
        await handler({
          memory: { id: "low-2" as UUID, content: { text: "Low 2" } },
          priority: "low",
        });
      }

      const queue = (service as TestableEmbeddingService).queue;

      // Check order: high items first, then normal, then low
      expect(queue[0].memory.id).toBe("high-1" as UUID);
      expect(queue[1].memory.id).toBe("high-2" as UUID);
      expect(queue[2].memory.id).toBe("normal-1" as UUID);
      expect(queue[3].memory.id).toBe("low-1" as UUID);
      expect(queue[4].memory.id).toBe("low-2" as UUID);
    });

    it("should insert high priority items at correct position", async () => {
      service = (await EmbeddingGenerationService.start(
        agentRuntime,
      )) as EmbeddingGenerationService;
      const handler = registeredHandlers.get(
        EventType.EMBEDDING_GENERATION_REQUESTED,
      );

      // Add some normal and low priority items first
      if (handler) {
        await handler({
          memory: { id: "normal-1" as UUID, content: { text: "Normal 1" } },
          priority: "normal",
        });
        await handler({
          memory: { id: "low-1" as UUID, content: { text: "Low 1" } },
          priority: "low",
        });

        // Add high priority item
        await handler({
          memory: { id: "high-1" as UUID, content: { text: "High 1" } },
          priority: "high",
        });
      }

      const queue = (service as TestableEmbeddingService).queue;

      // High priority should be at the front
      expect(queue[0].memory.id).toBe("high-1" as UUID);
      expect(queue[1].memory.id).toBe("normal-1" as UUID);
      expect(queue[2].memory.id).toBe("low-1" as UUID);
    });

    it("should maintain FIFO order within same priority level", async () => {
      service = (await EmbeddingGenerationService.start(
        agentRuntime,
      )) as EmbeddingGenerationService;
      const handler = registeredHandlers.get(
        EventType.EMBEDDING_GENERATION_REQUESTED,
      );

      // Add multiple items of same priority
      for (let i = 0; i < 5; i++) {
        if (handler) {
          await handler({
            memory: {
              id: `normal-${i}` as UUID,
              content: { text: `Normal ${i}` },
            },
            priority: "normal",
          });
        }
      }

      const queue = (service as TestableEmbeddingService).queue;

      // Check FIFO order within normal priority
      for (let i = 0; i < 5; i++) {
        expect(queue[i].memory.id).toBe(`normal-${i}` as UUID);
      }
    });
  });

  describe("Retry Logic", () => {
    it("should re-insert failed items with same priority", async () => {
      service = (await EmbeddingGenerationService.start(
        agentRuntime,
      )) as EmbeddingGenerationService;
      const handler = registeredHandlers.get(
        EventType.EMBEDDING_GENERATION_REQUESTED,
      );

      // Stop automatic processing
      const testService = service as TestableEmbeddingService;
      if (testService.processingInterval) {
        clearInterval(testService.processingInterval);
        testService.processingInterval = null;
      }

      // Mock useModel to fail on first call
      let callCount = 0;
      agentRuntime.useModel = vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          throw new Error("Embedding generation failed");
        }
        return Promise.resolve([0.1, 0.2, 0.3, 0.4, 0.5]);
      });

      // Add high priority item
      if (handler) {
        await handler({
          memory: {
            id: "retry-memory" as UUID,
            content: { text: "Retry content" },
          },
          priority: "high",
          maxRetries: 3,
        });
      }

      // Manually trigger processing
      await (service as TestableEmbeddingService).processQueue();

      // Check that item was retried
      const queue = (service as TestableEmbeddingService).queue;
      const retriedItem = queue.find(
        (item) => item.memory.id === ("retry-memory" as UUID),
      );

      expect(retriedItem).toBeDefined();
      expect(retriedItem?.retryCount).toBe(1);
      expect(retriedItem?.priority).toBe("high"); // Should maintain priority
    });

    it("should respect maxRetries limit", async () => {
      service = (await EmbeddingGenerationService.start(
        agentRuntime,
      )) as EmbeddingGenerationService;
      const handler = registeredHandlers.get(
        EventType.EMBEDDING_GENERATION_REQUESTED,
      );

      // Stop automatic processing
      const testService = service as TestableEmbeddingService;
      if (testService.processingInterval) {
        clearInterval(testService.processingInterval);
        testService.processingInterval = null;
      }

      // Mock useModel to always fail
      agentRuntime.useModel = vi
        .fn()
        .mockRejectedValue(new Error("Persistent failure"));

      // Add item with low retry limit
      if (handler) {
        await handler({
          memory: {
            id: "fail-memory" as UUID,
            content: { text: "Fail content" },
          },
          priority: "normal",
          maxRetries: 2,
        });
      }

      // Manually process queue multiple times to trigger retries
      for (let i = 0; i <= 3; i++) {
        await (service as TestableEmbeddingService).processQueue();
      }

      // Check that failure event was emitted
      const failureEvent = emittedEvents.find(
        (e) => e.event === EventType.EMBEDDING_GENERATION_FAILED,
      );
      expect(failureEvent).toBeDefined();
      expect(failureEvent?.payload?.memory.id).toBe("fail-memory");
    });
  });

  describe("Queue Statistics", () => {
    it("should provide accurate queue statistics", async () => {
      service = (await EmbeddingGenerationService.start(
        agentRuntime,
      )) as EmbeddingGenerationService;
      const handler = registeredHandlers.get(
        EventType.EMBEDDING_GENERATION_REQUESTED,
      );

      // Add items with different priorities
      if (handler) {
        await handler({
          memory: { id: "high-1" as UUID, content: { text: "High 1" } },
          priority: "high",
        });
        await handler({
          memory: { id: "high-2" as UUID, content: { text: "High 2" } },
          priority: "high",
        });
        await handler({
          memory: { id: "normal-1" as UUID, content: { text: "Normal 1" } },
          priority: "normal",
        });
        await handler({
          memory: { id: "low-1" as UUID, content: { text: "Low 1" } },
          priority: "low",
        });
        await handler({
          memory: { id: "low-2" as UUID, content: { text: "Low 2" } },
          priority: "low",
        });
        await handler({
          memory: { id: "low-3" as UUID, content: { text: "Low 3" } },
          priority: "low",
        });
      }

      const stats = service.getQueueStats();

      expect(stats.total).toBe(6);
      expect(stats.high).toBe(2);
      expect(stats.normal).toBe(1);
      expect(stats.low).toBe(3);
    });

    it("should update statistics after processing", async () => {
      service = (await EmbeddingGenerationService.start(
        agentRuntime,
      )) as EmbeddingGenerationService;
      const handler = registeredHandlers.get(
        EventType.EMBEDDING_GENERATION_REQUESTED,
      );

      // Stop automatic processing
      const testService = service as TestableEmbeddingService;
      if (testService.processingInterval) {
        clearInterval(testService.processingInterval);
        testService.processingInterval = null;
      }

      // Add items
      for (let i = 0; i < 5; i++) {
        if (handler) {
          await handler({
            memory: {
              id: `memory-${i}` as UUID,
              content: { text: `Content ${i}` },
            },
            priority: "normal",
          });
        }
      }

      expect(service.getQueueSize()).toBe(5);

      // Manually trigger processing
      await (service as TestableEmbeddingService).processQueue();

      // Queue should be smaller after processing (or empty if batch size >= 5)
      expect(service.getQueueSize()).toBeLessThanOrEqual(5);
    });
  });

  describe("Edge Cases", () => {
    it("should handle empty queue gracefully", async () => {
      service = (await EmbeddingGenerationService.start(
        agentRuntime,
      )) as EmbeddingGenerationService;

      expect(service.getQueueSize()).toBe(0);

      const stats = service.getQueueStats();
      expect(stats.total).toBe(0);
      expect(stats.high).toBe(0);
      expect(stats.normal).toBe(0);
      expect(stats.low).toBe(0);
    });

    it("should handle clearQueue operation", async () => {
      service = (await EmbeddingGenerationService.start(
        agentRuntime,
      )) as EmbeddingGenerationService;
      const handler = registeredHandlers.get(
        EventType.EMBEDDING_GENERATION_REQUESTED,
      );

      // Add items
      for (let i = 0; i < 10; i++) {
        if (handler) {
          await handler({
            memory: {
              id: `memory-${i}` as UUID,
              content: { text: `Content ${i}` },
            },
            priority: "normal",
          });
        }
      }

      expect(service.getQueueSize()).toBe(10);

      // Clear the queue
      service.clearQueue();

      expect(service.getQueueSize()).toBe(0);
    });

    it("should handle very large queue efficiently", async () => {
      service = (await EmbeddingGenerationService.start(
        agentRuntime,
      )) as EmbeddingGenerationService;
      const handler = registeredHandlers.get(
        EventType.EMBEDDING_GENERATION_REQUESTED,
      );

      (service as TestableEmbeddingService).maxQueueSize = 10000;

      const startTime = Date.now();

      // Add many items
      const promises: Promise<void>[] = [];
      if (handler) {
        for (let i = 0; i < 1000; i++) {
          promises.push(
            handler({
              memory: {
                id: `memory-${i}` as UUID,
                content: { text: `Content ${i}` },
              },
              priority: i % 3 === 0 ? "high" : i % 3 === 1 ? "normal" : "low",
            }),
          );
        }
      }

      await Promise.all(promises);
      const elapsed = Date.now() - startTime;

      // Should handle 1000 items quickly (< 100ms)
      expect(elapsed).toBeLessThan(100);
      expect(service.getQueueSize()).toBe(1000);
    });
  });
});
