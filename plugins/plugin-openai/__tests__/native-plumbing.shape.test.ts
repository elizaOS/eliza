/**
 * Shape tests exercising the text handler's plumbing — message normalization,
 * model-usage events, and trajectory recording — against a mocked `ai` SDK
 * (`generateText`/`streamText`), no network.
 */
import type { Character, IAgentRuntime } from "@elizaos/core";
import {
  AgentRuntime,
  EventType,
  InMemoryDatabaseAdapter,
  ModelType,
  runWithLlmInputSubstringAttestation,
  runWithStreamingContext,
  runWithTrajectoryContext,
} from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const aiMocks = vi.hoisted(() => ({
  generateText: vi.fn(),
  streamText: vi.fn(),
}));

// `getSetting` in utils/config falls back to `process.env` when the test
// runtime returns undefined. The repo-root `.env` is auto-loaded by bun (and
// re-injected on dynamic import), so a developer or CI environment with
// `OPENAI_BASE_URL=https://api.cerebras.ai/v1` or `OPENAI_SMALL_MODEL=...`
// flips the Cerebras codepath / overrides the model default. We use
// `vi.stubEnv` to pin env vars deterministically — vitest restores them
// in `vi.unstubAllEnvs`, and the pinned values survive bun's dotenv re-injection.
//
// `OPENAI_BASE_URL` is pinned to a non-Cerebras URL (rather than empty)
// because empty strings short-circuit `getSetting` to `""`, which is not
// the same as "unset" for downstream callers.
const ENV_KEYS_TO_CLEAR = [
  "ELIZA_PROVIDER",
  "CEREBRAS_API_KEY",
  "OPENAI_ACTION_PLANNER_MODEL",
  "ACTION_PLANNER_MODEL",
  "OPENAI_SMALL_MODEL",
  "SMALL_MODEL",
  "OPENAI_LARGE_MODEL",
  "LARGE_MODEL",
  "OPENAI_RESPONSE_HANDLER_MODEL",
  "OPENAI_SHOULD_RESPOND_MODEL",
  "RESPONSE_HANDLER_MODEL",
  "SHOULD_RESPOND_MODEL",
] as const;

beforeEach(() => {
  vi.stubEnv("OPENAI_BASE_URL", "https://api.openai.com/v1");
  vi.stubEnv("OPENAI_API_KEY", "test-key");
  for (const key of ENV_KEYS_TO_CLEAR) {
    vi.stubEnv(key, undefined);
  }
});

vi.mock("ai", () => ({
  generateText: aiMocks.generateText,
  streamText: aiMocks.streamText,
  jsonSchema: (schema: unknown) => ({ jsonSchema: schema }),
  Output: {
    object: ({
      schema,
      name,
      description,
    }: {
      schema: unknown;
      name?: string;
      description?: string;
    }) => ({
      name: "object",
      responseFormat: Promise.resolve({
        type: "json",
        schema: (schema as { jsonSchema?: unknown }).jsonSchema ?? schema,
        ...(name ? { name } : {}),
        ...(description ? { description } : {}),
      }),
      parseCompleteOutput: async ({ text }: { text: string }) => JSON.parse(text),
      parsePartialOutput: async () => undefined,
      createElementStreamTransform: () => undefined,
    }),
    json: () => ({
      name: "json",
      responseFormat: Promise.resolve({ type: "json" }),
      parseCompleteOutput: async ({ text }: { text: string }) => JSON.parse(text),
      parsePartialOutput: async () => undefined,
      createElementStreamTransform: () => undefined,
    }),
  },
}));

vi.mock("../providers", () => ({
  createOpenAIClient: () => ({
    chat: (modelName: string) => ({ modelName }),
    // Genuine-OpenAI text now routes through the Responses API so the
    // agent-level injector can attach `web_search`; both surfaces share the
    // same param plumbing these tests assert.
    responses: (modelName: string) => ({ modelName }),
  }),
}));

interface CapturedLlmCall {
  stepId: string;
  actionType: string;
  response?: string;
  promptTokens?: number;
  completionTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  finishReason?: string;
  toolCalls?: unknown;
}

function createRuntime(options?: { trajectoryCalls?: CapturedLlmCall[] }) {
  const trajectoryLogger = options?.trajectoryCalls
    ? {
        isEnabled: () => true,
        logLlmCall: (params: CapturedLlmCall) => {
          options.trajectoryCalls?.push(params);
        },
      }
    : null;
  const runtime = {
    character: { name: "Ada", system: "system prompt" },
    emitEvent: vi.fn(),
    getService: vi.fn((name: string) => (name === "trajectories" ? trajectoryLogger : null)),
    getServicesByType: vi.fn((type: string) =>
      type === "trajectories" && trajectoryLogger ? [trajectoryLogger] : []
    ),
    getSetting: vi.fn((key: string) => {
      const settings: Record<string, string> = {
        OPENAI_API_KEY: "test-key",
        OPENAI_SMALL_MODEL: "gpt-test-small",
      };
      return settings[key];
    }),
  };

  return runtime as IAgentRuntime;
}

function expectNativeTextResult(value: unknown): asserts value is Record<string, unknown> {
  expect(value).toEqual(expect.objectContaining({ text: expect.any(String) }));
}

function plannerResponseSchema() {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      thought: { type: "string" },
      toolCalls: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            id: { type: "string" },
            name: { type: "string" },
            args: { type: "object" },
          },
          required: ["name"],
        },
      },
      messageToUser: { type: "string" },
      completed: { type: "boolean" },
    },
    required: ["thought", "toolCalls"],
  };
}

function assertOpenAIStrictObjectContract(schema: unknown): void {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return;
  }

  const node = schema as Record<string, unknown>;
  if (node.type === "object") {
    expect(node.additionalProperties).toBe(false);
    const properties =
      node.properties && typeof node.properties === "object" && !Array.isArray(node.properties)
        ? (node.properties as Record<string, unknown>)
        : {};
    expect(new Set(Array.isArray(node.required) ? node.required : [])).toEqual(
      new Set(Object.keys(properties))
    );
  }

  for (const key of [
    "properties",
    "$defs",
    "definitions",
    "patternProperties",
    "dependentSchemas",
  ]) {
    const children = node[key];
    if (children && typeof children === "object" && !Array.isArray(children)) {
      for (const child of Object.values(children)) {
        assertOpenAIStrictObjectContract(child);
      }
    }
  }

  if (Array.isArray(node.items)) {
    for (const item of node.items) {
      assertOpenAIStrictObjectContract(item);
    }
  } else {
    assertOpenAIStrictObjectContract(node.items);
  }

  for (const key of ["anyOf", "oneOf", "allOf"] as const) {
    if (Array.isArray(node[key])) {
      for (const item of node[key]) {
        assertOpenAIStrictObjectContract(item);
      }
    }
  }

  assertOpenAIStrictObjectContract(node.not);
  assertOpenAIStrictObjectContract(node.contains);
  assertOpenAIStrictObjectContract(node.if);
  assertOpenAIStrictObjectContract(node.then);
  assertOpenAIStrictObjectContract(node.else);
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("OpenAI native text plumbing", () => {
  it("uses a strict-safe wire schema for planner tool args and restores returned args", async () => {
    const wirePlannerText = JSON.stringify({
      thought: "Need the calendar tool.",
      toolCalls: [
        {
          id: "call-1",
          name: "CALENDAR",
          args: {
            __eliza_planner_arg_entries: [
              { key: "action", valueJson: JSON.stringify("create") },
              {
                key: "event",
                valueJson: JSON.stringify({
                  title: "Deep work",
                  durationMinutes: 90,
                  attendees: ["ada@example.com"],
                  flexible: false,
                  metadata: null,
                }),
              },
              { key: "literalNumericString", valueJson: JSON.stringify("42") },
            ],
          },
        },
      ],
    });
    aiMocks.generateText.mockResolvedValue({
      text: wirePlannerText,
      finishReason: "stop",
      usage: { inputTokens: 11, outputTokens: 9 },
    });

    const { handleActionPlanner } = await import("../models/text");
    const result = (await handleActionPlanner(createRuntime(), {
      messages: [{ role: "user", content: "Schedule deep work" }],
      responseSchema: plannerResponseSchema(),
    } as never)) as { text: string };

    const call = aiMocks.generateText.mock.calls[0][0] as Record<string, unknown>;
    const responseFormat = await (call.output as { responseFormat: Promise<unknown> })
      .responseFormat;
    const schema = (responseFormat as { schema: Record<string, unknown> }).schema;
    const toolCalls = (schema.properties as Record<string, Record<string, unknown>>).toolCalls;
    const toolCallItem = toolCalls.items as Record<string, unknown>;
    const itemProperties = toolCallItem.properties as Record<string, Record<string, unknown>>;
    const args = itemProperties.args;

    expect(itemProperties.args).toBeDefined();
    expect(new Set(toolCallItem.required as string[])).toEqual(new Set(["id", "name", "args"]));
    expect(args.additionalProperties).toBe(false);
    expect(args.required).toEqual(["__eliza_planner_arg_entries"]);
    expect(args.properties).toHaveProperty("__eliza_planner_arg_entries");
    assertOpenAIStrictObjectContract(schema);

    expect(JSON.parse(result.text)).toEqual({
      thought: "Need the calendar tool.",
      toolCalls: [
        {
          id: "call-1",
          name: "CALENDAR",
          args: {
            action: "create",
            event: {
              title: "Deep work",
              durationMinutes: 90,
              attendees: ["ada@example.com"],
              flexible: false,
              metadata: null,
            },
            literalNumericString: "42",
          },
        },
      ],
    });
  }, 180_000);

  it("does not apply the planner wire transform to matching schemas on other model types", async () => {
    const wirePlannerText = JSON.stringify({
      thought: "Looks planner-shaped but is an ordinary text schema.",
      toolCalls: [
        {
          id: "call-1",
          name: "CALENDAR",
          args: {
            __eliza_planner_arg_entries: [{ key: "action", valueJson: JSON.stringify("create") }],
          },
        },
      ],
    });
    aiMocks.generateText.mockResolvedValue({
      text: wirePlannerText,
      finishReason: "stop",
      usage: { inputTokens: 1, outputTokens: 1 },
    });

    const { handleTextSmall } = await import("../models/text");
    const result = (await handleTextSmall(createRuntime(), {
      messages: [{ role: "user", content: "Use a normal response schema" }],
      responseSchema: plannerResponseSchema(),
    } as never)) as { text: string };

    const call = aiMocks.generateText.mock.calls[0][0] as Record<string, unknown>;
    const responseFormat = await (call.output as { responseFormat: Promise<unknown> })
      .responseFormat;
    const schema = (responseFormat as { schema: Record<string, unknown> }).schema;
    const toolCalls = (schema.properties as Record<string, Record<string, unknown>>).toolCalls;
    const toolCallItem = toolCalls.items as Record<string, unknown>;
    const itemProperties = toolCallItem.properties as Record<string, Record<string, unknown>>;
    const args = itemProperties.args;

    const argsProperties =
      args.properties && typeof args.properties === "object" && !Array.isArray(args.properties)
        ? (args.properties as Record<string, unknown>)
        : {};
    expect(argsProperties).not.toHaveProperty("__eliza_planner_arg_entries");
    expect(result.text).toBe(wirePlannerText);
  }, 180_000);

  it.each([
    ["entries not array", "not-array"],
    ["non-object entry", [null]],
    ["extra row field", [{ key: "x", valueJson: JSON.stringify("x"), extra: true }]],
    ["missing key", [{ valueJson: JSON.stringify("x") }]],
    ["invalid key", [{ key: 1, valueJson: JSON.stringify("x") }]],
    ["missing valueJson", [{ key: "x" }]],
    ["invalid valueJson", [{ key: "x", valueJson: "{nope" }]],
    [
      "duplicate keys",
      [
        { key: "x", valueJson: JSON.stringify(1) },
        { key: "x", valueJson: JSON.stringify(2) },
      ],
    ],
  ])(
    "rejects malformed strict-safe planner args: %s",
    async (_name, entries) => {
      aiMocks.generateText.mockResolvedValue({
        text: JSON.stringify({
          thought: "bad args",
          toolCalls: [
            { id: "call-1", name: "BROKEN", args: { __eliza_planner_arg_entries: entries } },
          ],
        }),
        finishReason: "stop",
        usage: { inputTokens: 1, outputTokens: 1 },
      });

      const { handleActionPlanner } = await import("../models/text");
      await expect(
        handleActionPlanner(createRuntime(), {
          messages: [{ role: "user", content: "Plan" }],
          responseSchema: plannerResponseSchema(),
        } as never)
      ).rejects.toThrow("Malformed strict-safe planner args");
    },
    180_000
  );

  it("restores empty-string and __proto__ planner arg keys losslessly", async () => {
    aiMocks.generateText.mockResolvedValue({
      text: JSON.stringify({
        thought: "special keys",
        toolCalls: [
          {
            id: "call-1",
            name: "SPECIAL",
            args: {
              __eliza_planner_arg_entries: [
                { key: "", valueJson: JSON.stringify("empty key") },
                { key: "__proto__", valueJson: JSON.stringify({ preserved: true }) },
              ],
            },
          },
        ],
      }),
      finishReason: "stop",
      usage: { inputTokens: 1, outputTokens: 1 },
    });

    const { handleActionPlanner } = await import("../models/text");
    const result = (await handleActionPlanner(createRuntime(), {
      messages: [{ role: "user", content: "Plan" }],
      responseSchema: plannerResponseSchema(),
    } as never)) as { text: string };

    const args = JSON.parse(result.text).toolCalls[0].args;
    expect(Object.hasOwn(args, "")).toBe(true);
    expect(Object.hasOwn(args, "__proto__")).toBe(true);
    expect(args[""]).toBe("empty key");
    expect(Object.getOwnPropertyDescriptor(args, "__proto__")?.value).toEqual({
      preserved: true,
    });
  }, 180_000);
  it("attests the final generateText system/messages payload before provider invocation", async () => {
    aiMocks.generateText.mockResolvedValue({
      text: "ok",
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    const { handleResponseHandler } = await import("../models/text");
    const hint = "exact lifecycle system instruction";
    const messages = [{ role: "user", content: "delegate the work" }];

    const scoped = await runWithLlmInputSubstringAttestation(hint, () =>
      handleResponseHandler(createRuntime(), {
        system: hint,
        messages,
        // This compatibility alias is not a second wire surface when native
        // messages are present in the final generateText parameters.
        prompt: hint,
      } as never)
    );

    expect(scoped.attestation).toMatchObject({
      modelCallCount: 1,
      matchingCallCount: 1,
      totalOccurrences: 1,
      exactOncePerModelCall: true,
      modelTypeCallCounts: { RESPONSE_HANDLER: 1 },
    });
    const call = aiMocks.generateText.mock.calls[0][0] as Record<string, unknown>;
    expect(call.system).toBe(hint);
    expect(call.messages).toEqual(messages);
    expect(call).not.toHaveProperty("prompt");

    aiMocks.generateText.mockClear();
    await expect(
      runWithLlmInputSubstringAttestation(hint, () =>
        handleResponseHandler(createRuntime(), {
          system: "different system instruction",
          messages,
        } as never)
      )
    ).rejects.toMatchObject({
      code: "LLM_INPUT_SUBSTRING_ATTESTATION_MISMATCH",
    });
    expect(aiMocks.generateText).not.toHaveBeenCalled();
  });

  it("attests the live stream selected by AgentRuntime streaming context", async () => {
    vi.stubEnv("ELIZA_PLANNER_FULL_ACTION_SURFACE", "0");
    aiMocks.streamText.mockResolvedValue({
      textStream: (async function* textStream() {
        yield "ok";
      })(),
      text: Promise.resolve("ok"),
      toolCalls: Promise.resolve([]),
      finishReason: Promise.resolve("stop"),
      usage: Promise.resolve({ inputTokens: 1, outputTokens: 1 }),
    });
    const { handleResponseHandler } = await import("../models/text");
    const runtime = new AgentRuntime({
      character: {
        name: "Ada",
        bio: "test runtime",
        settings: {},
      } as Character,
      adapter: new InMemoryDatabaseAdapter(),
      logLevel: "fatal",
    });
    runtime.registerModel(ModelType.RESPONSE_HANDLER, handleResponseHandler, "openai");
    const hint = "streaming lifecycle system instruction";

    const scoped = await runWithLlmInputSubstringAttestation(hint, () =>
      runWithStreamingContext(
        {
          messageId: "attested-stream-turn",
          onStreamChunk: vi.fn(),
        },
        () =>
          runtime.useModel(ModelType.RESPONSE_HANDLER, {
            system: hint,
            messages: [{ role: "user", content: "delegate the work" }],
          } as never)
      )
    );

    expect(scoped.result).toMatchObject({
      text: "ok",
      toolCalls: [],
      finishReason: "stop",
      usage: {
        promptTokens: 1,
        completionTokens: 1,
        totalTokens: 2,
      },
      providerMetadata: { modelName: "gpt-5.6-luna", provider: "openai" },
    });
    expect(aiMocks.generateText).not.toHaveBeenCalled();
    expect(aiMocks.streamText).toHaveBeenCalledTimes(1);
    expect(aiMocks.streamText.mock.calls[0][0]).toMatchObject({
      system: hint,
      messages: [{ role: "user", content: "delegate the work" }],
    });
    expect(scoped.attestation).toMatchObject({
      modelCallCount: 1,
      matchingCallCount: 1,
      totalOccurrences: 1,
      exactOncePerModelCall: true,
      modelTypeCallCounts: { RESPONSE_HANDLER: 1 },
    });
  });

  it("rechecks live-stream retries without inflating logical model-call totals", async () => {
    vi.stubEnv("ELIZA_PLANNER_FULL_ACTION_SURFACE", "0");
    const transientError = Object.assign(new Error("temporary provider failure"), {
      statusCode: 500,
    });
    aiMocks.streamText
      .mockImplementationOnce((options: { onError?: (event: { error: unknown }) => void }) => ({
        textStream: (async function* textStream() {
          options.onError?.({ error: transientError });
          yield* [];
        })(),
        text: Promise.resolve(""),
        toolCalls: Promise.resolve([]),
        finishReason: Promise.resolve("error"),
        usage: Promise.resolve(undefined),
      }))
      .mockResolvedValueOnce({
        textStream: (async function* textStream() {
          yield "ok";
        })(),
        text: Promise.resolve("ok"),
        toolCalls: Promise.resolve([]),
        finishReason: Promise.resolve("stop"),
        usage: Promise.resolve({ inputTokens: 1, outputTokens: 1 }),
      });
    const { handleTextSmall } = await import("../models/text");
    const hint = "retry lifecycle instruction";

    const scoped = await runWithLlmInputSubstringAttestation(hint, async () => {
      const stream = (await handleTextSmall(createRuntime(), {
        system: "system without the instruction",
        messages: [{ role: "user", content: hint }],
        stream: true,
      } as never)) as { textStream: AsyncIterable<string> };
      for await (const _chunk of stream.textStream) {
        // Full consumption settles the successful retry and its usage telemetry.
      }
    });

    expect(aiMocks.streamText).toHaveBeenCalledTimes(2);
    expect(scoped.attestation).toMatchObject({
      modelCallCount: 1,
      matchingCallCount: 1,
      totalOccurrences: 1,
      exactOncePerModelCall: true,
      modelTypeCallCounts: { TEXT_SMALL: 1 },
    });

    aiMocks.streamText.mockReset();
    aiMocks.streamText.mockImplementationOnce(
      (options: {
        messages?: Array<{ content?: unknown }>;
        onError?: (event: { error: unknown }) => void;
      }) => ({
        textStream: (async function* textStream() {
          if (options.messages?.[0]) {
            options.messages[0].content = "instruction removed before retry";
          }
          options.onError?.({ error: transientError });
          yield* [];
        })(),
        text: Promise.resolve(""),
        toolCalls: Promise.resolve([]),
        finishReason: Promise.resolve("error"),
        usage: Promise.resolve(undefined),
      })
    );

    await expect(
      runWithLlmInputSubstringAttestation(hint, async () => {
        await handleTextSmall(createRuntime(), {
          system: "system without the instruction",
          messages: [{ role: "user", content: hint }],
          stream: true,
        } as never);
      })
    ).rejects.toMatchObject({
      code: "LLM_INPUT_SUBSTRING_ATTESTATION_MISMATCH",
      context: { retryAttempt: true },
    });
    expect(aiMocks.streamText).toHaveBeenCalledTimes(1);
  });

  it("passes messages, tools, toolChoice, schema, and provider options through", async () => {
    aiMocks.generateText.mockResolvedValue({
      text: "ok",
      toolCalls: [{ toolName: "lookup", input: { q: "x" } }],
      finishReason: "tool-calls",
      usage: {
        inputTokens: 7,
        outputTokens: 3,
        cachedInputTokens: 5,
        outputTokenDetails: { reasoningTokens: 2 },
      },
    });

    const { handleTextSmall } = await import("../models/text");
    const messages = [{ role: "user", content: "use the tool" }];
    const tools = { lookup: { description: "Lookup", inputSchema: { type: "object" } } };
    const toolChoice = { type: "tool", toolName: "lookup" };
    const responseSchema = { type: "object", properties: { answer: { type: "string" } } };

    const result = await handleTextSmall(createRuntime(), {
      prompt: "legacy prompt",
      messages,
      tools,
      toolChoice,
      responseSchema,
      providerOptions: {
        agentName: "Ada",
        openai: { promptCacheKey: "cache-key", promptCacheRetention: "24h" },
        custom: { enabled: true },
      },
    } as never);
    expectNativeTextResult(result);

    const call = aiMocks.generateText.mock.calls[0][0] as Record<string, unknown>;
    expect(call.messages).toEqual(messages);
    expect(call).not.toHaveProperty("prompt");
    expect(call.tools).toBe(tools);
    expect(call.toolChoice).toBe(toolChoice);
    expect(call.providerOptions).toEqual({
      custom: { enabled: true },
      openai: { promptCacheKey: "cache-key", promptCacheRetention: "24h" },
    });
    expect(call.experimental_telemetry).toMatchObject({
      functionId: "agent:Ada",
      metadata: { agentName: "Ada" },
    });
    await expect(
      (call.output as { responseFormat: Promise<unknown> }).responseFormat
    ).resolves.toEqual({
      type: "json",
      schema: {
        type: "object",
        properties: { answer: { type: "string" } },
        required: ["answer"],
        additionalProperties: false,
      },
    });
    expect(result).toMatchObject({
      text: "ok",
      toolCalls: [{ toolName: "lookup", input: { q: "x" } }],
      finishReason: "tool-calls",
      usage: {
        promptTokens: 7,
        completionTokens: 3,
        totalTokens: 10,
        cachedPromptTokens: 5,
        cacheReadInputTokens: 5,
        reasoningTokens: 2,
      },
    });
  }, 180_000);

  it("honors a per-call model override before slot defaults", async () => {
    aiMocks.generateText.mockResolvedValue({
      text: "ok",
      usage: { inputTokens: 1, outputTokens: 1 },
    });

    const { handleTextSmall } = await import("../models/text");
    await handleTextSmall(createRuntime(), {
      prompt: "use the workflow model",
      model: " gpt-oss-120b ",
    });

    const call = aiMocks.generateText.mock.calls[0][0] as Record<string, unknown>;
    expect(call.model).toEqual({ modelName: "gpt-oss-120b" });
  });

  it("omits maxOutputTokens only when omitMaxTokens is set", async () => {
    aiMocks.generateText.mockResolvedValue({
      text: "ok",
      usage: { inputTokens: 1, outputTokens: 1 },
    });

    const { handleTextSmall } = await import("../models/text");
    await handleTextSmall(createRuntime(), {
      prompt: "use provider max",
      omitMaxTokens: true,
    } as never);
    await handleTextSmall(createRuntime(), {
      prompt: "use default cap",
    } as never);

    const omittedCall = aiMocks.generateText.mock.calls[0][0] as Record<string, unknown>;
    const defaultCall = aiMocks.generateText.mock.calls[1][0] as Record<string, unknown>;
    expect(omittedCall).not.toHaveProperty("maxOutputTokens");
    expect(defaultCall.maxOutputTokens).toBe(8192);
  });

  it("keeps streaming native tool-call plumbing in parity with non-streaming", async () => {
    const toolCalls = [{ toolName: "lookup", input: { q: "x" } }];
    const usage = { inputTokens: 7, outputTokens: 3, cachedInputTokens: 5 };

    aiMocks.generateText.mockResolvedValue({
      text: "ok",
      toolCalls,
      finishReason: "tool-calls",
      usage,
    });
    aiMocks.streamText.mockResolvedValue({
      textStream: (async function* textStream() {
        yield "ok";
      })(),
      text: Promise.resolve("ok"),
      toolCalls: Promise.resolve(toolCalls),
      finishReason: Promise.resolve("tool-calls"),
      usage: Promise.resolve(usage),
    });

    const { handleTextSmall } = await import("../models/text");
    const baseParams = {
      prompt: "legacy prompt",
      messages: [{ role: "user", content: "use the tool" }],
      tools: { lookup: { description: "Lookup", inputSchema: { type: "object" } } },
      toolChoice: { type: "tool", toolName: "lookup" },
      responseSchema: { type: "object", properties: { answer: { type: "string" } } },
      providerOptions: {
        openai: { promptCacheKey: "cache-key", promptCacheRetention: "24h" },
        custom: { enabled: true },
      },
    };

    const nonStream = await handleTextSmall(createRuntime(), baseParams as never);
    const stream = await handleTextSmall(createRuntime(), { ...baseParams, stream: true } as never);

    const nonStreamCall = aiMocks.generateText.mock.calls[0][0] as Record<string, unknown>;
    const streamCall = aiMocks.streamText.mock.calls[0][0] as Record<string, unknown>;

    expect(streamCall.messages).toEqual(nonStreamCall.messages);
    expect(streamCall).not.toHaveProperty("prompt");
    expect(streamCall.tools).toBe(nonStreamCall.tools);
    expect(streamCall.toolChoice).toBe(nonStreamCall.toolChoice);
    expect(streamCall.providerOptions).toEqual(nonStreamCall.providerOptions);
    await expect(
      (streamCall.output as { responseFormat: Promise<unknown> }).responseFormat
    ).resolves.toEqual(
      await (nonStreamCall.output as { responseFormat: Promise<unknown> }).responseFormat
    );

    expectNativeTextResult(nonStream);
    expect(nonStream).toMatchObject({ toolCalls, finishReason: "tool-calls" });
    await expect((stream as { toolCalls: Promise<unknown> }).toolCalls).resolves.toEqual(toolCalls);
    await expect((stream as { finishReason: Promise<unknown> }).finishReason).resolves.toBe(
      "tool-calls"
    );
    await expect((stream as { usage: Promise<unknown> }).usage).resolves.toMatchObject({
      promptTokens: 7,
      completionTokens: 3,
      totalTokens: 10,
      cachedPromptTokens: 5,
    });
  }, 180_000);

  it("forwards streaming text chunks to the core onStreamChunk callback", async () => {
    aiMocks.streamText.mockResolvedValue({
      textStream: (async function* textStream() {
        yield "hel";
        yield "lo";
      })(),
      text: Promise.resolve("hello"),
      toolCalls: Promise.resolve([]),
      finishReason: Promise.resolve("stop"),
      usage: Promise.resolve({ inputTokens: 2, outputTokens: 1 }),
    });

    const onStreamChunk = vi.fn();
    const { handleTextSmall } = await import("../models/text");
    const stream = (await handleTextSmall(createRuntime(), {
      prompt: "stream",
      stream: true,
      onStreamChunk,
    } as never)) as { textStream: AsyncIterable<string> };

    const chunks: string[] = [];
    for await (const chunk of stream.textStream) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual(["hel", "lo"]);
    expect(onStreamChunk).toHaveBeenNthCalledWith(1, "hel");
    expect(onStreamChunk).toHaveBeenNthCalledWith(2, "lo");
  });

  it.each([
    { stream: false, mock: aiMocks.generateText },
    { stream: true, mock: aiMocks.streamText },
  ])("forwards the caller abort signal to the $stream transport", async ({ stream, mock }) => {
    const signal = new AbortController().signal;
    if (stream) {
      mock.mockResolvedValue({
        textStream: (async function* textStream() {
          yield "ok";
        })(),
        text: Promise.resolve("ok"),
        toolCalls: Promise.resolve([]),
        finishReason: Promise.resolve("stop"),
        usage: Promise.resolve({ inputTokens: 1, outputTokens: 1 }),
      });
    } else {
      mock.mockResolvedValue({
        text: "ok",
        toolCalls: [],
        finishReason: "stop",
        usage: { inputTokens: 1, outputTokens: 1 },
      });
    }

    const { handleTextSmall } = await import("../models/text");
    const result = await handleTextSmall(createRuntime(), {
      prompt: "abortable request",
      stream,
      signal,
    } as never);
    if (stream) {
      for await (const _chunk of (result as { textStream: AsyncIterable<string> }).textStream) {
        // Consumption finalizes streaming telemetry; the assertion is on the SDK call below.
      }
    }

    const call = mock.mock.calls[0][0] as Record<string, unknown>;
    expect(call.abortSignal).toBe(signal);
  });

  it("emits usage and records the completed live-stream response after consumption", async () => {
    const trajectoryCalls: CapturedLlmCall[] = [];
    const toolCalls = [{ toolName: "lookup", input: { q: "x" } }];
    aiMocks.streamText.mockResolvedValue({
      textStream: (async function* textStream() {
        yield "hel";
        yield "lo";
      })(),
      text: Promise.resolve("hello"),
      toolCalls: Promise.resolve(toolCalls),
      finishReason: Promise.resolve("stop"),
      usage: Promise.resolve({ inputTokens: 2, outputTokens: 1, cachedInputTokens: 1 }),
    });

    const runtime = createRuntime({ trajectoryCalls });
    const { handleTextSmall } = await import("../models/text");
    await runWithTrajectoryContext({ trajectoryStepId: "step-openai-stream" }, async () => {
      const stream = (await handleTextSmall(runtime, {
        prompt: "stream",
        stream: true,
      } as never)) as { textStream: AsyncIterable<string> };

      const chunks: string[] = [];
      for await (const chunk of stream.textStream) {
        chunks.push(chunk);
      }
      expect(chunks.join("")).toBe("hello");
    });

    expect(runtime.emitEvent).toHaveBeenCalledWith(
      EventType.MODEL_USED,
      expect.objectContaining({
        source: "openai",
        provider: "openai",
        type: ModelType.TEXT_SMALL,
        model: "gpt-test-small",
        modelName: "gpt-test-small",
        modelLabel: ModelType.TEXT_SMALL,
        prompt: "stream",
        tokens: {
          prompt: 2,
          completion: 1,
          total: 3,
          cached: 1,
          cachedInputTokens: 1,
          cacheReadInputTokens: 1,
        },
      })
    );
    expect(trajectoryCalls).toHaveLength(1);
    expect(trajectoryCalls[0]).toMatchObject({
      stepId: "step-openai-stream",
      actionType: "ai.streamText",
      response: "hello",
      promptTokens: 2,
      completionTokens: 1,
      cacheReadInputTokens: 1,
      finishReason: "stop",
      toolCalls,
      providerMetadata: {
        modelName: "gpt-test-small",
        provider: "openai",
        retryCount: 0,
      },
    });
  });

  it("records completed buffered-stream output and usage before returning", async () => {
    vi.stubEnv("ELIZA_PLANNER_FULL_ACTION_SURFACE", "1");
    const trajectoryCalls: CapturedLlmCall[] = [];
    const toolCalls = [{ toolName: "lookup", input: { q: "x" } }];
    aiMocks.streamText.mockReturnValue({
      textStream: (async function* textStream() {
        yield '{"answer":"ok"}';
      })(),
      text: Promise.resolve('{"answer":"ok"}'),
      toolCalls: Promise.resolve(toolCalls),
      finishReason: Promise.resolve("tool-calls"),
      usage: Promise.resolve({ inputTokens: 8, outputTokens: 4, cachedInputTokens: 6 }),
    });

    const runtime = createRuntime({ trajectoryCalls });
    const { handleTextSmall } = await import("../models/text");
    await runWithTrajectoryContext({ trajectoryStepId: "step-openai-buffered" }, () =>
      handleTextSmall(runtime, {
        prompt: "structured stream",
        stream: true,
        tools: { lookup: { description: "Lookup", inputSchema: { type: "object" } } },
        responseSchema: {
          type: "object",
          properties: { answer: { type: "string" } },
          required: ["answer"],
        },
      } as never)
    );

    expect(trajectoryCalls).toHaveLength(1);
    expect(trajectoryCalls[0]).toMatchObject({
      stepId: "step-openai-buffered",
      actionType: "ai.streamText",
      response: '{"answer":"ok"}',
      promptTokens: 8,
      completionTokens: 4,
      cacheReadInputTokens: 6,
      finishReason: "tool-calls",
      toolCalls,
      providerMetadata: {
        modelName: "gpt-test-small",
        provider: "openai",
        retryCount: 0,
      },
    });
  });

  it("finalizes live-stream telemetry when the runtime breaks the stream loop early", async () => {
    const trajectoryCalls: CapturedLlmCall[] = [];
    aiMocks.streamText.mockResolvedValue({
      textStream: (async function* textStream() {
        yield "first";
        yield "second";
      })(),
      text: Promise.resolve("firstsecond"),
      toolCalls: Promise.resolve([]),
      finishReason: Promise.resolve("stop"),
      usage: Promise.resolve({ inputTokens: 5, outputTokens: 2 }),
    });

    const runtime = createRuntime({ trajectoryCalls });
    const { handleTextSmall } = await import("../models/text");
    await runWithTrajectoryContext({ trajectoryStepId: "step-openai-break" }, async () => {
      const stream = (await handleTextSmall(runtime, {
        prompt: "break stream",
        stream: true,
      } as never)) as { textStream: AsyncIterable<string> };

      for await (const chunk of stream.textStream) {
        expect(chunk).toBe("first");
        break;
      }
    });

    expect(runtime.emitEvent).toHaveBeenCalledWith(
      EventType.MODEL_USED,
      expect.objectContaining({
        provider: "openai",
        type: ModelType.TEXT_SMALL,
        model: "gpt-test-small",
        modelName: "gpt-test-small",
        prompt: "break stream",
        tokens: { prompt: 5, completion: 2, total: 7 },
      })
    );
    expect(trajectoryCalls).toHaveLength(1);
    expect(trajectoryCalls[0]).toMatchObject({
      stepId: "step-openai-break",
      actionType: "ai.streamText",
      response: "first",
      promptTokens: 5,
      completionTokens: 2,
      finishReason: "stop",
    });
  });

  it("surfaces live-stream provider errors reported through the AI SDK onError hook", async () => {
    const providerError = new Error("stream provider failed");
    aiMocks.streamText.mockResolvedValue({
      textStream: (async function* textStream() {
        yield "partial";
      })(),
      text: Promise.resolve("partial"),
      toolCalls: Promise.resolve([]),
      finishReason: Promise.resolve("stop"),
      usage: Promise.resolve({ inputTokens: 1, outputTokens: 1 }),
    });

    const { handleTextSmall } = await import("../models/text");
    const stream = (await handleTextSmall(createRuntime(), {
      prompt: "stream error",
      stream: true,
    } as never)) as { textStream: AsyncIterable<string> };
    const call = aiMocks.streamText.mock.calls[0][0] as {
      onError?: (event: { error: unknown }) => void;
    };
    call.onError?.({ error: providerError });

    await expect(async () => {
      for await (const _chunk of stream.textStream) {
        // consume the stream so the deferred onError hook is checked
      }
    }).rejects.toThrow("stream provider failed");
  });

  it("maps string responseFormat json_object into the AI SDK JSON output contract", async () => {
    aiMocks.generateText.mockResolvedValue({
      text: "{}",
      finishReason: "stop",
      usage: { inputTokens: 3, outputTokens: 1 },
    });

    const { handleTextSmall } = await import("../models/text");
    await handleTextSmall(createRuntime(), {
      prompt: "json",
      responseFormat: "json_object",
    } as never);

    const call = aiMocks.generateText.mock.calls[0][0] as Record<string, unknown>;
    expect(call).not.toHaveProperty("responseFormat");
    await expect(
      (call.output as { responseFormat: Promise<unknown> }).responseFormat
    ).resolves.toEqual({ type: "json" });
  });

  it("keeps Cerebras JSON mode schema-free at the provider boundary", async () => {
    vi.stubEnv("ELIZA_PROVIDER", "cerebras");
    vi.stubEnv("CEREBRAS_API_KEY", "test-cerebras-key");
    aiMocks.generateText.mockResolvedValue({
      text: '{"answer":"ok"}',
      finishReason: "stop",
      usage: { inputTokens: 3, outputTokens: 3 },
    });

    const { handleTextSmall } = await import("../models/text");
    await handleTextSmall(createRuntime(), {
      prompt: "json",
      responseFormat: { type: "json_object" },
      responseSchema: {
        type: "object",
        properties: { answer: { type: "string" } },
        required: ["answer"],
      },
    } as never);

    const call = aiMocks.generateText.mock.calls[0][0] as Record<string, unknown>;
    expect((call.output as { name: string }).name).toBe("json");
    await expect(
      (call.output as { responseFormat: Promise<unknown> }).responseFormat
    ).resolves.toEqual({ type: "json" });
  });

  it("marks unconsumed streaming companion promises as handled", async () => {
    const noOutputError = Object.assign(
      new Error("No output generated. Check the stream for errors."),
      { name: "AI_NoOutputGeneratedError" }
    );
    aiMocks.streamText.mockResolvedValue({
      textStream: (async function* textStream() {
        // Empty stream: the runtime consumes this path and records an empty
        // response, while the AI SDK `text` promise rejects during flush.
      })(),
      text: Promise.reject(noOutputError),
      toolCalls: Promise.resolve([]),
      finishReason: Promise.resolve("stop"),
      usage: Promise.resolve({ inputTokens: 1, outputTokens: 0 }),
    });

    const { handleTextSmall } = await import("../models/text");
    const stream = (await handleTextSmall(createRuntime(), {
      prompt: "empty stream",
      stream: true,
    } as never)) as { textStream: AsyncIterable<string>; text: Promise<string> };

    for await (const _chunk of stream.textStream) {
      // consume the primary stream path
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
    await expect(stream.text).rejects.toThrow("No output generated");
  });

  it("preserves Cerebras cache keys while stripping OpenAI-only cache retention", async () => {
    aiMocks.generateText.mockResolvedValue({
      text: "ok",
      finishReason: "stop",
      usage: { inputTokens: 4, outputTokens: 1 },
    });

    const runtime = createRuntime();
    vi.mocked(runtime.getSetting).mockImplementation((key: string) => {
      const settings: Record<string, string> = {
        OPENAI_API_KEY: "test-key",
        OPENAI_BASE_URL: "https://api.cerebras.ai/v1",
        OPENAI_SMALL_MODEL: "gpt-oss-120b",
      };
      return settings[key];
    });

    const { handleTextSmall } = await import("../models/text");
    await handleTextSmall(runtime, {
      prompt: "cache",
      providerOptions: {
        openai: { promptCacheKey: "v5:abc", promptCacheRetention: "24h" },
        cerebras: { promptCacheKey: "v5:abc", prompt_cache_key: "v5:abc" },
        gateway: { caching: "auto" },
      },
    } as never);

    const call = aiMocks.generateText.mock.calls[0][0] as Record<string, unknown>;
    expect(call.providerOptions).toEqual({
      cerebras: { promptCacheKey: "v5:abc", prompt_cache_key: "v5:abc" },
      gateway: { caching: "auto" },
      // Cerebras mode defaults reasoningEffort to "low" (gpt-oss-120b returns
      // empty content when reasoning runs unbounded); see resolveReasoningEffort.
      openai: { promptCacheKey: "v5:abc", reasoningEffort: "low" },
    });
    expect(runtime.emitEvent).toHaveBeenCalledWith(
      EventType.MODEL_USED,
      expect.objectContaining({
        source: "openai",
        provider: "cerebras",
        type: ModelType.TEXT_SMALL,
        model: "gpt-oss-120b",
        modelName: "gpt-oss-120b",
        modelLabel: ModelType.TEXT_SMALL,
      })
    );
  });

  it("defaults small and response handler models to gpt-5.6-luna while preserving explicit overrides", async () => {
    const { getResponseHandlerModel, getSmallModel } = await import("../utils/config");
    const runtime = {
      getSetting: vi.fn(() => undefined),
    } as IAgentRuntime;

    expect(getSmallModel(runtime)).toBe("gpt-5.6-luna");
    expect(getResponseHandlerModel(runtime)).toBe("gpt-5.6-luna");

    const overrideRuntime = {
      getSetting: vi.fn((key: string) => {
        const settings: Record<string, string> = {
          OPENAI_SMALL_MODEL: "custom-small",
          OPENAI_RESPONSE_HANDLER_MODEL: "custom-response",
        };
        return settings[key];
      }),
    } as IAgentRuntime;
    expect(getSmallModel(overrideRuntime)).toBe("custom-small");
    expect(getResponseHandlerModel(overrideRuntime)).toBe("custom-response");
  });

  it("passes the effective system separately without duplicating the leading system message", async () => {
    aiMocks.generateText.mockResolvedValue({
      text: "ok",
      finishReason: "stop",
      usage: { inputTokens: 4, outputTokens: 1 },
    });

    const { handleTextSmall } = await import("../models/text");
    await handleTextSmall(createRuntime(), {
      prompt: "legacy prompt",
      messages: [
        { role: "system", content: "system prompt" },
        { role: "user", content: "hello" },
      ],
    } as never);

    const call = aiMocks.generateText.mock.calls[0][0] as Record<string, unknown>;
    expect(call.system).toBe("system prompt");
    expect(call.messages).toEqual([{ role: "user", content: "hello" }]);
  });

  it("normalizes core tool arrays and tool choice into AI SDK tool sets", async () => {
    aiMocks.generateText.mockResolvedValue({
      text: "",
      toolCalls: [{ toolName: "WEB_SEARCH", input: { q: "eliza" } }],
      finishReason: "tool-calls",
      usage: { inputTokens: 11, outputTokens: 2 },
    });

    const { handleTextSmall } = await import("../models/text");
    const coreTools = [
      {
        name: "WEB_SEARCH",
        description: "Search the web",
        type: "function",
        strict: true,
        parameters: {
          properties: {
            q: { description: "Query", type: "string" },
          },
          required: ["q"],
          additionalProperties: false,
        },
      },
    ];

    await handleTextSmall(createRuntime(), {
      prompt: "use native tool",
      messages: [{ role: "user", content: "search eliza" }],
      tools: coreTools,
      toolChoice: { type: "tool", name: "WEB_SEARCH" },
    } as never);

    const call = aiMocks.generateText.mock.calls[0][0] as Record<string, unknown>;
    expect(call.tools).not.toBe(coreTools);
    expect(Object.keys(call.tools as Record<string, unknown>)).toEqual(["WEB_SEARCH"]);
    expect(call.toolChoice).toEqual({ type: "tool", toolName: "WEB_SEARCH" });

    const webSearch = (call.tools as Record<string, { inputSchema: { jsonSchema: unknown } }>)
      .WEB_SEARCH;
    expect(webSearch.inputSchema.jsonSchema).toEqual({
      type: "object",
      properties: {
        q: { description: "Query", type: "string" },
      },
      required: ["q"],
      additionalProperties: false,
    });
  }, 60_000);

  it("restores strict-safe record/map tool-call args before returning native results", async () => {
    aiMocks.generateText.mockResolvedValue({
      text: "",
      toolCalls: [
        {
          toolName: "SAVE_CONTACT",
          input: {
            customFields: {
              __eliza_record_entries: [
                { key: "favoriteColor", value: "blue" },
                { key: "score", value: "7" },
              ],
            },
          },
        },
      ],
      finishReason: "tool-calls",
      usage: { inputTokens: 13, outputTokens: 4 },
    });

    const { handleTextSmall } = await import("../models/text");
    const result = (await handleTextSmall(createRuntime(), {
      prompt: "save contact",
      messages: [{ role: "user", content: "save this" }],
      tools: [
        {
          name: "SAVE_CONTACT",
          description: "Save contact",
          parameters: {
            type: "object",
            properties: {
              customFields: {
                type: "object",
                additionalProperties: true,
              },
            },
            required: ["customFields"],
          },
        },
      ],
      toolChoice: { type: "tool", name: "SAVE_CONTACT" },
    } as never)) as { toolCalls: unknown[] };

    expect(result.toolCalls).toEqual([
      {
        toolName: "SAVE_CONTACT",
        input: {
          customFields: {
            favoriteColor: "blue",
            score: 7,
          },
        },
      },
    ]);

    const call = aiMocks.generateText.mock.calls[0][0] as Record<string, unknown>;
    const saveContact = (call.tools as Record<string, { inputSchema: { jsonSchema: unknown } }>)
      .SAVE_CONTACT;
    const schema = saveContact.inputSchema.jsonSchema as {
      properties: Record<string, { properties: Record<string, unknown> }>;
    };
    expect(schema.properties.customFields.properties.__eliza_record_entries).toBeDefined();
  }, 60_000);

  it("normalizes core assistant/tool history into AI SDK model messages", async () => {
    aiMocks.generateText.mockResolvedValue({
      text: JSON.stringify({ decision: "FINISH", success: true }),
      finishReason: "stop",
      usage: { inputTokens: 17, outputTokens: 4 },
    });

    const { handleTextSmall } = await import("../models/text");
    await handleTextSmall(createRuntime(), {
      prompt: "evaluate",
      messages: [
        { role: "user", content: "search eliza" },
        {
          role: "assistant",
          content: null,
          toolCalls: [
            {
              id: "tool-1",
              type: "function",
              name: "WEB_SEARCH",
              arguments: JSON.stringify({ q: "eliza" }),
            },
          ],
        },
        {
          role: "tool",
          toolCallId: "tool-1",
          name: "WEB_SEARCH",
          content: JSON.stringify({ success: true, text: "found results" }),
        },
      ],
    } as never);

    const call = aiMocks.generateText.mock.calls[0][0] as Record<string, unknown>;
    expect(call.messages).toEqual([
      { role: "user", content: "search eliza" },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "tool-1",
            toolName: "WEB_SEARCH",
            input: { q: "eliza" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "tool-1",
            toolName: "WEB_SEARCH",
            output: { type: "json", value: { success: true, text: "found results" } },
          },
        ],
      },
    ]);
  }, 60_000);
});
