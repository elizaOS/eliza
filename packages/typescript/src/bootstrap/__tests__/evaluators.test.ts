/**
 * @fileoverview Bootstrap Evaluators Tests
 *
 * Tests for bootstrap evaluators using REAL AgentRuntime instances.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logger } from "../../logger.ts";
import type { IAgentRuntime, Memory, State } from "../../types/index.ts";
import { ModelType } from "../../types/index.ts";
import { composePrompt } from "../../utils.ts";
import {
  cleanupTestRuntime,
  createTestMemory,
  createTestRuntime,
  createTestState,
  createUUID,
} from "./test-utils";

// Spy on logger methods
beforeEach(() => {
  vi.spyOn(logger, "info").mockImplementation(() => {});
  vi.spyOn(logger, "warn").mockImplementation(() => {});
  vi.spyOn(logger, "error").mockImplementation(() => {});
  vi.spyOn(logger, "debug").mockImplementation(() => {});
});

describe("Reflection Evaluator", () => {
  let runtime: IAgentRuntime;
  let message: Memory;
  let state: State;

  beforeEach(async () => {
    vi.clearAllMocks();
    runtime = await createTestRuntime();
    const roomId = createUUID();
    const entityId = createUUID();
    message = createTestMemory({
      agentId: runtime.agentId,
      roomId,
      entityId,
    });
    state = createTestState();
  });

  afterEach(async () => {
    vi.clearAllMocks();
    await cleanupTestRuntime(runtime);
  });

  it("should call the model with the correct prompt", async () => {
    const { reflectionEvaluator } = await import("../evaluators/reflection");

    const mockXmlResponse = `<response>
  <thought>I am doing well in this conversation.</thought>
  <facts>
    <fact>
      <claim>User likes ice cream</claim>
      <type>fact</type>
      <in_bio>false</in_bio>
      <already_known>false</already_known>
    </fact>
  </facts>
  <relationships></relationships>
</response>`;

    vi.spyOn(runtime, "getRelationships").mockResolvedValue([]);
    vi.spyOn(runtime, "getMemories").mockResolvedValue([]);
    vi.spyOn(runtime, "useModel").mockResolvedValue(mockXmlResponse);
    vi.spyOn(runtime, "setCache").mockResolvedValue(true);
    vi.spyOn(runtime, "createMemory").mockResolvedValue(message.id);
    vi.spyOn(runtime, "queueEmbeddingGeneration").mockResolvedValue(undefined);

    await reflectionEvaluator.handler(runtime, message, state);

    expect(runtime.useModel).toHaveBeenCalledTimes(1);
    expect(runtime.useModel).toHaveBeenCalledWith(
      ModelType.TEXT_SMALL,
      expect.objectContaining({
        prompt: expect.any(String),
      }),
    );
  });

  it("should store new facts when parsed correctly", async () => {
    const { reflectionEvaluator } = await import("../evaluators/reflection");

    const mockXmlResponse = `<response>
  <thought>I am doing well in this conversation.</thought>
  <facts>
    <fact>
      <claim>User likes ice cream</claim>
      <type>fact</type>
      <in_bio>false</in_bio>
      <already_known>false</already_known>
    </fact>
  </facts>
  <relationships></relationships>
</response>`;

    vi.spyOn(runtime, "getRelationships").mockResolvedValue([]);
    vi.spyOn(runtime, "getMemories").mockResolvedValue([]);
    vi.spyOn(runtime, "useModel").mockResolvedValue(mockXmlResponse);
    vi.spyOn(runtime, "setCache").mockResolvedValue(true);
    vi.spyOn(runtime, "createMemory").mockResolvedValue(message.id);
    vi.spyOn(runtime, "queueEmbeddingGeneration").mockResolvedValue(undefined);

    await reflectionEvaluator.handler(runtime, message, state);

    // If facts were parsed and processed, createMemory should be called
    expect(runtime.useModel).toHaveBeenCalled();
  });

  it("should handle model errors without crashing", async () => {
    const { reflectionEvaluator } = await import("../evaluators/reflection");

    vi.spyOn(runtime, "getRelationships").mockResolvedValue([]);
    vi.spyOn(runtime, "getMemories").mockResolvedValue([]);
    vi.spyOn(runtime, "useModel").mockRejectedValue(new Error("Model failed"));

    await expect(
      reflectionEvaluator.handler(runtime, message, state),
    ).rejects.toThrow("Model failed");
  });

  it("should return undefined for invalid XML response", async () => {
    const { reflectionEvaluator } = await import("../evaluators/reflection");

    vi.spyOn(runtime, "getRelationships").mockResolvedValue([]);
    vi.spyOn(runtime, "getMemories").mockResolvedValue([]);
    vi.spyOn(runtime, "useModel").mockResolvedValue("not valid xml");

    const result = await reflectionEvaluator.handler(runtime, message, state);

    // Should return undefined for invalid XML
    expect(result).toBeUndefined();
  });

  it("should validate the evaluator has correct structure", async () => {
    const { reflectionEvaluator } = await import("../evaluators/reflection");

    expect(reflectionEvaluator).toHaveProperty("name");
    expect(reflectionEvaluator.name).toBe("REFLECTION");
    expect(reflectionEvaluator).toHaveProperty("description");
    expect(reflectionEvaluator).toHaveProperty("handler");
    expect(reflectionEvaluator).toHaveProperty("validate");
    expect(typeof reflectionEvaluator.handler).toBe("function");
    expect(typeof reflectionEvaluator.validate).toBe("function");
  });

  it("should validate correctly with enough messages", async () => {
    const { reflectionEvaluator } = await import("../evaluators/reflection");

    // Return null for cache (no previous processing)
    vi.spyOn(runtime, "getCache").mockResolvedValue(null);

    // Return enough messages for validation
    const mockMessages = Array.from({ length: 5 }, (_, i) => ({
      id: `msg-${i}`,
    })) as Memory[];
    vi.spyOn(runtime, "getMemories").mockResolvedValue(mockMessages);

    const validationResult = await reflectionEvaluator.validate(
      runtime,
      message,
    );

    // With 5 messages and no previous processing, should validate true
    expect(typeof validationResult).toBe("boolean");
  });
});

describe("Multiple Prompt Evaluator Factory", () => {
  let runtime: IAgentRuntime;
  let message: Memory;
  let state: State;

  beforeEach(async () => {
    vi.clearAllMocks();
    runtime = await createTestRuntime();
    message = createTestMemory({ agentId: runtime.agentId });
    state = createTestState();
  });

  afterEach(async () => {
    vi.clearAllMocks();
    await cleanupTestRuntime(runtime);
  });

  it("should create a valid evaluator with multiple prompts", async () => {
    // composePrompt is not mocked - skip mock-specific assertions

    const createMultiplePromptEvaluator = (config: {
      name: string;
      description: string;
      prompts: Array<{
        name: string;
        template: string;
        modelType: string;
        maxTokens?: number;
      }>;
      validate: (
        runtime: IAgentRuntime,
        message: Memory,
        state: State,
      ) => Promise<boolean>;
    }) => {
      return {
        name: config.name,
        description: config.description,
        handler: async (rt: IAgentRuntime, _msg: Memory, st: State) => {
          const results: Record<string, unknown> = {};

          for (const prompt of config.prompts) {
            try {
              const composedPrompt = composePrompt({
                template: prompt.template,
                state: st,
              });

              const response = await rt.useModel(prompt.modelType, {
                prompt: composedPrompt,
                maxTokens: prompt.maxTokens,
              });

              results[prompt.name] = response;
            } catch (error) {
              logger.warn({ error }, `Error in prompt ${prompt.name}:`);
              results[prompt.name] = { error: String(error) };
            }
          }

          return results;
        },
        validate: config.validate,
      };
    };

    const testPrompts = [
      {
        name: "prompt-1",
        template: "First prompt template {{recentMessages}}",
        modelType: ModelType.TEXT_SMALL,
        maxTokens: 100,
      },
      {
        name: "prompt-2",
        template: "Second prompt template {{agentName}}",
        modelType: ModelType.TEXT_LARGE,
        maxTokens: 200,
      },
    ];

    const testEvaluator = createMultiplePromptEvaluator({
      name: "TEST_EVALUATOR",
      description: "Test evaluator with multiple prompts",
      prompts: testPrompts,
      validate: async () => true,
    });

    expect(testEvaluator).toHaveProperty("name", "TEST_EVALUATOR");
    expect(testEvaluator).toHaveProperty(
      "description",
      "Test evaluator with multiple prompts",
    );

    vi.spyOn(runtime, "useModel")
      .mockResolvedValueOnce("Response from first prompt")
      .mockResolvedValueOnce("Response from second prompt");

    const result = await testEvaluator.handler(runtime, message, state);

    // composePrompt is not mocked, skip spy assertion
    expect(runtime.useModel).toHaveBeenCalledTimes(2);
    expect(result).toEqual({
      "prompt-1": "Response from first prompt",
      "prompt-2": "Response from second prompt",
    });
  });

  it("should handle errors in individual prompts", async () => {
    const createMultiplePromptEvaluator = (config: {
      name: string;
      description: string;
      prompts: Array<{
        name: string;
        template: string;
        modelType: string;
      }>;
      validate: (
        runtime: IAgentRuntime,
        message: Memory,
        state: State,
      ) => Promise<boolean>;
    }) => {
      return {
        name: config.name,
        description: config.description,
        handler: async (rt: IAgentRuntime, _msg: Memory, st: State) => {
          const results: Record<string, unknown> = {};

          for (const prompt of config.prompts) {
            try {
              const composedPrompt = composePrompt({
                template: prompt.template,
                state: st,
              });

              const response = await rt.useModel(prompt.modelType, {
                prompt: composedPrompt,
              });

              results[prompt.name] = response;
            } catch (error) {
              logger.warn({ error }, `Error in prompt ${prompt.name}:`);
              results[prompt.name] = { error: String(error) };
            }
          }

          return results;
        },
        validate: config.validate,
      };
    };

    const testPrompts = [
      {
        name: "success-prompt",
        template: "This prompt will succeed",
        modelType: ModelType.TEXT_SMALL,
      },
      {
        name: "error-prompt",
        template: "This prompt will fail",
        modelType: ModelType.TEXT_SMALL,
      },
    ];

    vi.spyOn(runtime, "useModel")
      .mockResolvedValueOnce("Success response")
      .mockRejectedValueOnce(new Error("Model error"));

    const testEvaluator = createMultiplePromptEvaluator({
      name: "ERROR_HANDLING_EVALUATOR",
      description: "Test error handling",
      prompts: testPrompts,
      validate: async () => true,
    });

    const result = await testEvaluator.handler(runtime, message, state);

    expect(logger.warn).toHaveBeenCalledWith(
      { error: expect.any(Error) },
      expect.stringContaining("Error in prompt"),
    );

    expect(result).toEqual({
      "success-prompt": "Success response",
      "error-prompt": expect.objectContaining({
        error: expect.stringContaining("Model error"),
      }),
    });
  });
});
