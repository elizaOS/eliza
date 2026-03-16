import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EmbeddingGenerationService } from "../../services/embedding.ts";
import type {
  EventPayload,
  IAgentRuntime,
  Memory,
  UUID,
} from "../../types/index.ts";
import { EventType, ModelType } from "../../types/index.ts";
import { cleanupTestRuntime, createTestRuntime } from "./test-utils.ts";

describe("EmbeddingGenerationService", () => {
  let service: EmbeddingGenerationService;
  let runtime: IAgentRuntime;
  let registeredEventHandlers: Map<
    string,
    (params: EventPayload) => Promise<void>
  >;

  beforeEach(async () => {
    // Track registered event handlers
    registeredEventHandlers = new Map();

    runtime = await createTestRuntime();

    // Mock getModel to return a valid model handler (so service isn't disabled)
    vi.spyOn(runtime, "getModel").mockReturnValue(async () => [0.1, 0.2, 0.3]);

    // Spy on runtime methods
    vi.spyOn(runtime, "registerEvent").mockImplementation(
      (eventType: string, handler: (params: EventPayload) => Promise<void>) => {
        registeredEventHandlers.set(eventType, handler);
      },
    );
    vi.spyOn(runtime, "useModel").mockImplementation(
      async (modelType: string) => {
        if (modelType === ModelType.TEXT_EMBEDDING) {
          // Simulate embedding generation with a small delay
          return new Promise((resolve) => {
            setTimeout(() => resolve([0.1, 0.2, 0.3, 0.4, 0.5]), 10);
          });
        }
        return "mock response";
      },
    );
    vi.spyOn(runtime, "updateMemory").mockResolvedValue(true);
    vi.spyOn(runtime, "emitEvent").mockResolvedValue(undefined);

    // Suppress logger output during tests
    vi.spyOn(runtime.logger, "info").mockImplementation(() => {});
    vi.spyOn(runtime.logger, "debug").mockImplementation(() => {});
    vi.spyOn(runtime.logger, "warn").mockImplementation(() => {});
    vi.spyOn(runtime.logger, "error").mockImplementation(() => {});
  });

  afterEach(async () => {
    if (service) {
      await service.stop();
    }
    if (runtime) {
      await cleanupTestRuntime(runtime);
    }
  });

  describe("Service Initialization", () => {
    it("should start the service successfully", async () => {
      service = (await EmbeddingGenerationService.start(
        runtime,
      )) as EmbeddingGenerationService;

      expect(service).toBeDefined();
      expect(service.capabilityDescription).toBe(
        "Handles asynchronous embedding generation for memories",
      );
      expect(runtime.registerEvent).toHaveBeenCalledWith(
        EventType.EMBEDDING_GENERATION_REQUESTED,
        expect.any(Function),
      );
    });

    it("should register the event handler for EMBEDDING_GENERATION_REQUESTED", async () => {
      service = (await EmbeddingGenerationService.start(
        runtime,
      )) as EmbeddingGenerationService;

      expect(
        registeredEventHandlers.has(EventType.EMBEDDING_GENERATION_REQUESTED),
      ).toBe(true);
    });

    it("should return a disabled service when no TEXT_EMBEDDING model is available", async () => {
      // Override getModel to return undefined for TEXT_EMBEDDING
      runtime.getModel = vi.fn((_modelType: string) => {
        return undefined;
      });

      service = (await EmbeddingGenerationService.start(
        runtime,
      )) as EmbeddingGenerationService;

      expect(service).toBeDefined();

      // Service should not register event handlers when disabled
      expect(
        registeredEventHandlers.has(EventType.EMBEDDING_GENERATION_REQUESTED),
      ).toBe(false);

      // Queue should remain empty
      expect(service.getQueueSize()).toBe(0);

      // Verify getModel was called to check for TEXT_EMBEDDING
      expect(runtime.getModel).toHaveBeenCalledWith(ModelType.TEXT_EMBEDDING);
    });
  });

  describe("Queue Management", () => {
    it("should add memories to queue when event is received", async () => {
      service = (await EmbeddingGenerationService.start(
        runtime,
      )) as EmbeddingGenerationService;

      const memory: Memory = {
        id: "test-memory-id" as UUID,
        entityId: "test-entity" as UUID,
        agentId: "test-agent" as UUID,
        roomId: "test-room" as UUID,
        content: { text: "Test memory content" },
        createdAt: Date.now(),
      };

      const handler = registeredEventHandlers.get(
        EventType.EMBEDDING_GENERATION_REQUESTED,
      );
      if (handler) {
        await handler({
          runtime: runtime,
          memory,
          priority: "normal",
          source: "test",
        });
      }

      expect(service.getQueueSize()).toBe(1);
    });

    it("should prioritize high priority items", async () => {
      service = (await EmbeddingGenerationService.start(
        runtime,
      )) as EmbeddingGenerationService;
      const handler = registeredEventHandlers.get(
        EventType.EMBEDDING_GENERATION_REQUESTED,
      );

      // Add items with different priorities
      const normalMemory: Memory = {
        id: "normal-memory" as UUID,
        entityId: "test-entity" as UUID,
        agentId: "test-agent" as UUID,
        roomId: "test-room" as UUID,
        content: { text: "Normal priority" },
        createdAt: Date.now(),
      };

      const highMemory: Memory = {
        id: "high-memory" as UUID,
        entityId: "test-entity" as UUID,
        agentId: "test-agent" as UUID,
        roomId: "test-room" as UUID,
        content: { text: "High priority" },
        createdAt: Date.now(),
      };

      const lowMemory: Memory = {
        id: "low-memory" as UUID,
        entityId: "test-entity" as UUID,
        agentId: "test-agent" as UUID,
        roomId: "test-room" as UUID,
        content: { text: "Low priority" },
        createdAt: Date.now(),
      };

      if (handler) {
        await handler({
          runtime: runtime,
          memory: normalMemory,
          priority: "normal",
          source: "test",
        });
      }
      if (handler) {
        await handler({
          runtime: runtime,
          memory: lowMemory,
          priority: "low",
          source: "test",
        });
      }
      if (handler) {
        await handler({
          runtime: runtime,
          memory: highMemory,
          priority: "high",
          source: "test",
        });
      }

      const stats = service.getQueueStats();
      expect(stats.total).toBe(3);
      expect(stats.high).toBe(1);
      expect(stats.normal).toBe(1);
      expect(stats.low).toBe(1);
    });

    it("should skip memories that already have embeddings", async () => {
      service = (await EmbeddingGenerationService.start(
        runtime,
      )) as EmbeddingGenerationService;
      const handler = registeredEventHandlers.get(
        EventType.EMBEDDING_GENERATION_REQUESTED,
      );

      const memoryWithEmbedding: Memory = {
        id: "memory-with-embedding" as UUID,
        entityId: "test-entity" as UUID,
        agentId: "test-agent" as UUID,
        roomId: "test-room" as UUID,
        content: { text: "Already has embedding" },
        embedding: [0.1, 0.2, 0.3],
        createdAt: Date.now(),
      };

      if (handler) {
        await handler({
          runtime: runtime,
          memory: memoryWithEmbedding,
          priority: "normal",
          source: "test",
        });
      }

      expect(service.getQueueSize()).toBe(0);
    });

    it("should clear the queue when requested", async () => {
      service = (await EmbeddingGenerationService.start(
        runtime,
      )) as EmbeddingGenerationService;
      const handler = registeredEventHandlers.get(
        EventType.EMBEDDING_GENERATION_REQUESTED,
      );

      const memory: Memory = {
        id: "test-memory" as UUID,
        entityId: "test-entity" as UUID,
        agentId: "test-agent" as UUID,
        roomId: "test-room" as UUID,
        content: { text: "Test content" },
        createdAt: Date.now(),
      };

      if (handler) {
        await handler({
          runtime: runtime,
          memory,
          priority: "normal",
          source: "test",
        });
      }
      expect(service.getQueueSize()).toBe(1);

      service.clearQueue();
      expect(service.getQueueSize()).toBe(0);
    });
  });

  describe("Embedding Generation", () => {
    it("should generate embeddings and update memory", async () => {
      service = (await EmbeddingGenerationService.start(
        runtime,
      )) as EmbeddingGenerationService;
      const handler = registeredEventHandlers.get(
        EventType.EMBEDDING_GENERATION_REQUESTED,
      );

      const memory: Memory = {
        id: "test-memory" as UUID,
        entityId: "test-entity" as UUID,
        agentId: "test-agent" as UUID,
        roomId: "test-room" as UUID,
        content: { text: "Generate embedding for this" },
        createdAt: Date.now(),
      };

      if (handler) {
        await handler({
          runtime: runtime,
          memory,
          priority: "high",
          source: "test",
        });
      }

      // Wait for processing to complete (queue processes every 100ms + embedding takes 10ms)
      await new Promise((resolve) => setTimeout(resolve, 500));

      expect(runtime.useModel).toHaveBeenCalledWith(ModelType.TEXT_EMBEDDING, {
        text: "Generate embedding for this",
      });
      expect(runtime.updateMemory).toHaveBeenCalledWith({
        id: "test-memory",
        embedding: [0.1, 0.2, 0.3, 0.4, 0.5],
      });
      expect(runtime.emitEvent).toHaveBeenCalledWith(
        EventType.EMBEDDING_GENERATION_COMPLETED,
        expect.objectContaining({
          runtime: runtime,
          memory: expect.objectContaining({
            id: "test-memory",
            embedding: [0.1, 0.2, 0.3, 0.4, 0.5],
          }),
          source: "embeddingService",
        }),
      );
    });

    it("should skip memories without text content", async () => {
      service = (await EmbeddingGenerationService.start(
        runtime,
      )) as EmbeddingGenerationService;
      const handler = registeredEventHandlers.get(
        EventType.EMBEDDING_GENERATION_REQUESTED,
      );

      const memoryWithoutText: Memory = {
        id: "no-text-memory" as UUID,
        entityId: "test-entity" as UUID,
        agentId: "test-agent" as UUID,
        roomId: "test-room" as UUID,
        content: {},
        createdAt: Date.now(),
      };

      if (handler) {
        await handler({
          runtime: runtime,
          memory: memoryWithoutText,
          priority: "normal",
          source: "test",
        });
      }

      // Wait a bit to ensure processing would have happened
      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(runtime.useModel).not.toHaveBeenCalled();
      expect(runtime.updateMemory).not.toHaveBeenCalled();
    });
  });

  describe("Error Handling and Retry", () => {
    it("should retry on failure up to max retries", async () => {
      let callCount = 0;
      runtime.useModel = vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount <= 2) {
          return Promise.reject(new Error("Embedding generation failed"));
        }
        return Promise.resolve([0.1, 0.2, 0.3, 0.4, 0.5]);
      });

      service = (await EmbeddingGenerationService.start(
        runtime,
      )) as EmbeddingGenerationService;
      const handler = registeredEventHandlers.get(
        EventType.EMBEDDING_GENERATION_REQUESTED,
      );

      const memory: Memory = {
        id: "retry-memory" as UUID,
        entityId: "test-entity" as UUID,
        agentId: "test-agent" as UUID,
        roomId: "test-room" as UUID,
        content: { text: "Retry this embedding" },
        createdAt: Date.now(),
      };

      if (handler) {
        await handler({
          runtime: runtime,
          memory,
          priority: "normal",
          source: "test",
          maxRetries: 3,
        });
      }

      // Wait for retries to complete
      await new Promise((resolve) => setTimeout(resolve, 500));

      expect(callCount).toBe(3); // Failed twice, succeeded on third try
      expect(runtime.updateMemory).toHaveBeenCalled();
    });

    it("should emit failure event after max retries exceeded", async () => {
      runtime.useModel = vi
        .fn()
        .mockRejectedValue(new Error("Persistent failure"));

      service = (await EmbeddingGenerationService.start(
        runtime,
      )) as EmbeddingGenerationService;
      const handler = registeredEventHandlers.get(
        EventType.EMBEDDING_GENERATION_REQUESTED,
      );

      const memory: Memory = {
        id: "fail-memory" as UUID,
        entityId: "test-entity" as UUID,
        agentId: "test-agent" as UUID,
        roomId: "test-room" as UUID,
        content: { text: "This will fail" },
        createdAt: Date.now(),
      };

      if (handler) {
        await handler({
          runtime: runtime,
          memory,
          priority: "normal",
          source: "test",
          maxRetries: 2,
        });
      }

      // Wait for retries to exhaust
      await new Promise((resolve) => setTimeout(resolve, 500));

      expect(runtime.emitEvent).toHaveBeenCalledWith(
        EventType.EMBEDDING_GENERATION_FAILED,
        expect.objectContaining({
          runtime: runtime,
          memory,
          error: "Persistent failure",
          source: "embeddingService",
        }),
      );
    });
  });

  describe("Non-blocking Behavior", () => {
    it("should not block the runtime while generating embeddings", async () => {
      // Mock a slow embedding generation
      runtime.useModel = vi.fn().mockImplementation(() => {
        return new Promise((resolve) => {
          setTimeout(() => resolve([0.1, 0.2, 0.3, 0.4, 0.5]), 500); // 500ms delay
        });
      });

      service = (await EmbeddingGenerationService.start(
        runtime,
      )) as EmbeddingGenerationService;
      const handler = registeredEventHandlers.get(
        EventType.EMBEDDING_GENERATION_REQUESTED,
      );

      const startTime = Date.now();

      // Queue multiple embeddings
      const memories = Array.from({ length: 5 }, (_, i) => ({
        id: `memory-${i}` as UUID,
        entityId: "test-entity" as UUID,
        agentId: "test-agent" as UUID,
        roomId: "test-room" as UUID,
        content: { text: `Memory ${i}` },
        createdAt: Date.now(),
      }));

      // Queue all memories
      for (const memory of memories) {
        if (handler) {
          await handler({
            runtime: runtime,
            memory,
            priority: "normal",
            source: "test",
          });
        }
      }

      const queueTime = Date.now() - startTime;

      // Queueing should be nearly instant (< 100ms for 5 items)
      expect(queueTime).toBeLessThan(100);
      expect(service.getQueueSize()).toBe(5);

      // The runtime can continue processing other things while embeddings generate
      // This demonstrates the non-blocking nature of the service
    });

    it("should process queue in batches without blocking", async () => {
      let processedCount = 0;
      runtime.useModel = vi.fn().mockImplementation(() => {
        processedCount++;
        return Promise.resolve([0.1, 0.2, 0.3, 0.4, 0.5]);
      });

      service = (await EmbeddingGenerationService.start(
        runtime,
      )) as EmbeddingGenerationService;
      const handler = registeredEventHandlers.get(
        EventType.EMBEDDING_GENERATION_REQUESTED,
      );

      // Add 20 memories to queue
      for (let i = 0; i < 20; i++) {
        const memory: Memory = {
          id: `batch-memory-${i}` as UUID,
          entityId: "test-entity" as UUID,
          agentId: "test-agent" as UUID,
          roomId: "test-room" as UUID,
          content: { text: `Batch memory ${i}` },
          createdAt: Date.now(),
        };

        if (handler) {
          await handler({
            runtime: runtime,
            memory,
            priority: "normal",
            source: "test",
          });
        }
      }

      expect(service.getQueueSize()).toBe(20);

      // Wait for processing
      await new Promise((resolve) => setTimeout(resolve, 1000));

      // All should be processed
      expect(processedCount).toBe(20);
      expect(service.getQueueSize()).toBe(0);
    });
  });

  describe("Service Lifecycle", () => {
    it("should process high priority items before stopping", async () => {
      runtime.useModel = vi.fn().mockResolvedValue([0.1, 0.2, 0.3, 0.4, 0.5]);

      service = (await EmbeddingGenerationService.start(
        runtime,
      )) as EmbeddingGenerationService;
      const handler = registeredEventHandlers.get(
        EventType.EMBEDDING_GENERATION_REQUESTED,
      );

      // Add high and normal priority items
      const highMemory: Memory = {
        id: "high-priority" as UUID,
        entityId: "test-entity" as UUID,
        agentId: "test-agent" as UUID,
        roomId: "test-room" as UUID,
        content: { text: "High priority for shutdown" },
        createdAt: Date.now(),
      };

      const normalMemory: Memory = {
        id: "normal-priority" as UUID,
        entityId: "test-entity" as UUID,
        agentId: "test-agent" as UUID,
        roomId: "test-room" as UUID,
        content: { text: "Normal priority for shutdown" },
        createdAt: Date.now(),
      };

      if (handler) {
        await handler({
          runtime: runtime,
          memory: highMemory,
          priority: "high",
          source: "test",
        });
      }
      if (handler) {
        await handler({
          runtime: runtime,
          memory: normalMemory,
          priority: "normal",
          source: "test",
        });
      }

      // Stop the service immediately
      await service.stop();

      // High priority should have been processed
      expect(runtime.updateMemory).toHaveBeenCalledWith(
        expect.objectContaining({ id: "high-priority" }),
      );
    });
  });
});
