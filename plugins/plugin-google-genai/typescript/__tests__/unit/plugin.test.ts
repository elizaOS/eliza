import { describe, expect, it, vi } from "vitest";

// Mock @elizaos/core
vi.mock("@elizaos/core", () => ({
  logger: {
    log: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
  ModelType: {
    TEXT_SMALL: "TEXT_SMALL",
    TEXT_LARGE: "TEXT_LARGE",
    TEXT_EMBEDDING: "TEXT_EMBEDDING",
    IMAGE_DESCRIPTION: "IMAGE_DESCRIPTION",
    OBJECT_SMALL: "OBJECT_SMALL",
    OBJECT_LARGE: "OBJECT_LARGE",
  },
  EventType: {
    MODEL_USED: "MODEL_USED",
  },
}));

// Mock @google/genai
vi.mock("@google/genai", () => ({
  GoogleGenAI: vi.fn().mockImplementation(() => ({
    models: {
      list: vi.fn().mockReturnValue({
        [Symbol.asyncIterator]: async function* () {
          yield { name: "models/gemini-2.0-flash-001" };
        },
      }),
      generateContent: vi.fn().mockResolvedValue({
        text: "Test response",
      }),
      embedContent: vi.fn().mockResolvedValue({
        embeddings: [{ values: Array(768).fill(0.1) }],
      }),
    },
  })),
  HarmCategory: {
    HARM_CATEGORY_HARASSMENT: "HARM_CATEGORY_HARASSMENT",
    HARM_CATEGORY_HATE_SPEECH: "HARM_CATEGORY_HATE_SPEECH",
    HARM_CATEGORY_SEXUALLY_EXPLICIT: "HARM_CATEGORY_SEXUALLY_EXPLICIT",
    HARM_CATEGORY_DANGEROUS_CONTENT: "HARM_CATEGORY_DANGEROUS_CONTENT",
  },
  HarmBlockThreshold: {
    BLOCK_MEDIUM_AND_ABOVE: "BLOCK_MEDIUM_AND_ABOVE",
  },
}));

describe("Google GenAI Plugin", () => {
  describe("Plugin Definition", () => {
    it("should have correct plugin name", async () => {
      const { googleGenAIPlugin } = await import("../../index");
      expect(googleGenAIPlugin.name).toBe("google-genai");
    });

    it("should have plugin description", async () => {
      const { googleGenAIPlugin } = await import("../../index");
      expect(googleGenAIPlugin.description).toBeDefined();
      expect(googleGenAIPlugin.description.length).toBeGreaterThan(0);
    });

    it("should have models registered", async () => {
      const { googleGenAIPlugin } = await import("../../index");
      expect(googleGenAIPlugin.models).toBeDefined();
      expect(Object.keys(googleGenAIPlugin.models ?? {}).length).toBeGreaterThan(0);
    });

    it("should have test suites defined", async () => {
      const { googleGenAIPlugin } = await import("../../index");
      expect(googleGenAIPlugin.tests).toBeDefined();
      expect(googleGenAIPlugin.tests?.length).toBeGreaterThan(0);
    });
  });

  describe("Config", () => {
    it("should have config options defined", async () => {
      const { googleGenAIPlugin } = await import("../../index");
      expect(googleGenAIPlugin.config).toBeDefined();
      expect(googleGenAIPlugin.config?.GOOGLE_GENERATIVE_AI_API_KEY).toBeDefined;
    });
  });
});
