import { describe, expect, test } from "bun:test";
import { __nativeToolingTestHooks as chatHooks } from "@/apps/api/v1/chat/completions/route";
import { __nativeToolingTestHooks as gatewayHooks } from "@/lib/providers/vercel-ai-gateway";

describe("cloud native tool pass-through", () => {
  test("preserves OpenAI assistant tool calls and tool results for chat completions", () => {
    const messages = chatHooks.convertToModelMessagesFromOpenAI([
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "lookup", arguments: '{"query":"milady"}' },
          },
        ],
      },
      {
        role: "tool",
        content: "found",
        tool_call_id: "call_1",
      },
    ] as never);

    expect(messages).toEqual([
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call_1",
            toolName: "lookup",
            input: { query: "milady" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call_1",
            toolName: "lookup",
            output: { type: "text", value: "found" },
          },
        ],
      },
    ]);
  });

  test("maps OpenAI tools and tool_choice into AI SDK native tool fields", () => {
    const tools = chatHooks.convertTools([
      {
        type: "function",
        function: {
          name: "lookup",
          description: "Lookup records",
          parameters: {
            type: "object",
            properties: { query: { type: "string" } },
            required: ["query"],
          },
        },
      },
    ]);

    expect(Object.keys(tools ?? {})).toEqual(["lookup"]);
    expect(chatHooks.mapToolChoice({ type: "function", function: { name: "lookup" } })).toEqual({
      type: "tool",
      toolName: "lookup",
    });
  });

  test("gateway adapter preserves tool messages and native tool schema", () => {
    const messages = gatewayHooks.toModelMessages([
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "call_2",
            type: "function",
            function: { name: "lookup", arguments: '{"query":"gateway"}' },
          },
        ],
      },
      {
        role: "tool",
        content: "ok",
        tool_call_id: "call_2",
      },
    ] as never);

    expect(messages[0]).toEqual({
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: "call_2",
          toolName: "lookup",
          input: { query: "gateway" },
        },
      ],
    });
    expect(messages[1]).toEqual({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "call_2",
          toolName: "lookup",
          output: { type: "text", value: "ok" },
        },
      ],
    });

    expect(
      Object.keys(
        gatewayHooks.toGatewayTools([
          {
            type: "function",
            function: { name: "lookup", parameters: { type: "object" } },
          },
        ] as never) ?? {},
      ),
    ).toEqual(["lookup"]);
  });

  test("gateway adapter preserves cache keys, structured output schemas, and cache usage tokens", () => {
    const providerOptions = gatewayHooks.mergeGatewayProviderOptions({
      model: "cerebras/gpt-oss-120b",
      messages: [],
      prompt_cache_key: "v5:test-cache",
      providerOptions: { gateway: { caching: "auto" } },
    } as never);

    expect(providerOptions?.cerebras).toEqual({
      prompt_cache_key: "v5:test-cache",
      promptCacheKey: "v5:test-cache",
    });
    expect(providerOptions?.eliza).toEqual({
      promptCacheKey: "v5:test-cache",
    });
    expect(providerOptions?.gateway).toEqual({ caching: "auto" });

    expect(
      gatewayHooks.toGatewayOutput({
        type: "json_schema",
        json_schema: {
          name: "evaluation",
          schema: {
            type: "object",
            additionalProperties: false,
            properties: { success: { type: "boolean" } },
            required: ["success"],
          },
        },
      } as never),
    ).toBeDefined();

    const usage = gatewayHooks.toOpenAIUsage({
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
      cacheReadInputTokens: 60,
      cacheCreationInputTokens: 40,
    } as never);

    expect(usage.prompt_tokens).toBe(100);
    expect(usage.completion_tokens).toBe(20);
    expect(usage.prompt_tokens_details?.cached_tokens).toBe(60);
    expect(usage.prompt_tokens_details?.cache_read_input_tokens).toBe(60);
    expect(usage.prompt_tokens_details?.cache_creation_input_tokens).toBe(40);
    expect(usage.cache_read_input_tokens).toBe(60);
    expect(usage.cache_creation_input_tokens).toBe(40);
  });

  test("chat completions bridge preserves caller schema and cache usage details", async () => {
    const schema = {
      type: "object",
      additionalProperties: false,
      properties: { success: { type: "boolean" } },
      required: ["success"],
    };
    const output = chatHooks.mapResponseFormat({
      type: "json_schema",
      json_schema: {
        name: "evaluation",
        description: "Evaluator result",
        schema,
      },
    } as never) as { responseFormat: Promise<Record<string, unknown>> };

    await expect(output.responseFormat).resolves.toMatchObject({
      type: "json",
      schema,
      name: "evaluation",
      description: "Evaluator result",
    });

    const usage = chatHooks.formatOpenAIUsage(
      { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
      {
        inputTokens: 100,
        outputTokens: 20,
        cachedInputTokens: 64,
        inputTokenDetails: { cacheCreationTokens: 32 },
      },
    );

    expect(usage.prompt_tokens_details?.cached_tokens).toBe(64);
    expect(usage.prompt_tokens_details?.cache_read_input_tokens).toBe(64);
    expect(usage.prompt_tokens_details?.cache_creation_input_tokens).toBe(32);
    expect(usage.cache_read_input_tokens).toBe(64);
    expect(usage.cache_creation_input_tokens).toBe(32);
  });
});
