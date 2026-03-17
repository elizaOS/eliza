import type { IAgentRuntime, TestSuite } from "@elizaos/core";
import { createMessageMemory, logger, type UUID } from "@elizaos/core";
import { describe, expect, it } from "vitest";

export const ScratchpadPluginE2ETestSuite: TestSuite = {
  name: "Scratchpad Plugin E2E Tests",
  tests: [
    {
      name: "should have all actions registered",
      fn: async (runtime: IAgentRuntime) => {
        logger.info("Testing action registration...");

        const expectedActions = [
          "SCRATCHPAD_WRITE",
          "SCRATCHPAD_READ",
          "SCRATCHPAD_SEARCH",
          "SCRATCHPAD_LIST",
          "SCRATCHPAD_DELETE",
          "SCRATCHPAD_APPEND",
        ];

        for (const actionName of expectedActions) {
          const action = runtime.actions.find((a) => a.name === actionName);
          if (!action) {
            throw new Error(`Action ${actionName} not found`);
          }
          logger.info(`✓ ${actionName} action found`);
        }

        logger.info("✅ All actions registered successfully");
      },
    },

    {
      name: "should have scratchpad provider registered",
      fn: async (runtime: IAgentRuntime) => {
        logger.info("Testing provider registration...");

        const provider = runtime.providers.find((p) => p.name === "scratchpad");
        if (!provider) {
          throw new Error("Scratchpad provider not found");
        }
        logger.info("✓ Scratchpad provider found");

        // Test that provider can be called
        const testMessage = createMessageMemory({
          entityId: `test-entity-${Date.now()}` as UUID,
          agentId: runtime.agentId,
          roomId: `test-room-${Date.now()}` as UUID,
          content: { text: "test", source: "test" },
        });

        const state = await runtime.composeState(testMessage, []);
        const result = await provider.get(runtime, testMessage, state);

        if (!result || typeof result.text !== "string") {
          throw new Error("Provider should return a valid result with text");
        }
        logger.info("✓ Scratchpad provider returns valid result");

        logger.info("✅ Provider registration test passed");
      },
    },

    {
      name: "should validate SCRATCHPAD_WRITE action",
      fn: async (runtime: IAgentRuntime) => {
        logger.info("Testing SCRATCHPAD_WRITE action validation...");

        const writeAction = runtime.actions.find((a) => a.name === "SCRATCHPAD_WRITE");
        if (!writeAction) {
          throw new Error("SCRATCHPAD_WRITE action not found");
        }

        const testMessage = createMessageMemory({
          entityId: `test-entity-${Date.now()}` as UUID,
          agentId: runtime.agentId,
          roomId: `test-room-${Date.now()}` as UUID,
          content: {
            text: "Save a note about the meeting tomorrow at 3pm",
            source: "test",
          },
        });

        const isValid = await writeAction.validate(runtime, testMessage);
        if (!isValid) {
          throw new Error("SCRATCHPAD_WRITE action should validate");
        }

        logger.info("✓ SCRATCHPAD_WRITE action validates correctly");
        logger.info("✅ SCRATCHPAD_WRITE validation test passed");
      },
    },

    {
      name: "should validate SCRATCHPAD_SEARCH action",
      fn: async (runtime: IAgentRuntime) => {
        logger.info("Testing SCRATCHPAD_SEARCH action validation...");

        const searchAction = runtime.actions.find((a) => a.name === "SCRATCHPAD_SEARCH");
        if (!searchAction) {
          throw new Error("SCRATCHPAD_SEARCH action not found");
        }

        const testMessage = createMessageMemory({
          entityId: `test-entity-${Date.now()}` as UUID,
          agentId: runtime.agentId,
          roomId: `test-room-${Date.now()}` as UUID,
          content: {
            text: "Search my notes for anything about meetings",
            source: "test",
          },
        });

        const isValid = await searchAction.validate(runtime, testMessage);
        if (!isValid) {
          throw new Error("SCRATCHPAD_SEARCH action should validate");
        }

        logger.info("✓ SCRATCHPAD_SEARCH action validates correctly");
        logger.info("✅ SCRATCHPAD_SEARCH validation test passed");
      },
    },

    {
      name: "should validate SCRATCHPAD_LIST action",
      fn: async (runtime: IAgentRuntime) => {
        logger.info("Testing SCRATCHPAD_LIST action validation...");

        const listAction = runtime.actions.find((a) => a.name === "SCRATCHPAD_LIST");
        if (!listAction) {
          throw new Error("SCRATCHPAD_LIST action not found");
        }

        const testMessage = createMessageMemory({
          entityId: `test-entity-${Date.now()}` as UUID,
          agentId: runtime.agentId,
          roomId: `test-room-${Date.now()}` as UUID,
          content: {
            text: "Show me all my notes",
            source: "test",
          },
        });

        const isValid = await listAction.validate(runtime, testMessage);
        if (!isValid) {
          throw new Error("SCRATCHPAD_LIST action should validate");
        }

        logger.info("✓ SCRATCHPAD_LIST action validates correctly");
        logger.info("✅ SCRATCHPAD_LIST validation test passed");
      },
    },

    {
      name: "should have similes for fuzzy matching",
      fn: async (runtime: IAgentRuntime) => {
        logger.info("Testing action similes...");

        const writeAction = runtime.actions.find((a) => a.name === "SCRATCHPAD_WRITE");
        if (!writeAction) {
          throw new Error("SCRATCHPAD_WRITE action not found");
        }

        if (!writeAction.similes || writeAction.similes.length === 0) {
          throw new Error("SCRATCHPAD_WRITE should have similes");
        }

        const expectedSimiles = ["SAVE_NOTE", "CREATE_NOTE", "REMEMBER_THIS"];
        for (const simile of expectedSimiles) {
          if (!writeAction.similes.includes(simile)) {
            throw new Error(`SCRATCHPAD_WRITE should have simile '${simile}'`);
          }
        }

        logger.info("✓ Actions have proper similes");
        logger.info("✅ Action similes test passed");
      },
    },

    {
      name: "should handle concurrent operations safely",
      fn: async (runtime: IAgentRuntime) => {
        logger.info("Testing concurrent operations...");

        const { createScratchpadService } = await import("../services/scratchpadService");
        const fs = await import("node:fs/promises");
        const path = await import("node:path");
        const os = await import("node:os");

        const testDir = path.join(os.tmpdir(), `scratchpad-concurrent-${Date.now()}`);
        const service = createScratchpadService(runtime, { basePath: testDir });

        try {
          // Create multiple entries concurrently
          const writePromises = Array.from({ length: 5 }, (_, i) =>
            service.write(`Concurrent Note ${i}`, `Content for note ${i}`)
          );

          const results = await Promise.all(writePromises);

          if (results.length !== 5) {
            throw new Error(`Expected 5 results, got ${results.length}`);
          }

          // All should have unique IDs
          const ids = new Set(results.map((r) => r.id));
          if (ids.size !== 5) {
            throw new Error("All entries should have unique IDs");
          }

          logger.info("✓ Concurrent writes handled correctly");

          // Concurrent reads
          const readPromises = results.map((r) => service.read(r.id));
          const readResults = await Promise.all(readPromises);

          if (readResults.length !== 5) {
            throw new Error("All concurrent reads should succeed");
          }

          logger.info("✓ Concurrent reads handled correctly");
          logger.info("✅ Concurrent operations test passed");
        } finally {
          await fs.rm(testDir, { recursive: true, force: true });
        }
      },
    },

    {
      name: "should provide context through provider",
      fn: async (runtime: IAgentRuntime) => {
        logger.info("Testing provider context...");

        // Note: In a real test, the provider would use runtime's configured path
        // For this test, we verify the provider interface works

        const provider = runtime.providers.find((p) => p.name === "scratchpad");
        if (!provider) {
          throw new Error("Scratchpad provider not found");
        }

        const testMessage = createMessageMemory({
          entityId: `test-entity-${Date.now()}` as UUID,
          agentId: runtime.agentId,
          roomId: `test-room-${Date.now()}` as UUID,
          content: { text: "test", source: "test" },
        });

        const state = await runtime.composeState(testMessage, []);
        const result = await provider.get(runtime, testMessage, state);

        // Provider should return structured data
        if (!result.values || typeof result.values.scratchpadCount !== "number") {
          throw new Error("Provider should return scratchpadCount in values");
        }

        logger.info("✓ Provider returns structured context");
        logger.info("✅ Provider context test passed");
      },
    },
  ],
};

describe(ScratchpadPluginE2ETestSuite.name, () => {
  it("exports a non-empty test suite for E2E runner", () => {
    expect(ScratchpadPluginE2ETestSuite.tests.length).toBeGreaterThan(0);
  });
});
