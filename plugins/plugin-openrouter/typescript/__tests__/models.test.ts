import type { IAgentRuntime } from "@elizaos/core";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
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
    name: "Test Assistant",
    bio: ["A test assistant for testing purposes"],
    system: "You are a helpful assistant.",
    plugins: [],
    settings: {},
    secrets: {
      ...settings,
      OPENROUTER_API_KEY: settings.OPENROUTER_API_KEY || process.env.OPENROUTER_API_KEY,
    },
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

describe("OpenRouter Plugin", () => {
  let runtime: IAgentRuntime;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    const result = await createTestRuntime();
    runtime = result.runtime;
    cleanup = result.cleanup;

    // Initialize plugin
    if (openrouterPlugin.init) {
      await openrouterPlugin.init({}, runtime);
    }
  });

  afterAll(async () => {
    if (cleanup) {
      await cleanup();
    }
  });

  describe("TEXT_SMALL Model", () => {
    test("should generate text with TEXT_SMALL model", async () => {
      if (!process.env.OPENROUTER_API_KEY) {
        console.warn("Skipping test: OPENROUTER_API_KEY not set");
        return;
      }

      const prompt = "Hello, how are you today?";

      if (openrouterPlugin.models?.TEXT_SMALL) {
        const textHandler = openrouterPlugin.models.TEXT_SMALL;
        const response = await textHandler(runtime, { prompt });

        expect(response).toBeDefined();
        expect(typeof response).toBe("string");
        expect(response.length).toBeGreaterThan(0);
      } else {
        console.warn("TEXT_SMALL model not available");
      }
    }, 30000);
  });

  describe("TEXT_LARGE Model", () => {
    test("should generate text with TEXT_LARGE model", async () => {
      if (!process.env.OPENROUTER_API_KEY) {
        console.warn("Skipping test: OPENROUTER_API_KEY not set");
        return;
      }

      const prompt = "Explain quantum computing in simple terms.";

      if (openrouterPlugin.models?.TEXT_LARGE) {
        const textHandler = openrouterPlugin.models.TEXT_LARGE;
        const response = await textHandler(runtime, { prompt });

        expect(response).toBeDefined();
        expect(typeof response).toBe("string");
        expect(response.length).toBeGreaterThan(0);
      } else {
        console.warn("TEXT_LARGE model not available");
      }
    }, 30000);
  });

  describe("OBJECT_SMALL Model", () => {
    test("should generate JSON with OBJECT_SMALL model", async () => {
      if (!process.env.OPENROUTER_API_KEY) {
        console.warn("Skipping test: OPENROUTER_API_KEY not set");
        return;
      }

      const prompt = "Create a JSON object representing a person with name, age, and hobbies.";

      if (openrouterPlugin.models?.OBJECT_SMALL) {
        const objectHandler = openrouterPlugin.models.OBJECT_SMALL;
        const response = await objectHandler(runtime, { prompt });

        expect(response).toBeDefined();
        expect(typeof response).toBe("object");
        expect(response).not.toBeNull();
      } else {
        console.warn("OBJECT_SMALL model not available");
      }
    }, 30000);
  });

  describe("OBJECT_LARGE Model", () => {
    test("should generate JSON with OBJECT_LARGE model", async () => {
      if (!process.env.OPENROUTER_API_KEY) {
        console.warn("Skipping test: OPENROUTER_API_KEY not set");
        return;
      }

      const prompt = "Create a detailed JSON object representing a complex product catalog.";

      if (openrouterPlugin.models?.OBJECT_LARGE) {
        const objectHandler = openrouterPlugin.models.OBJECT_LARGE;
        const response = await objectHandler(runtime, { prompt });

        expect(response).toBeDefined();
        expect(typeof response).toBe("object");
        expect(response).not.toBeNull();
      } else {
        console.warn("OBJECT_LARGE model not available");
      }
    }, 500000);
  });

  describe("IMAGE_DESCRIPTION Model", () => {
    test("should describe an image with IMAGE_DESCRIPTION model", async () => {
      if (!process.env.OPENROUTER_API_KEY) {
        console.warn("Skipping test: OPENROUTER_API_KEY not set");
        return;
      }

      // Use a public domain test image
      const imageUrl =
        "https://upload.wikimedia.org/wikipedia/commons/thumb/9/9a/Gull_portrait_ca_usa.jpg/1280px-Gull_portrait_ca_usa.jpg";

      if (openrouterPlugin.models?.IMAGE_DESCRIPTION) {
        const imageDescHandler = openrouterPlugin.models.IMAGE_DESCRIPTION;
        const response = await imageDescHandler(runtime, imageUrl);

        expect(response).toBeDefined();
        expect(response).toHaveProperty("title");
        expect(response).toHaveProperty("description");
        expect(typeof response.title).toBe("string");
        expect(typeof response.description).toBe("string");
        expect(response.title.length).toBeGreaterThan(0);
        expect(response.description.length).toBeGreaterThan(0);
      } else {
        console.warn("IMAGE_DESCRIPTION model not available");
      }
    }, 500000);

    test("should describe an image with custom prompt", async () => {
      if (!process.env.OPENROUTER_API_KEY) {
        console.warn("Skipping test: OPENROUTER_API_KEY not set");
        return;
      }

      const imageUrl =
        "https://upload.wikimedia.org/wikipedia/commons/thumb/9/9a/Gull_portrait_ca_usa.jpg/1280px-Gull_portrait_ca_usa.jpg";
      const customPrompt =
        "Identify the species of bird in this image and provide detailed characteristics.";

      if (openrouterPlugin.models?.IMAGE_DESCRIPTION) {
        const imageDescHandler = openrouterPlugin.models.IMAGE_DESCRIPTION;
        const response = await imageDescHandler(runtime, {
          imageUrl,
          prompt: customPrompt,
        });

        expect(response).toBeDefined();
        expect(response).toHaveProperty("title");
        expect(response).toHaveProperty("description");
        expect(typeof response.title).toBe("string");
        expect(typeof response.description).toBe("string");
        expect(response.title.length).toBeGreaterThan(0);
        expect(response.description.length).toBeGreaterThan(0);
      } else {
        console.warn("IMAGE_DESCRIPTION model not available");
      }
    }, 500000);
  });

  describe("TEXT_EMBEDDING Model", () => {
    test("should generate embeddings with TEXT_EMBEDDING model", async () => {
      if (!process.env.OPENROUTER_API_KEY) {
        console.warn("Skipping test: OPENROUTER_API_KEY not set");
        return;
      }

      const text = "Hello, this is a test for embeddings.";

      if (openrouterPlugin.models?.TEXT_EMBEDDING) {
        const embeddingHandler = openrouterPlugin.models.TEXT_EMBEDDING;
        const embedding = await embeddingHandler(runtime, { text });

        expect(embedding).toBeDefined();
        expect(Array.isArray(embedding)).toBe(true);
        expect(embedding.length).toBeGreaterThan(0);
        expect(typeof embedding[0]).toBe("number");
      } else {
        console.warn("TEXT_EMBEDDING model not available");
      }
    }, 30000);

    test("should handle string input for embeddings", async () => {
      if (!process.env.OPENROUTER_API_KEY) {
        console.warn("Skipping test: OPENROUTER_API_KEY not set");
        return;
      }

      const text = "Testing string input for embeddings.";

      if (openrouterPlugin.models?.TEXT_EMBEDDING) {
        const embeddingHandler = openrouterPlugin.models.TEXT_EMBEDDING;
        const embedding = await embeddingHandler(runtime, text);

        expect(embedding).toBeDefined();
        expect(Array.isArray(embedding)).toBe(true);
        expect(embedding.length).toBeGreaterThan(0);
        expect(typeof embedding[0]).toBe("number");
      } else {
        console.warn("TEXT_EMBEDDING model not available");
      }
    }, 30000);

    test("should return test vector for null input", async () => {
      if (openrouterPlugin.models?.TEXT_EMBEDDING) {
        const embeddingHandler = openrouterPlugin.models.TEXT_EMBEDDING;
        const embedding = await embeddingHandler(runtime, null);

        expect(embedding).toBeDefined();
        expect(Array.isArray(embedding)).toBe(true);
        expect(embedding.length).toBeGreaterThan(0);
        expect(embedding[0]).toBe(0.1); // Test vector marker
      } else {
        console.warn("TEXT_EMBEDDING model not available");
      }
    });
  });
});
