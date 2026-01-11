import type { IAgentRuntime } from "@elizaos/core";
import { logger } from "@elizaos/core";
import * as undici from "undici";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { openrouterPlugin } from "../src/index";

/**
 * Creates a REAL AgentRuntime for testing - NO MOCKS.
 */
async function createTestRuntime(settings: Record<string, string> = {}): Promise<{
  runtime: IAgentRuntime;
  cleanup: () => Promise<void>;
}> {
  const sqlPlugin = await import("@elizaos/plugin-sql");
  const { AgentRuntime } = await import("@elizaos/core");
  const { v4: uuidv4 } = await import("uuid");

  const agentId = uuidv4() as `${string}-${string}-${string}-${string}-${string}`;
  const adapter = sqlPlugin.createDatabaseAdapter({ dataDir: ":memory:" }, agentId);
  await adapter.init();

  const runtime = new AgentRuntime({
    agentId,
    character: {
      name: "Test Agent",
      bio: ["A test agent"],
      system: "You are a helpful assistant.",
      plugins: [],
      settings: {
        secrets: settings,
      },
      messageExamples: [],
      postExamples: [],
      topics: ["testing"],
      adjectives: ["helpful"],
      style: { all: [], chat: [], post: [] },
    },
    adapter,
    plugins: [],
  });

  await runtime.initialize();

  const cleanup = async () => {
    try {
      await runtime.stop();
      await adapter.close();
    } catch {
      // Ignore cleanup errors
    }
  };

  return { runtime, cleanup };
}

describe("OpenRouter Plugin Configuration", () => {
  let cleanup: () => Promise<void>;

  beforeEach(() => {
    // Stub undici fetch to prevent network calls
    vi.spyOn(undici, "fetch").mockImplementation(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ data: [] }),
        headers: new Headers(),
      } as Response)
    );
  });

  afterEach(async () => {
    // Clear all mocks
    vi.restoreAllMocks();
    if (cleanup) {
      await cleanup();
    }
  });

  test("should warn when API key is missing", async () => {
    // Save original env value
    const originalApiKey = process.env.OPENROUTER_API_KEY;

    // Clear API key from environment
    delete process.env.OPENROUTER_API_KEY;

    // Create a real runtime with no API key
    const result = await createTestRuntime({});
    cleanup = result.cleanup;

    // Spy on logger warnings
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});

    // Initialize plugin
    if (openrouterPlugin.init) {
      await openrouterPlugin.init({}, result.runtime);
    }

    // Wait a tick for async initialization
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Check that warning was logged
    expect(warnSpy).toHaveBeenCalled();

    // Restore mock
    warnSpy.mockRestore();

    // Restore original env value
    if (originalApiKey) {
      process.env.OPENROUTER_API_KEY = originalApiKey;
    }
  });

  test("should initialize properly with valid API key", async () => {
    // Skip if no API key available for testing
    if (!process.env.OPENROUTER_API_KEY) {
      console.warn("Skipping test: OPENROUTER_API_KEY not set");
      return;
    }

    // Create a real runtime with API key
    const result = await createTestRuntime({
      OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
    });
    cleanup = result.cleanup;

    // Initialize plugin
    if (openrouterPlugin.init) {
      await openrouterPlugin.init({}, result.runtime);
    }

    // Wait a tick for async validation
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Check that fetch was called to validate API key
    expect(undici.fetch).toHaveBeenCalled();
    expect(undici.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/models"),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: expect.stringContaining("Bearer"),
        }),
      })
    );
  });

  test("should use custom image model when configured", async () => {
    // Create a real runtime with custom model settings
    const customImageModel = "anthropic/claude-3-opus-vision";
    const result = await createTestRuntime({
      OPENROUTER_IMAGE_MODEL: customImageModel,
      OPENROUTER_API_KEY: "test-api-key",
    });
    cleanup = result.cleanup;

    // Create spy to access private function
    const getSpy = vi.spyOn(result.runtime, "getSetting");

    // Check if our model is used
    if (openrouterPlugin.models?.IMAGE_DESCRIPTION) {
      const imageDescHandler = openrouterPlugin.models.IMAGE_DESCRIPTION;

      // Just initiating the handler should call getSetting with OPENROUTER_IMAGE_MODEL
      try {
        imageDescHandler(result.runtime, "https://example.com/image.jpg");
      } catch (_err) {
        // We expect an error since we're not making a real API call
        // We just want to verify getSetting was called
      }

      // Verify getSetting was called with OPENROUTER_IMAGE_MODEL
      expect(getSpy).toHaveBeenCalledWith("OPENROUTER_IMAGE_MODEL");
    }
  });

  test("should have TEXT_EMBEDDING model registered", () => {
    const { models } = openrouterPlugin;
    expect(models).toBeDefined();
    if (!models) return;
    expect(models).toHaveProperty("TEXT_EMBEDDING");
    expect(typeof models.TEXT_EMBEDDING).toBe("function");
  });

  test("should use default embedding model", async () => {
    const result = await createTestRuntime({
      OPENROUTER_API_KEY: "test-api-key",
    });
    cleanup = result.cleanup;

    // Create spy to access getSetting calls
    const getSpy = vi.spyOn(result.runtime, "getSetting");

    if (openrouterPlugin.models?.TEXT_EMBEDDING) {
      const embeddingHandler = openrouterPlugin.models.TEXT_EMBEDDING;

      // Call with null to trigger the test embedding path (no API call)
      try {
        embeddingHandler(result.runtime, null);
      } catch (_err) {
        // Ignore errors, we just want to verify config access
      }

      // Verify getSetting was called with OPENROUTER_EMBEDDING_MODEL or EMBEDDING_MODEL
      const calls = getSpy.mock.calls.map((call) => call[0]);
      expect(
        calls.some(
          (call) =>
            call === "OPENROUTER_EMBEDDING_MODEL" ||
            call === "EMBEDDING_MODEL" ||
            call === "OPENROUTER_EMBEDDING_DIMENSIONS" ||
            call === "EMBEDDING_DIMENSIONS"
        )
      ).toBe(true);
    }
  });
});
