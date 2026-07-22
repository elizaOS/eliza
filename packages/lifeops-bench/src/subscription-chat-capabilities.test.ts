/**
 * Pins the Claude-subscription plugin profile to its supported capabilities,
 * including lifecycle-only native structured capture and exact TASKS schema.
 * Tests are deterministic and never contact the subscription gateway.
 */

import { createHash } from "node:crypto";
import {
  type GenerateTextParams,
  type IAgentRuntime,
  ModelType,
  type Plugin,
} from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { LIFECYCLE_TASKS_TOOL_CONTRACT } from "./lifecycle-task-action";
import {
  assertClaudeSubscriptionModelRegistry,
  CLAUDE_SUBSCRIPTION_MODEL_TYPES,
  claudeSubscriptionChatOnlyPlugin,
  LIFECYCLE_STRUCTURED_RESPONSE_TOOL_NAME,
} from "./subscription-chat-capabilities";

async function* emptyTextStream(): AsyncGenerator<string> {
  yield* [];
}

function sourcePluginWithResponseHandler(
  responseHandler: (
    runtime: IAgentRuntime,
    params: GenerateTextParams,
  ) => Promise<string | ReturnType<typeof structuredToolResult>>,
  actionPlannerHandler: (
    runtime: IAgentRuntime,
    params: GenerateTextParams,
  ) => Promise<string | ReturnType<typeof structuredToolResult>> = async () =>
    "action plan",
): Plugin {
  return {
    name: "openai",
    description: "OpenAI-compatible provider",
    models: {
      [ModelType.TEXT_TOKENIZER_ENCODE]: async () => [1, 2, 3],
      [ModelType.TEXT_TOKENIZER_DECODE]: async () => "decoded",
      [ModelType.TEXT_NANO]: async () => "nano reply",
      [ModelType.TEXT_SMALL]: async () => "small reply",
      [ModelType.TEXT_MEDIUM]: async () => "medium reply",
      [ModelType.TEXT_LARGE]: async () => "chat reply",
      [ModelType.TEXT_MEGA]: async () => "mega reply",
      [ModelType.RESPONSE_HANDLER]: responseHandler,
      [ModelType.ACTION_PLANNER]: actionPlannerHandler,
    },
  };
}

function structuredToolResult(toolCalls: unknown) {
  return {
    textStream: emptyTextStream(),
    text: Promise.resolve(""),
    usage: Promise.resolve(undefined),
    finishReason: Promise.resolve("tool_calls"),
    toolCalls,
  };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

describe("claudeSubscriptionChatOnlyPlugin", () => {
  it("keeps chat models while removing embeddings and plugin initialization", () => {
    const init = vi.fn();
    const source: Plugin = {
      name: "openai",
      description: "OpenAI-compatible provider",
      init,
      models: {
        [ModelType.TEXT_TOKENIZER_ENCODE]: async () => [1, 2, 3],
        [ModelType.TEXT_TOKENIZER_DECODE]: async () => "decoded",
        [ModelType.TEXT_NANO]: async () => "nano reply",
        [ModelType.TEXT_SMALL]: async () => "small reply",
        [ModelType.TEXT_MEDIUM]: async () => "medium reply",
        [ModelType.TEXT_LARGE]: async () => "chat reply",
        [ModelType.TEXT_MEGA]: async () => "mega reply",
        [ModelType.RESPONSE_HANDLER]: async () => "response",
        [ModelType.ACTION_PLANNER]: async () => "action plan",
        [ModelType.TEXT_EMBEDDING]: async () => [0.25, -0.5],
      },
      tests: [{ name: "provider tests", tests: [] }],
    };

    const restricted = claudeSubscriptionChatOnlyPlugin(source);

    expect(restricted.name).toBe("openai");
    expect(Object.keys(restricted.models ?? {}).sort()).toEqual(
      [...CLAUDE_SUBSCRIPTION_MODEL_TYPES].sort(),
    );
    expect(restricted.models?.[ModelType.TEXT_EMBEDDING]).toBeUndefined();
    expect(restricted.init).toBeUndefined();
    expect(restricted.tests).toBeUndefined();
    expect(init).not.toHaveBeenCalled();
  });

  it("fails before startup when the source plugin lacks a retained handler", () => {
    const source: Plugin = {
      name: "incomplete-openai",
      description: "Missing model handlers",
      models: {
        [ModelType.TEXT_LARGE]: async () => "reply",
      },
    };

    expect(() => claudeSubscriptionChatOnlyPlugin(source)).toThrow(
      "missing required Claude-subscription handler",
    );
  });

  it("requires one OpenAI-compatible provider for every retained model type", () => {
    const registry = new Map(
      CLAUDE_SUBSCRIPTION_MODEL_TYPES.map((modelType) => [
        modelType,
        [{ provider: "openai" }],
      ]),
    );

    expect(() => assertClaudeSubscriptionModelRegistry(registry)).not.toThrow();

    registry.set(ModelType.TEXT_LARGE, [
      { provider: "openai" },
      { provider: "openrouter" },
    ]);
    expect(() => assertClaudeSubscriptionModelRegistry(registry)).toThrow(
      "requires exactly one openai handler for TEXT_LARGE",
    );
  });

  it("rejects missing, wrong-provider, and unsupported model handlers", () => {
    const validRegistry = (): Map<string, Array<{ provider: string }>> =>
      new Map<string, Array<{ provider: string }>>(
        CLAUDE_SUBSCRIPTION_MODEL_TYPES.map((modelType) => [
          modelType,
          [{ provider: "openai" }],
        ]),
      );

    const missing = validRegistry();
    missing.delete(ModelType.ACTION_PLANNER);
    expect(() => assertClaudeSubscriptionModelRegistry(missing)).toThrow(
      "requires exactly one openai handler for ACTION_PLANNER",
    );

    const wrongProvider = validRegistry();
    wrongProvider.set(ModelType.RESPONSE_HANDLER, [{ provider: "anthropic" }]);
    expect(() => assertClaudeSubscriptionModelRegistry(wrongProvider)).toThrow(
      "requires exactly one openai handler for RESPONSE_HANDLER",
    );

    const unsupported = validRegistry();
    unsupported.set(ModelType.TEXT_EMBEDDING, [{ provider: "openai" }]);
    expect(() => assertClaudeSubscriptionModelRegistry(unsupported)).toThrow(
      "registered unsupported model types",
    );
  });

  it("routes lifecycle evaluator schemas through one forced native capture tool", async () => {
    const evaluatorArguments = {
      success: true,
      decision: "FINISH",
      thought: "The lifecycle request was captured without side effects.",
      messageToUser: "The delegation request was captured.",
    };
    const responseHandler = vi.fn(
      async (_runtime: IAgentRuntime, _params: GenerateTextParams) =>
        structuredToolResult([
          {
            toolCallId: "call_evaluator",
            toolName: LIFECYCLE_STRUCTURED_RESPONSE_TOOL_NAME,
            input: evaluatorArguments,
          },
        ]),
    );
    const restricted = claudeSubscriptionChatOnlyPlugin(
      sourcePluginWithResponseHandler(responseHandler),
      { lifecycleStructuredResponseTool: true },
    );
    const responseSchema = {
      type: "object",
      additionalProperties: false,
      properties: {
        success: { type: "boolean" },
        decision: { type: "string", enum: ["FINISH", "CONTINUE"] },
        thought: { type: "string" },
        messageToUser: { type: "string" },
      },
      required: ["success", "decision", "thought"],
    };
    const providerOptions = {
      openai: { reasoningEffort: "medium" },
    };

    const result = await restricted.models?.[ModelType.RESPONSE_HANDLER]?.(
      {} as IAgentRuntime,
      {
        messages: [{ role: "user", content: "Evaluate the captured task." }],
        responseSchema,
        providerOptions,
        temperature: 0,
        maxTokens: 1024,
      },
    );

    expect(JSON.parse(String(result))).toEqual(evaluatorArguments);
    expect(responseHandler).toHaveBeenCalledTimes(1);
    const forwarded = responseHandler.mock.calls[0]?.[1];
    expect(forwarded).not.toHaveProperty("responseSchema");
    expect(forwarded?.toolChoice).toBe("required");
    expect(forwarded?.providerOptions).toBe(providerOptions);
    expect(forwarded?.temperature).toBe(0);
    expect(forwarded?.maxTokens).toBe(1024);
    expect(forwarded?.tools).toEqual([
      {
        name: LIFECYCLE_STRUCTURED_RESPONSE_TOOL_NAME,
        description:
          "Return the structured response required by the calling Eliza runtime.",
        parameters: responseSchema,
        strict: false,
      },
    ]);
  });

  it("pins lifecycle TASKS to the shared optional-field wire contract", async () => {
    const actionPlannerHandler = vi.fn(
      async (_runtime: IAgentRuntime, _params: GenerateTextParams) => "planned",
    );
    const restricted = claudeSubscriptionChatOnlyPlugin(
      sourcePluginWithResponseHandler(
        async () => "response",
        actionPlannerHandler,
      ),
      {
        lifecycleTasksToolSchema:
          LIFECYCLE_TASKS_TOOL_CONTRACT.function.parameters,
      },
    );
    const providerOptions = {
      openai: { reasoningEffort: "medium" },
    };

    await restricted.models?.[ModelType.ACTION_PLANNER]?.({} as IAgentRuntime, {
      prompt: "delegate",
      providerOptions,
      temperature: 0,
      maxTokens: 2048,
      tools: [
        {
          name: "TASKS",
          description: LIFECYCLE_TASKS_TOOL_CONTRACT.function.description,
          parameters: {
            type: "object",
            properties: { action: { type: "string" } },
            required: ["action"],
            additionalProperties: false,
          },
          strict: true,
        },
        {
          name: "REPLY",
          description: "Reply to the user.",
          parameters: { type: "object" },
          strict: true,
        },
      ],
    });

    expect(actionPlannerHandler).toHaveBeenCalledTimes(1);
    const forwarded = actionPlannerHandler.mock.calls[0]?.[1];
    const tasks = forwarded?.tools?.find((tool) => tool.name === "TASKS");
    expect(forwarded?.providerOptions).toBe(providerOptions);
    expect(forwarded?.temperature).toBe(0);
    expect(forwarded?.maxTokens).toBe(2048);
    expect(tasks?.strict).toBe(false);
    expect(tasks?.parameters).toEqual(
      LIFECYCLE_TASKS_TOOL_CONTRACT.function.parameters,
    );
    expect(tasks?.parameters?.required).toEqual(["action"]);
    const normalizedGatewayTool = [
      {
        type: "function",
        function: {
          name: tasks?.name,
          description: tasks?.description,
          parameters: tasks?.parameters,
        },
      },
    ];
    expect(
      createHash("sha256")
        .update(canonicalJson(normalizedGatewayTool), "utf8")
        .digest("hex"),
    ).toBe("5e61574cc504c156aefc47cde293a031d1a2301daa10b1664bf3902c42c05535");
    expect(
      forwarded?.tools?.find((tool) => tool.name === "REPLY")?.strict,
    ).toBe(true);
  });

  it.each([
    { label: "missing calls", result: structuredToolResult(undefined) },
    { label: "empty calls", result: structuredToolResult([]) },
    {
      label: "wrong tool",
      result: structuredToolResult([
        { toolName: "NOT_HANDLE_RESPONSE", input: { success: true } },
      ]),
    },
    {
      label: "malformed arguments",
      result: structuredToolResult([
        {
          name: LIFECYCLE_STRUCTURED_RESPONSE_TOOL_NAME,
          arguments: "{not-json",
        },
      ]),
    },
  ])("fails closed on $label from the lifecycle structured stage", async ({
    result,
  }) => {
    const responseHandler = vi.fn(
      async (_runtime: IAgentRuntime, _params: GenerateTextParams) => result,
    );
    const restricted = claudeSubscriptionChatOnlyPlugin(
      sourcePluginWithResponseHandler(responseHandler),
      { lifecycleStructuredResponseTool: true },
    );

    await expect(
      restricted.models?.[ModelType.RESPONSE_HANDLER]?.({} as IAgentRuntime, {
        prompt: "evaluate",
        responseSchema: { type: "object" },
      }),
    ).rejects.toMatchObject({
      code: "BENCHMARK_LIFECYCLE_STRUCTURED_RESPONSE_INVALID",
    });
    expect(responseHandler).toHaveBeenCalledTimes(1);
  });
});
