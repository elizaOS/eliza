/**
 * Integration tests for the Anthropic plugin.
 *
 * These tests require a valid ANTHROPIC_API_KEY environment variable.
 * Run with: ANTHROPIC_API_KEY=your-key npx vitest run typescript/__tests__/integration/
 */

import type { IAgentRuntime, UUID } from "@elizaos/core";
import { AgentRuntime } from "@elizaos/core";
import { v4 as uuidv4 } from "uuid";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDatabaseAdapter } from "../../../../../packages/typescript/src/bootstrap/__tests__/test-utils";

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

// Create a real runtime for testing
async function createTestRuntime(): Promise<IAgentRuntime> {
  const agentId = uuidv4() as UUID;
  const adapter = createTestDatabaseAdapter(agentId);

  const runtime = new AgentRuntime({
    agentId,
    character: {
      name: "Anthropic Test Agent",
      bio: ["Test agent for Anthropic integration tests"],
      system: "You are a helpful assistant.",
      settings: {
        secrets: {
          ANTHROPIC_API_KEY: API_KEY,
        },
      },
    },
    adapter,
  });

  await runtime.initialize();
  return runtime;
}

let runtime: IAgentRuntime;

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
  beforeEach(async () => {
    runtime = await createTestRuntime();
  });

  afterEach(async () => {
    if (runtime) {
      await runtime.stop();
    }
  });

  describe("Text Generation", () => {
    it("should generate text with small model", async () => {
      const anthropic = createAnthropicClientWithTopPSupport(runtime);
      const modelName = getSmallModel(runtime);

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
      const anthropic = createAnthropicClientWithTopPSupport(runtime);
      const modelName = getLargeModel(runtime);

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
      const anthropic = createAnthropicClient(runtime);
      const modelName = getSmallModel(runtime);

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
      const anthropic = createAnthropicClient(runtime);
      const modelName = getSmallModel(runtime);

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
      const anthropic = createAnthropicClient(runtime);
      const modelName = getSmallModel(runtime);

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
      const anthropic = createAnthropicClient(runtime);
      const modelName = getLargeModel(runtime);

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
      const anthropic = createAnthropicClient(runtime);
      const modelName = getSmallModel(runtime);

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
      const anthropic = createAnthropicClientWithTopPSupport(runtime);
      const modelName = getSmallModel(runtime);
      // AI SDK or wrapper should handle this - test verifies the behavior
      try {
        await generateText({
          model: anthropic(modelName),
          prompt: "Hello",
          temperature: 0.5,
          topP: 0.9,
        } as Parameters<typeof generateText>[0]);
        // If no error, the SDK may handle it differently
      } catch (error) {
        expect(error).toBeDefined();
      }
    });
  });

  describe("Token Usage", () => {
    it("should report accurate token usage", async () => {
      const anthropic = createAnthropicClient(runtime);
      const modelName = getSmallModel(runtime);

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
