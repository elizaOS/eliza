import type { IAgentRuntime } from "@elizaos/core";
import { logger } from "@elizaos/core";
import * as undici from "undici";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { openrouterPlugin } from "../index";

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
    vi.restoreAllMocks();
    if (cleanup) {
      await cleanup();
    }
  });

  test("should warn when API key is missing", async () => {
    const originalApiKey = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;

    const result = await createTestRuntime({});
    cleanup = result.cleanup;

    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});

    if (openrouterPlugin.init) {
      await openrouterPlugin.init({}, result.runtime);
    }

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();

    if (originalApiKey) {
      process.env.OPENROUTER_API_KEY = originalApiKey;
    }
  });

  test("should initialize properly with valid API key", async () => {
    if (!process.env.OPENROUTER_API_KEY) {
      console.warn("Skipping test: OPENROUTER_API_KEY not set");
      return;
    }

    const result = await createTestRuntime({
      OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
    });
    cleanup = result.cleanup;

    if (openrouterPlugin.init) {
      await openrouterPlugin.init({}, result.runtime);
    }

    await new Promise((resolve) => setTimeout(resolve, 10));

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
    const customImageModel = "anthropic/claude-3-opus-vision";
    const result = await createTestRuntime({
      OPENROUTER_IMAGE_MODEL: customImageModel,
      OPENROUTER_API_KEY: "test-api-key",
    });
    cleanup = result.cleanup;

    const getSpy = vi.spyOn(result.runtime, "getSetting");

    if (openrouterPlugin.models?.IMAGE_DESCRIPTION) {
      const imageDescHandler = openrouterPlugin.models.IMAGE_DESCRIPTION;

      try {
        imageDescHandler(result.runtime, "https://example.com/image.jpg");
      } catch (_err) {
        // Expected error - not making real API call
      }

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

    const getSpy = vi.spyOn(result.runtime, "getSetting");

    if (openrouterPlugin.models?.TEXT_EMBEDDING) {
      const embeddingHandler = openrouterPlugin.models.TEXT_EMBEDDING;

      try {
        embeddingHandler(result.runtime, null);
      } catch (_err) {
        // Ignore errors
      }

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
