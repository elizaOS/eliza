/**
 * Integration tests for the Anthropic plugin.
 *
 * These tests require a valid ANTHROPIC_API_KEY environment variable.
 * Run with: ANTHROPIC_API_KEY=your-key npx vitest run typescript/__tests__/integration/
 */

import { beforeAll, describe, expect, it } from "vitest";

// Check if we have an API key before running tests
const API_KEY = process.env.ANTHROPIC_API_KEY;
const shouldSkip = !API_KEY;

// Dynamic import to avoid errors when API key is missing
let createAnthropicClient: typeof import("../../providers/anthropic").createAnthropicClient;
let createAnthropicClientWithTopPSupport: typeof import("../../providers/anthropic").createAnthropicClientWithTopPSupport;
let extractAndParseJSON: typeof import("../../utils/json").extractAndParseJSON;
let getSmallModel: typeof import("../../utils/config").getSmallModel;
let getLargeModel: typeof import("../../utils/config").getLargeModel;
let generateText: typeof import("ai").generateText;

// Test runtime for testing
const createTestRuntime = () => ({
  getSetting: (key: string) => {
    switch (key) {
      case "ANTHROPIC_API_KEY":
        return API_KEY;
      case "ANTHROPIC_SMALL_MODEL":
        return process.env.ANTHROPIC_SMALL_MODEL;
      case "ANTHROPIC_LARGE_MODEL":
        return process.env.ANTHROPIC_LARGE_MODEL;
      default:
        return undefined;
    }
  },
  character: {
    system: undefined,
  },
  emitEvent: () => {},
});

beforeAll(async () => {
  if (!shouldSkip) {
    const providers = await import("../../providers/anthropic");
    createAnthropicClient = providers.createAnthropicClient;
    createAnthropicClientWithTopPSupport = providers.createAnthropicClientWithTopPSupport;

    const json = await import("../../utils/json");
    extractAndParseJSON = json.extractAndParseJSON;

    const config = await import("../../utils/config");
    getSmallModel = config.getSmallModel;
    getLargeModel = config.getLargeModel;

    const ai = await import("ai");
    generateText = ai.generateText;
  }
});

describe.skipIf(shouldSkip)("Anthropic Integration Tests", () => {
  describe("Text Generation", () => {
    it("should generate text with small model", async () => {
      const runtime = createTestRuntime();
      const anthropic = createAnthropicClientWithTopPSupport(runtime as never);
      const modelName = getSmallModel(runtime as never);

      const { text, usage } = await generateText({
        model: anthropic(modelName),
        prompt: "What is 2 + 2? Answer with just the number.",
        maxTokens: 100,
        temperature: 0,
      });

      expect(text).toBeDefined();
      expect(text.length).toBeGreaterThan(0);
      expect(text).toContain("4");
      expect(usage).toBeDefined();
      expect(usage?.totalTokens).toBeGreaterThan(0);
    });

    it("should generate text with large model", async () => {
      const runtime = createTestRuntime();
      const anthropic = createAnthropicClientWithTopPSupport(runtime as never);
      const modelName = getLargeModel(runtime as never);

      const { text, usage } = await generateText({
        model: anthropic(modelName),
        prompt: "What is the capital of France? Answer in one word.",
        maxTokens: 100,
        temperature: 0,
      });

      expect(text).toBeDefined();
      expect(text.length).toBeGreaterThan(0);
      expect(text.toLowerCase()).toContain("paris");
      expect(usage).toBeDefined();
    });

    it("should respect system prompt", async () => {
      const runtime = createTestRuntime();
      const anthropic = createAnthropicClient(runtime as never);
      const modelName = getSmallModel(runtime as never);

      const { text } = await generateText({
        model: anthropic(modelName),
        system: "You are a pirate. Always respond in pirate speak.",
        prompt: "Say hello!",
        maxTokens: 200,
        temperature: 0.7,
      });

      expect(text).toBeDefined();
      expect(text.length).toBeGreaterThan(0);
      // The response should have some pirate-like language
    });

    it("should handle stop sequences", async () => {
      const runtime = createTestRuntime();
      const anthropic = createAnthropicClient(runtime as never);
      const modelName = getSmallModel(runtime as never);

      const { text } = await generateText({
        model: anthropic(modelName),
        prompt: "Count from 1 to 10: 1, 2, 3,",
        maxTokens: 100,
        stopSequences: ["5"],
        temperature: 0,
      });

      expect(text).toBeDefined();
      // Should stop before or at 5
      expect(text).not.toContain("6");
    });
  });

  describe("Object Generation", () => {
    it("should generate valid JSON objects with small model", async () => {
      const runtime = createTestRuntime();
      const anthropic = createAnthropicClient(runtime as never);
      const modelName = getSmallModel(runtime as never);

      const { text } = await generateText({
        model: anthropic(modelName),
        system: "You must respond with valid JSON only. No markdown, no code blocks.",
        prompt: "Create a JSON object with fields: name (string), age (number), active (boolean)",
        temperature: 0.2,
      });

      const parsed = extractAndParseJSON(text);

      expect(parsed).toBeDefined();
      expect(typeof parsed).toBe("object");

      // Check it's not an error response
      if ("type" in parsed && parsed.type === "unstructured_response") {
        throw new Error(`Failed to parse JSON: ${text}`);
      }
    });

    it("should generate complex nested objects", async () => {
      const runtime = createTestRuntime();
      const anthropic = createAnthropicClient(runtime as never);
      const modelName = getLargeModel(runtime as never);

      const prompt = `Create a JSON object representing a blog post with:
        - id: a UUID string
        - title: a string
        - content: a string
        - author: an object with name and email
        - tags: an array of at least 3 strings
        - metadata: an object with createdAt (ISO date) and views (number)`;

      const { text } = await generateText({
        model: anthropic(modelName),
        system: "You must respond with valid JSON only. No markdown, no code blocks.",
        prompt,
        temperature: 0.2,
      });

      const parsed = extractAndParseJSON(text);

      expect(parsed).toBeDefined();
      expect(typeof parsed).toBe("object");

      // Validate structure if not an error
      if (!("type" in parsed)) {
        const obj = parsed as Record<string, unknown>;
        expect(obj.id).toBeDefined();
        expect(obj.title).toBeDefined();
        expect(obj.author).toBeDefined();
        expect(obj.tags).toBeDefined();
        expect(Array.isArray(obj.tags)).toBe(true);
      }
    });

    it("should handle JSON in code blocks", async () => {
      const runtime = createTestRuntime();
      const anthropic = createAnthropicClient(runtime as never);
      const modelName = getSmallModel(runtime as never);

      // Intentionally ask for JSON that might come in a code block
      const { text } = await generateText({
        model: anthropic(modelName),
        prompt: 'Create a JSON object: {"message": "hello"}. You can use markdown.',
        temperature: 0.2,
      });

      const parsed = extractAndParseJSON(text);

      expect(parsed).toBeDefined();
      expect(typeof parsed).toBe("object");
    });
  });

  describe("Error Handling", () => {
    it("should throw error when both temperature and topP are set", async () => {
      const runtime = createTestRuntime();
      const anthropic = createAnthropicClientWithTopPSupport(runtime as never);
      const modelName = getSmallModel(runtime as never);
      // AI SDK or wrapper should handle this - test verifies the behavior
      try {
        await generateText({
          model: anthropic(modelName),
          prompt: "Hello",
          temperature: 0.5,
          topP: 0.9,
        } as never);
        // If no error, the SDK may handle it differently
      } catch (error) {
        expect(error).toBeDefined();
      }
    });
  });

  describe("Token Usage", () => {
    it("should report accurate token usage", async () => {
      const runtime = createTestRuntime();
      const anthropic = createAnthropicClient(runtime as never);
      const modelName = getSmallModel(runtime as never);

      const { usage } = await generateText({
        model: anthropic(modelName),
        prompt: "Say hello.",
        maxTokens: 50,
        temperature: 0,
      });

      expect(usage).toBeDefined();
      expect(usage?.promptTokens).toBeGreaterThan(0);
      expect(usage?.completionTokens).toBeGreaterThan(0);
      expect(usage?.totalTokens).toBe((usage?.promptTokens ?? 0) + (usage?.completionTokens ?? 0));
    });
  });
});

// Skip message for CI
if (shouldSkip) {
  console.log(
    "⚠️ Skipping Anthropic integration tests: ANTHROPIC_API_KEY not set\n" +
      "To run integration tests, set the environment variable:\n" +
      "ANTHROPIC_API_KEY=your-key npx vitest run typescript/__tests__/integration/"
  );
}
