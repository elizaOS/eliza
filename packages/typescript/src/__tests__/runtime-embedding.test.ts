import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentRuntime } from "../runtime.ts";
import {
  EventType,
  type IDatabaseAdapter,
  type Memory,
  type UUID,
} from "../types";
import type { EmbeddingGenerationPayload } from "../types/events.ts";
import { stringToUuid } from "../utils.ts";

/**
 * Minimal mock adapter for testing AgentRuntime event emission.
 * Uses a Proxy to return mock implementations for all methods.
 */
function createMinimalMockAdapter(): IDatabaseAdapter {
  return new Proxy({} as IDatabaseAdapter, {
    get: (_target, prop) => {
      if (prop === "db") return {};
      return vi.fn().mockResolvedValue(null);
    },
  });
}

describe("AgentRuntime - queueEmbeddingGeneration", () => {
  let runtime: AgentRuntime;
  let emittedEvents: Array<{ event: string; payload: unknown }> = [];

  beforeEach(() => {
    emittedEvents = [];

    // Create runtime with test configuration
    runtime = new AgentRuntime({
      agentId: stringToUuid("test-agent"),
      character: {
        id: stringToUuid("test-character"),
        name: "Test Character",
        username: "test_character",
        system: "Test system prompt",
        bio: "Test bio",
      },
      adapter: createMinimalMockAdapter(),
      conversationLength: 10,
    });

    // Track emitted events
    const originalEmitEvent = runtime.emitEvent.bind(runtime);
    runtime.emitEvent = vi.fn(
      async (event: string | string[], payload: unknown) => {
        const events = Array.isArray(event) ? event : [event];
        for (const e of events) {
          emittedEvents.push({ event: e, payload });
        }
        return originalEmitEvent(event, payload);
      },
    );
  });

  describe("queueEmbeddingGeneration", () => {
    it("should emit EMBEDDING_GENERATION_REQUESTED event for memory with text", async () => {
      const memory: Memory = {
        id: "test-memory-id" as UUID,
        entityId: "test-entity" as UUID,
        agentId: "test-agent" as UUID,
        roomId: "test-room" as UUID,
        content: { text: "Test memory content" },
        createdAt: Date.now(),
      };

      await runtime.queueEmbeddingGeneration(memory, "normal");

      const event = emittedEvents.find(
        (e) => e.event === EventType.EMBEDDING_GENERATION_REQUESTED,
      );
      expect(event).toBeDefined();
      const payload = event?.payload as EmbeddingGenerationPayload;
      expect(payload.runtime).toBe(runtime);
      expect(payload.memory).toEqual(memory);
      expect(payload.priority).toBe("normal");
      expect(payload.source).toBe("runtime");
      expect(payload.retryCount).toBe(0);
      expect(payload.maxRetries).toBe(3);
    });

    it("should skip memory that already has embeddings", async () => {
      const memory: Memory = {
        id: "test-memory-id" as UUID,
        entityId: "test-entity" as UUID,
        agentId: "test-agent" as UUID,
        roomId: "test-room" as UUID,
        content: { text: "Test memory content" },
        embedding: [0.1, 0.2, 0.3, 0.4, 0.5],
        createdAt: Date.now(),
      };

      await runtime.queueEmbeddingGeneration(memory, "normal");

      const event = emittedEvents.find(
        (e) => e.event === EventType.EMBEDDING_GENERATION_REQUESTED,
      );
      expect(event).toBeUndefined();
    });

    it("should skip memory without text content", async () => {
      const memory: Memory = {
        id: "test-memory-id" as UUID,
        entityId: "test-entity" as UUID,
        agentId: "test-agent" as UUID,
        roomId: "test-room" as UUID,
        content: {},
        createdAt: Date.now(),
      };

      await runtime.queueEmbeddingGeneration(memory, "normal");

      const event = emittedEvents.find(
        (e) => e.event === EventType.EMBEDDING_GENERATION_REQUESTED,
      );
      expect(event).toBeUndefined();
    });

    it("should support different priority levels", async () => {
      const memories = [
        {
          memory: {
            id: "high-priority" as UUID,
            entityId: "test-entity" as UUID,
            agentId: "test-agent" as UUID,
            roomId: "test-room" as UUID,
            content: { text: "High priority content" },
            createdAt: Date.now(),
          },
          priority: "high" as const,
        },
        {
          memory: {
            id: "normal-priority" as UUID,
            entityId: "test-entity" as UUID,
            agentId: "test-agent" as UUID,
            roomId: "test-room" as UUID,
            content: { text: "Normal priority content" },
            createdAt: Date.now(),
          },
          priority: "normal" as const,
        },
        {
          memory: {
            id: "low-priority" as UUID,
            entityId: "test-entity" as UUID,
            agentId: "test-agent" as UUID,
            roomId: "test-room" as UUID,
            content: { text: "Low priority content" },
            createdAt: Date.now(),
          },
          priority: "low" as const,
        },
      ];

      for (const { memory, priority } of memories) {
        await runtime.queueEmbeddingGeneration(memory, priority);
      }

      const events = emittedEvents.filter(
        (e) => e.event === EventType.EMBEDDING_GENERATION_REQUESTED,
      );
      expect(events).toHaveLength(3);

      expect((events[0].payload as EmbeddingGenerationPayload).priority).toBe(
        "high",
      );
      expect((events[1].payload as EmbeddingGenerationPayload).priority).toBe(
        "normal",
      );
      expect((events[2].payload as EmbeddingGenerationPayload).priority).toBe(
        "low",
      );
    });

    it("should use normal priority by default", async () => {
      const memory: Memory = {
        id: "test-memory-id" as UUID,
        entityId: "test-entity" as UUID,
        agentId: "test-agent" as UUID,
        roomId: "test-room" as UUID,
        content: { text: "Default priority content" },
        createdAt: Date.now(),
      };

      await runtime.queueEmbeddingGeneration(memory);

      const event = emittedEvents.find(
        (e) => e.event === EventType.EMBEDDING_GENERATION_REQUESTED,
      );
      expect(
        (event && (event.payload as EmbeddingGenerationPayload)).priority,
      ).toBe("normal");
    });

    it("should be non-blocking", async () => {
      const memory: Memory = {
        id: "test-memory-id" as UUID,
        entityId: "test-entity" as UUID,
        agentId: "test-agent" as UUID,
        roomId: "test-room" as UUID,
        content: { text: "Non-blocking test" },
        createdAt: Date.now(),
      };

      const startTime = Date.now();
      await runtime.queueEmbeddingGeneration(memory, "normal");
      const elapsed = Date.now() - startTime;

      // Should complete almost instantly (< 10ms)
      expect(elapsed).toBeLessThan(10);
    });

    it("should handle multiple queued embeddings efficiently", async () => {
      const memories = Array.from({ length: 100 }, (_, i) => ({
        id: `memory-${i}` as UUID,
        entityId: "test-entity" as UUID,
        agentId: "test-agent" as UUID,
        roomId: "test-room" as UUID,
        content: { text: `Memory content ${i}` },
        createdAt: Date.now(),
      }));

      const startTime = Date.now();

      // Queue all memories
      await Promise.all(
        memories.map((memory) =>
          runtime.queueEmbeddingGeneration(memory, "normal"),
        ),
      );

      const elapsed = Date.now() - startTime;

      // Should complete very quickly even with 100 memories (< 50ms)
      expect(elapsed).toBeLessThan(50);

      // All events should be emitted
      const events = emittedEvents.filter(
        (e) => e.event === EventType.EMBEDDING_GENERATION_REQUESTED,
      );
      expect(events).toHaveLength(100);
    });
  });

  describe("Integration with addEmbeddingToMemory", () => {
    it("should work alongside synchronous embedding generation", async () => {
      // Mock the useModel for synchronous embedding with a simulated delay
      runtime.useModel = vi
        .fn()
        .mockImplementation(async (modelType: string) => {
          if (modelType === "TEXT_EMBEDDING") {
            // Simulate a realistic embedding generation delay
            await new Promise((resolve) => setTimeout(resolve, 5));
            return [0.1, 0.2, 0.3, 0.4, 0.5];
          }
          return Promise.resolve("mock response");
        });

      const syncMemory: Memory = {
        id: "sync-memory" as UUID,
        entityId: "test-entity" as UUID,
        agentId: "test-agent" as UUID,
        roomId: "test-room" as UUID,
        content: { text: "Synchronous embedding" },
        createdAt: Date.now(),
      };

      const asyncMemory: Memory = {
        id: "async-memory" as UUID,
        entityId: "test-entity" as UUID,
        agentId: "test-agent" as UUID,
        roomId: "test-room" as UUID,
        content: { text: "Asynchronous embedding" },
        createdAt: Date.now(),
      };

      // Synchronous embedding (blocking - will wait for the delay)
      const startSync = Date.now();
      const resultSync = await runtime.addEmbeddingToMemory(syncMemory);
      const elapsedSync = Date.now() - startSync;

      // Asynchronous embedding (non-blocking - just queues)
      const startAsync = Date.now();
      await runtime.queueEmbeddingGeneration(asyncMemory, "normal");
      const elapsedAsync = Date.now() - startAsync;

      // Sync should have embeddings immediately
      expect(resultSync.embedding).toBeDefined();
      expect(resultSync.embedding).toEqual([0.1, 0.2, 0.3, 0.4, 0.5]);

      // Async should be much faster (just queuing, no waiting)
      expect(elapsedAsync).toBeLessThan(elapsedSync);

      // Verify that sync took at least the simulated delay (with margin for timing precision)
      expect(elapsedSync).toBeGreaterThanOrEqual(3);

      // Event should be emitted for async
      const event = emittedEvents.find(
        (e) => e.event === EventType.EMBEDDING_GENERATION_REQUESTED,
      );
      expect(event).toBeDefined();
      expect(
        (event && (event.payload as EmbeddingGenerationPayload)).memory.id,
      ).toBe(asyncMemory.id);
    });
  });

  describe("Error Handling", () => {
    it("should handle null or undefined memory gracefully", async () => {
      // Test with undefined
      await runtime.queueEmbeddingGeneration(undefined, "normal");

      // Test with null
      await runtime.queueEmbeddingGeneration(null, "normal");

      // No events should be emitted
      const events = emittedEvents.filter(
        (e) => e.event === EventType.EMBEDDING_GENERATION_REQUESTED,
      );
      expect(events).toHaveLength(0);
    });

    it("should handle memory with null content gracefully", async () => {
      // Testing edge case: malformed memory with null content
      // This simulates data corruption or invalid API input
      interface MalformedMemory extends Omit<Memory, "content"> {
        content: null;
      }
      const memory: MalformedMemory = {
        id: "null-content" as UUID,
        entityId: "test-entity" as UUID,
        agentId: "test-agent" as UUID,
        roomId: "test-room" as UUID,
        content: null,
        createdAt: Date.now(),
      };

      // Cast to Memory to test runtime handling of invalid data
      await runtime.queueEmbeddingGeneration(memory as Memory, "normal");

      // No event should be emitted
      const event = emittedEvents.find(
        (e) => e.event === EventType.EMBEDDING_GENERATION_REQUESTED,
      );
      expect(event).toBeUndefined();
    });

    it("should handle empty text content gracefully", async () => {
      const memory: Memory = {
        id: "empty-text" as UUID,
        entityId: "test-entity" as UUID,
        agentId: "test-agent" as UUID,
        roomId: "test-room" as UUID,
        content: { text: "" },
        createdAt: Date.now(),
      };

      await runtime.queueEmbeddingGeneration(memory, "normal");

      // No event should be emitted for empty text
      const event = emittedEvents.find(
        (e) => e.event === EventType.EMBEDDING_GENERATION_REQUESTED,
      );
      expect(event).toBeUndefined();
    });
  });
});
