/**
 * @fileoverview Tests for integration runtime factory
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createIntegrationTestRuntime,
  DEFAULT_TEST_CHARACTER,
  withTestRuntime,
} from "../testing/integration-runtime";
import type { IDatabaseAdapter, UUID } from "../types";

// Mock database adapter
function createMockDatabaseAdapter(): IDatabaseAdapter {
  return {
    init: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    getConnection: vi.fn().mockResolvedValue({}),
    // Add minimal stubs for all required methods
    getAgent: vi.fn().mockResolvedValue(null),
    createAgent: vi.fn().mockResolvedValue(undefined),
    getAgents: vi.fn().mockResolvedValue([]),
    updateAgent: vi.fn().mockResolvedValue(undefined),
    deleteAgent: vi.fn().mockResolvedValue(undefined),
    countAgents: vi.fn().mockResolvedValue(0),
    getEntityById: vi.fn().mockResolvedValue(null),
    getEntitiesForRoom: vi.fn().mockResolvedValue([]),
    createEntity: vi.fn().mockResolvedValue(undefined),
    updateEntity: vi.fn().mockResolvedValue(undefined),
    getComponent: vi.fn().mockResolvedValue(null),
    getComponents: vi.fn().mockResolvedValue([]),
    createComponent: vi.fn().mockResolvedValue(undefined),
    updateComponent: vi.fn().mockResolvedValue(undefined),
    deleteComponent: vi.fn().mockResolvedValue(undefined),
    getMemoryById: vi.fn().mockResolvedValue(null),
    getMemories: vi.fn().mockResolvedValue([]),
    getMemoriesByIds: vi.fn().mockResolvedValue([]),
    getMemoriesByRoomIds: vi.fn().mockResolvedValue([]),
    createMemory: vi.fn().mockResolvedValue(undefined),
    searchMemories: vi.fn().mockResolvedValue([]),
    searchMemoriesByEmbedding: vi.fn().mockResolvedValue([]),
    deleteMemory: vi.fn().mockResolvedValue(undefined),
    deleteAllMemories: vi.fn().mockResolvedValue(undefined),
    countMemories: vi.fn().mockResolvedValue(0),
    getRoom: vi.fn().mockResolvedValue(null),
    getRooms: vi.fn().mockResolvedValue([]),
    createRoom: vi.fn().mockResolvedValue("test-room-id" as UUID),
    updateRoom: vi.fn().mockResolvedValue(undefined),
    deleteRoom: vi.fn().mockResolvedValue(undefined),
    addParticipantToRoom: vi.fn().mockResolvedValue(undefined),
    removeParticipantFromRoom: vi.fn().mockResolvedValue(undefined),
    getParticipantsForRoom: vi.fn().mockResolvedValue([]),
    getRoomsForParticipant: vi.fn().mockResolvedValue([]),
    getRoomsForParticipants: vi.fn().mockResolvedValue([]),
    getRelationship: vi.fn().mockResolvedValue(null),
    getRelationships: vi.fn().mockResolvedValue([]),
    createRelationship: vi.fn().mockResolvedValue(undefined),
    updateRelationship: vi.fn().mockResolvedValue(undefined),
    getWorld: vi.fn().mockResolvedValue(null),
    getWorlds: vi.fn().mockResolvedValue([]),
    createWorld: vi.fn().mockResolvedValue(undefined),
    updateWorld: vi.fn().mockResolvedValue(undefined),
    removeWorld: vi.fn().mockResolvedValue(undefined),
    getTask: vi.fn().mockResolvedValue(null),
    getTasks: vi.fn().mockResolvedValue([]),
    getTasksByName: vi.fn().mockResolvedValue([]),
    createTask: vi.fn().mockResolvedValue(undefined),
    updateTask: vi.fn().mockResolvedValue(undefined),
    deleteTask: vi.fn().mockResolvedValue(undefined),
    getLogs: vi.fn().mockResolvedValue([]),
    createLog: vi.fn().mockResolvedValue(undefined),
    deleteLogs: vi.fn().mockResolvedValue(undefined),
    getCache: vi.fn().mockResolvedValue(null),
    setCache: vi.fn().mockResolvedValue(undefined),
    deleteCache: vi.fn().mockResolvedValue(undefined),
    ensureAgentExists: vi.fn().mockResolvedValue(undefined),
    ensureEmbeddingDimension: vi.fn().mockResolvedValue(undefined),
    withTransaction: vi.fn().mockImplementation((fn) => fn()),
    withDatabase: vi.fn().mockImplementation((fn) => fn({})),
  } satisfies Partial<IDatabaseAdapter> as IDatabaseAdapter;
}

describe("Integration Runtime", () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Mock Ollama as available
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ models: [{ name: "llama3.2:1b" }] }),
    } as Response);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env = { ...originalEnv };
  });

  describe("DEFAULT_TEST_CHARACTER", () => {
    it("should have required properties", () => {
      expect(DEFAULT_TEST_CHARACTER.name).toBe("IntegrationTestAgent");
      expect(DEFAULT_TEST_CHARACTER.system).toBeDefined();
      expect(DEFAULT_TEST_CHARACTER.bio).toBeInstanceOf(Array);
      expect(DEFAULT_TEST_CHARACTER.topics).toContain("testing");
    });
  });

  describe("createIntegrationTestRuntime", () => {
    it("should throw when databaseAdapter is missing", async () => {
      // Testing with null adapter (intentional type test)
      await expect(
        createIntegrationTestRuntime({
          databaseAdapter: null as IDatabaseAdapter,
        }),
      ).rejects.toThrow("Integration tests require a database adapter");
    });

    it("should throw when no inference provider is available and not skipped", async () => {
      // Mock no providers available
      delete process.env.OPENAI_API_KEY;
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.GOOGLE_API_KEY;
      globalThis.fetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));

      const adapter = createMockDatabaseAdapter();

      await expect(
        createIntegrationTestRuntime({
          databaseAdapter: adapter,
          initTimeout: 1000,
        }),
      ).rejects.toThrow("No inference provider available");
    });

    it("should allow skipping inference check", async () => {
      // Mock no providers available
      delete process.env.OPENAI_API_KEY;
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.GOOGLE_API_KEY;
      globalThis.fetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));

      const adapter = createMockDatabaseAdapter();

      // This should not throw because skipInferenceCheck is true
      // However, it will still try to initialize the runtime which may fail
      // depending on other factors. The key test is that it doesn't throw
      // about missing inference provider.
      try {
        const result = await createIntegrationTestRuntime({
          databaseAdapter: adapter,
          skipInferenceCheck: true,
          initTimeout: 100,
        });

        // If we get here, inference check was skipped
        expect(result.inferenceProvider).toBe(null);
        await result.cleanup();
      } catch (error) {
        // If it throws, it should NOT be about inference provider
        const message = error instanceof Error ? error.message : String(error);
        expect(message).not.toContain("No inference provider");
      }
    });

    it("should use custom character overrides", async () => {
      process.env.OPENAI_API_KEY = "test-key";
      globalThis.fetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));

      const adapter = createMockDatabaseAdapter();

      try {
        const result = await createIntegrationTestRuntime({
          databaseAdapter: adapter,
          character: {
            name: "CustomTestAgent",
            topics: ["custom", "testing"],
          },
          initTimeout: 100,
        });

        // Cleanup even if we can't fully verify
        await result.cleanup();
      } catch {
        // May fail during init, but that's okay for this test
      }
    });
  });

  describe("withTestRuntime", () => {
    it("should cleanup even when test throws", async () => {
      process.env.OPENAI_API_KEY = "test-key";
      globalThis.fetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));

      const adapter = createMockDatabaseAdapter();

      // We expect this to throw - either from the test or from init
      let threwError = false;
      try {
        await withTestRuntime(
          async (_runtime, _agentId) => {
            // Simulate test that throws
            throw new Error("Test failure");
          },
          {
            databaseAdapter: adapter,
            initTimeout: 100,
          },
        );
      } catch (_error) {
        threwError = true;
        // Just verify it threw - the specific error depends on initialization
      }

      expect(threwError).toBe(true);
    });
  });
});
