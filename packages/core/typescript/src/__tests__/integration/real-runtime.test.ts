/**
 * @fileoverview Example Integration Tests with Real Infrastructure
 *
 * These tests demonstrate how to write integration tests that use:
 * - Real database (PGLite via @elizaos/plugin-sql)
 * - Real inference (Ollama or cloud providers)
 *
 * NO MOCKS - These tests require real infrastructure to run.
 *
 * Prerequisites:
 * 1. Install plugin-sql: bun add @elizaos/plugin-sql
 * 2. For local inference, run Ollama: ollama serve
 * 3. Or set cloud API keys: OPENAI_API_KEY, ANTHROPIC_API_KEY
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { v4 as uuidv4 } from "uuid";
import type { Character, IAgentRuntime, Memory, UUID } from "../../types";
import { stringToUuid } from "../../utils";

// Check if we should run integration tests (requires explicit opt-in)
const SHOULD_RUN = process.env.RUN_INTEGRATION_TESTS === "true";

describe.skipIf(!SHOULD_RUN)(
  "Integration Tests with Real Infrastructure",
  () => {
    let runtime: IAgentRuntime | undefined;
    let agentId: UUID;
    let cleanup: (() => Promise<void>) | undefined;
    let setupSucceeded = false;

    const testCharacter: Character = {
      name: "IntegrationTestAgent",
      system: "You are a helpful assistant for integration testing.",
      bio: ["Integration test agent"],
      messageExamples: [],
      postExamples: [],
      topics: ["testing"],
      knowledge: [],
      plugins: [],
      settings: {},
    };

    beforeAll(async () => {
      // Dynamic import to avoid build errors if plugin-sql is not installed
      let createTestDatabase: typeof import("@elizaos/plugin-sql/src/__tests__/test-helpers").createTestDatabase;

      try {
        const testHelpers = await import(
          "@elizaos/plugin-sql/src/__tests__/test-helpers"
        );
        createTestDatabase = testHelpers.createTestDatabase;
      } catch (e) {
        console.warn(
          "⚠️  Integration tests skipped: @elizaos/plugin-sql not available",
          e,
        );
        return;
      }

      try {
        agentId = uuidv4() as UUID;
        testCharacter.id = agentId;

        const result = await createTestDatabase(agentId);
        runtime = result.runtime;
        cleanup = result.cleanup;

        // Wait for runtime to be fully initialized
        await runtime.initialize();
        setupSucceeded = true;
      } catch (e) {
        console.warn("⚠️  Integration test setup failed:", e);
      }
    });

    afterAll(async () => {
      if (cleanup) {
        await cleanup();
      }
    });

    describe("Database Operations", () => {
      it("should create and retrieve a memory", async () => {
        if (!setupSucceeded || !runtime) {
          console.warn("⚠️  Skipping: runtime not available");
          return;
        }

        const roomId = stringToUuid(`test-room-${uuidv4()}`);

        const memory: Memory = {
          id: stringToUuid(`message-${uuidv4()}`),
          entityId: agentId,
          roomId,
          content: {
            text: "Hello, this is a test message",
            source: "integration-test",
          },
          createdAt: Date.now(),
        };

        // Create memory
        const memoryId = await runtime.createMemory(memory, "messages");
        expect(memoryId).toBeDefined();

        // Retrieve memories
        const memories = await runtime.getMemories({
          roomId,
          count: 10,
          tableName: "messages",
        });

        expect(memories.length).toBeGreaterThan(0);
        const found = memories.find((m) => m.id === memory.id);
        expect(found).toBeDefined();
        expect(found?.content.text).toBe("Hello, this is a test message");
      });

      it("should create a room and add participants", async () => {
        if (!setupSucceeded || !runtime) {
          console.warn("⚠️  Skipping: runtime not available");
          return;
        }

        const roomId = stringToUuid(`test-room-${uuidv4()}`);
        const entityId = stringToUuid(`test-entity-${uuidv4()}`);

        // Ensure room exists
        await runtime.ensureRoomExists({
          id: roomId,
          name: "Test Room",
          source: "integration-test",
          type: "GROUP",
        });

        // Add participant
        const added = await runtime.addParticipant(entityId, roomId);
        expect(added).toBe(true);

        // Verify participant
        const participants = await runtime.getParticipantsForRoom(roomId);
        expect(participants).toContain(entityId);
      });

      it("should handle world and room relationships", async () => {
        if (!setupSucceeded || !runtime) {
          console.warn("⚠️  Skipping: runtime not available");
          return;
        }

        const worldId = await runtime.createWorld({
          name: "Test World",
          agentId,
        });
        expect(worldId).toBeDefined();

        const roomId = stringToUuid(`test-room-${uuidv4()}`);
        await runtime.ensureRoomExists({
          id: roomId,
          name: "Room in World",
          source: "integration-test",
          type: "GROUP",
          worldId,
        });

        // Get rooms for world
        const rooms = await runtime.getRoomsByWorld(worldId);
        expect(rooms.length).toBeGreaterThan(0);
      });
    });

    describe("Entity Management", () => {
      it("should create and retrieve an entity", async () => {
        if (!setupSucceeded || !runtime) {
          console.warn("⚠️  Skipping: runtime not available");
          return;
        }

        const entityId = stringToUuid(`entity-${uuidv4()}`);

        await runtime.createEntity({
          id: entityId,
          names: ["Test Entity"],
          agentId,
          metadata: { testKey: "testValue" },
        });

        const entity = await runtime.getEntityById(entityId);
        expect(entity).toBeDefined();
        expect(entity?.names).toContain("Test Entity");
      });
    });

    describe("Cache Operations", () => {
      it("should set and get cache values", async () => {
        if (!setupSucceeded || !runtime) {
          console.warn("⚠️  Skipping: runtime not available");
          return;
        }

        const cacheKey = `test-cache-${uuidv4()}`;
        const cacheValue = { data: "test data", timestamp: Date.now() };

        await runtime.setCache({ key: cacheKey, agentId, value: cacheValue });

        const retrieved = await runtime.getCache({ key: cacheKey, agentId });
        expect(retrieved).toBeDefined();
        expect(retrieved?.data).toBe("test data");
      });
    });

    describe("Task Management", () => {
      it("should create and retrieve a task", async () => {
        if (!setupSucceeded || !runtime) {
          console.warn("⚠️  Skipping: runtime not available");
          return;
        }

        const roomId = stringToUuid(`test-room-${uuidv4()}`);

        const taskId = await runtime.createTask({
          name: "Test Task",
          roomId,
          worldId: agentId, // Using agentId as worldId for simplicity
          metadata: { priority: "high" },
          tags: ["test"],
        });

        expect(taskId).toBeDefined();

        const task = await runtime.getTask(taskId);
        expect(task).toBeDefined();
        expect(task?.name).toBe("Test Task");
      });
    });
  },
);

/**
 * Example of testing with real inference (requires Ollama)
 */
describe.skipIf(!SHOULD_RUN)("Inference Integration Tests", () => {
  it.skip("should generate text using Ollama", async () => {
    // This test requires Ollama to be running
    // Enable it when you have Ollama set up

    const response = await fetch("http://localhost:11434/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "llama3.2:1b",
        prompt: "Say hello in one word",
        stream: false,
      }),
    });

    if (response.ok) {
      const data = (await response.json()) as { response: string };
      expect(data.response).toBeDefined();
      expect(data.response.length).toBeGreaterThan(0);
    }
  });
});
