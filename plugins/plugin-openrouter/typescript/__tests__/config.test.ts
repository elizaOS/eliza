import type { IAgentRuntime } from "@elizaos/core";
import { logger } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { openrouterPlugin } from "../index";

async function createTestRuntime(settings: Record<string, string> = {}): Promise<{
  runtime: IAgentRuntime;
  cleanup: () => Promise<void>;
}> {
  const {
    createDatabaseAdapter,
    DatabaseMigrationService,
    plugin: sqlPluginInstance,
  } = await import("@elizaos/plugin-sql");
  const { AgentRuntime, createCharacter } = await import("@elizaos/core");
  const { v4: uuidv4 } = await import("uuid");

  const agentId = uuidv4() as `${string}-${string}-${string}-${string}-${string}`;

  // Create the adapter using the exported function with in-memory database
  const adapter = createDatabaseAdapter({ dataDir: "memory://" }, agentId);
  await adapter.init();

  // Run migrations to create the schema
  const migrationService = new DatabaseMigrationService();
  const db = (adapter as { getDatabase(): () => unknown }).getDatabase();
  await migrationService.initializeWithDatabase(db);
  migrationService.discoverAndRegisterPluginSchemas([sqlPluginInstance]);
  await migrationService.runAllPluginMigrations();

  const character = createCharacter({
    name: "Test Agent",
    bio: ["A test agent"],
    system: "You are a helpful assistant.",
    plugins: [],
    settings: {},
    secrets: settings,
    messageExamples: [],
    postExamples: [],
    topics: ["testing"],
    adjectives: ["helpful"],
    style: { all: [], chat: [], post: [] },
  });

  // Create the agent in the database first
  await adapter.createAgent({
    id: agentId,
    ...character,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });

  const runtime = new AgentRuntime({
    agentId,
    character,
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

// Create a simple mock runtime for tests that don't need database
function createMockRuntime(settings: Record<string, string> = {}): IAgentRuntime {
  return {
    getSetting: vi.fn((key: string) => settings[key] || null),
    agentId: "test-agent-id" as `${string}-${string}-${string}-${string}-${string}`,
    character: { name: "Test Agent" },
  } as unknown as IAgentRuntime;
}

describe("OpenRouter Plugin Configuration", () => {
  let cleanup: () => Promise<void> = async () => {};

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanup();
    cleanup = async () => {};
  });

  test("should warn when API key is missing", async () => {
    const originalApiKey = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;

    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});

    const result = await createTestRuntime({});
    cleanup = result.cleanup;

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

    // Plugin should initialize without errors
    expect(true).toBe(true);
  });

  test("should use custom image model when configured", async () => {
    const customImageModel = "anthropic/claude-3-opus-vision";
    const mockRuntime = createMockRuntime({
      OPENROUTER_IMAGE_MODEL: customImageModel,
      OPENROUTER_API_KEY: "test-api-key",
    });

    if (openrouterPlugin.models?.IMAGE_DESCRIPTION) {
      const imageDescHandler = openrouterPlugin.models.IMAGE_DESCRIPTION;

      try {
        await imageDescHandler(mockRuntime, "https://example.com/image.jpg");
      } catch (_err) {
        // Expected error - not making real API call
      }

      expect(mockRuntime.getSetting).toHaveBeenCalledWith("OPENROUTER_IMAGE_MODEL");
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
    const mockRuntime = createMockRuntime({
      OPENROUTER_API_KEY: "test-api-key",
    });

    if (openrouterPlugin.models?.TEXT_EMBEDDING) {
      const embeddingHandler = openrouterPlugin.models.TEXT_EMBEDDING;

      try {
        await embeddingHandler(mockRuntime, null);
      } catch (_err) {
        // Ignore errors
      }

      const getSetting = mockRuntime.getSetting as ReturnType<typeof vi.fn>;
      const calls = getSetting.mock.calls.map((call: string[]) => call[0]);
      expect(
        calls.some(
          (call: string) =>
            call === "OPENROUTER_EMBEDDING_MODEL" ||
            call === "EMBEDDING_MODEL" ||
            call === "OPENROUTER_EMBEDDING_DIMENSIONS" ||
            call === "EMBEDDING_DIMENSIONS"
        )
      ).toBe(true);
    }
  });
});
