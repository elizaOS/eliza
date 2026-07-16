/**
 * Shape tests for Anthropic prompt-cache injection in the OpenRouter text handler.
 * Covers the runtime-fallback cacheControl (Fix 2), internal-field stripping from wire
 * options (Fix 3a), segmented-user-content breakpoints with validated shapes and capping
 * (Fix 3b/3c), the cacheSystem:false opt-out, verbatim survival of caller-supplied
 * providerOptions (openrouter + arbitrary keys) alongside injected cacheControl and
 * multi-breakpoint stamping (#15825), and strict provider-scoped validation of
 * caller-supplied cache controls and breakpoint plans (#15825/#15966). Malformed
 * consumed options fail before the provider request; non-Anthropic routes leave the
 * unused namespace untouched. AI SDK and provider are mocked — no network calls.
 */
import type { GenerateTextParams, IAgentRuntime } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";

function createRuntime(settings: Record<string, string> = {}) {
  return {
    character: { system: "system prompt" },
    emitEvent: vi.fn(async () => undefined),
    getSetting: vi.fn((key: string) => {
      return (
        (
          {
            OPENROUTER_API_KEY: "test-key",
            OPENROUTER_LARGE_MODEL: "anthropic/claude-opus-4-8",
            ...settings,
          } as Record<string, string>
        )[key] ?? null
      );
    }),
  } as IAgentRuntime;
}

function mockModules() {
  const generateText = vi.fn(async () => ({
    text: "ok",
    finishReason: "stop",
    usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 },
  }));
  vi.doMock("ai", () => ({ generateText, streamText: vi.fn() }));
  vi.doMock("../providers", () => ({
    createOpenRouterProvider: () => ({
      chat: (m: string) => ({ modelName: m }),
    }),
  }));
  return { generateText };
}

afterEach(() => {
  vi.doUnmock("ai");
  vi.doUnmock("../providers");
  vi.clearAllMocks();
  vi.resetModules();
});

describe("Anthropic cache injection — runtime cacheControl fallback", () => {
  it("injects ephemeral cacheControl on system message for Anthropic models even without explicit providerOptions", async () => {
    const { generateText } = mockModules();
    const { handleTextLarge } = await import("../models/text");

    await handleTextLarge(createRuntime(), { prompt: "hello" } as never);

    const call = generateText.mock.calls[0][0] as Record<string, unknown>;
    const messages = call.messages as Array<Record<string, unknown>>;
    const systemMsg = messages?.[0];
    expect(systemMsg?.role).toBe("system");
    const provOpts = systemMsg?.providerOptions as Record<string, unknown> | undefined;
    const anthropicOpts = provOpts?.anthropic as Record<string, unknown> | undefined;
    expect(anthropicOpts?.cacheControl).toEqual(expect.objectContaining({ type: "ephemeral" }));
  });

  it("respects ANTHROPIC_PROMPT_CACHE_TTL=1h when producing the fallback cacheControl", async () => {
    const { generateText } = mockModules();
    const { handleTextLarge } = await import("../models/text");

    await handleTextLarge(createRuntime({ ANTHROPIC_PROMPT_CACHE_TTL: "1h" }), {
      prompt: "hello",
    } as never);

    const call = generateText.mock.calls[0][0] as Record<string, unknown>;
    const messages = call.messages as Array<Record<string, unknown>>;
    const anthropicOpts = (messages?.[0]?.providerOptions as Record<string, unknown>)?.anthropic as
      | Record<string, unknown>
      | undefined;
    expect(anthropicOpts?.cacheControl).toEqual({
      type: "ephemeral",
      ttl: "1h",
    });
  });

  it("does NOT inject cacheControl for non-Anthropic models even when ANTHROPIC_PROMPT_CACHE_TTL is set", async () => {
    const { generateText } = mockModules();
    const { handleTextLarge } = await import("../models/text");

    await handleTextLarge(
      createRuntime({
        OPENROUTER_LARGE_MODEL: "google/gemini-2.5-flash",
        ANTHROPIC_PROMPT_CACHE_TTL: "1h",
      }),
      { prompt: "hello" } as never
    );

    const call = generateText.mock.calls[0][0] as Record<string, unknown>;
    // Non-Anthropic path routes through the plain prompt/system path — no message array with
    // cacheControl injected.
    if (Array.isArray(call.messages)) {
      for (const msg of call.messages as Array<Record<string, unknown>>) {
        expect(msg?.providerOptions).toBeUndefined();
      }
    }
    const wireAnthropicOpts = (call.providerOptions as Record<string, unknown> | undefined)
      ?.anthropic as Record<string, unknown> | undefined;
    expect(wireAnthropicOpts?.cacheControl).toBeUndefined();
  });
});

describe("Anthropic cache injection — internal field stripping", () => {
  it("strips cacheBreakpoints and maxBreakpoints from wire providerOptions", async () => {
    const { generateText } = mockModules();
    const { handleTextLarge } = await import("../models/text");

    await handleTextLarge(createRuntime(), {
      prompt: "hello",
      promptSegments: [{ content: "hello", stable: true }],
      providerOptions: {
        anthropic: {
          cacheControl: { type: "ephemeral" },
          cacheBreakpoints: [{ segmentIndex: 0, cacheControl: { type: "ephemeral" } }],
          maxBreakpoints: 2,
        },
        gateway: { caching: "auto" },
      },
    } as never);

    const call = generateText.mock.calls[0][0] as Record<string, unknown>;
    const providerOpts = call.providerOptions as Record<string, unknown> | undefined;
    const wireAnthropic = providerOpts?.anthropic as Record<string, unknown> | undefined;
    expect(wireAnthropic?.cacheBreakpoints).toBeUndefined();
    expect(wireAnthropic?.maxBreakpoints).toBeUndefined();
    // Non-Anthropic provider options pass through untouched
    expect(providerOpts?.gateway).toEqual({ caching: "auto" });
  });

  it("strips cacheSystem from wire options while keeping remaining anthropic fields", async () => {
    const { generateText } = mockModules();
    const { handleTextLarge } = await import("../models/text");

    await handleTextLarge(createRuntime({ OPENROUTER_LARGE_MODEL: "anthropic/claude-opus-4-8" }), {
      messages: [
        { role: "system", content: "system prompt" },
        { role: "user", content: "hello" },
      ],
      providerOptions: {
        anthropic: { cacheSystem: true, thinking: { type: "enabled" } },
      },
    } as never);

    const call = generateText.mock.calls[0][0] as Record<string, unknown>;
    const wireAnthropic = (call.providerOptions as Record<string, unknown> | undefined)
      ?.anthropic as Record<string, unknown> | undefined;
    expect(wireAnthropic?.cacheSystem).toBeUndefined();
    expect(wireAnthropic?.thinking).toEqual({ type: "enabled" });
  });
});

describe("Anthropic cache injection — segmented user content", () => {
  it("builds N content blocks for N promptSegments, applying cacheControl only at breakpoint indices", async () => {
    const { generateText } = mockModules();
    const { handleTextLarge } = await import("../models/text");

    await handleTextLarge(createRuntime(), {
      prompt: "seg1seg2",
      promptSegments: [
        { content: "seg1", stable: true },
        { content: "seg2", stable: false },
      ],
      providerOptions: {
        anthropic: {
          cacheBreakpoints: [{ segmentIndex: 0, cacheControl: { type: "ephemeral" } }],
        },
      },
    } as never);

    const call = generateText.mock.calls[0][0] as Record<string, unknown>;
    const messages = call.messages as Array<Record<string, unknown>>;
    const userMsg = messages?.[1];
    const content = userMsg?.content as Array<Record<string, unknown>>;
    expect(content).toHaveLength(2);
    expect(content[0]?.text).toBe("seg1");
    const seg0Opts = (content[0]?.providerOptions as Record<string, unknown>)?.anthropic as
      | Record<string, unknown>
      | undefined;
    expect(seg0Opts?.cacheControl).toEqual({ type: "ephemeral" });
    expect(content[1]?.text).toBe("seg2");
    expect(content[1]?.providerOptions).toBeUndefined();
  });

  it("stamps a validated 5m TTL breakpoint onto its segment", async () => {
    const { generateText } = mockModules();
    const { handleTextLarge } = await import("../models/text");

    await handleTextLarge(createRuntime(), {
      prompt: "s0s1",
      promptSegments: [
        { content: "s0", stable: true },
        { content: "s1", stable: false },
      ],
      providerOptions: {
        anthropic: {
          cacheBreakpoints: [{ segmentIndex: 0, cacheControl: { type: "ephemeral", ttl: "5m" } }],
        },
      },
    } as never);

    const call = generateText.mock.calls[0][0] as Record<string, unknown>;
    const messages = call.messages as Array<Record<string, unknown>>;
    const content = messages?.[1]?.content as Array<Record<string, unknown>>;
    const cc0 = (content[0]?.providerOptions as Record<string, unknown>)?.anthropic as
      | Record<string, unknown>
      | undefined;
    expect(cc0?.cacheControl).toEqual({ type: "ephemeral", ttl: "5m" });
    expect(content[1]?.providerOptions).toBeUndefined();
  });

  it("caps applied breakpoints at maxBreakpoints", async () => {
    const { generateText } = mockModules();
    const { handleTextLarge } = await import("../models/text");

    await handleTextLarge(createRuntime(), {
      prompt: "s0s1s2s3",
      promptSegments: [
        { content: "s0", stable: true },
        { content: "s1", stable: true },
        { content: "s2", stable: true },
        { content: "s3", stable: false },
      ],
      providerOptions: {
        anthropic: {
          maxBreakpoints: 1,
          cacheBreakpoints: [
            { segmentIndex: 0, cacheControl: { type: "ephemeral" } },
            { segmentIndex: 1, cacheControl: { type: "ephemeral" } },
            { segmentIndex: 2, cacheControl: { type: "ephemeral" } },
          ],
        },
      },
    } as never);

    const call = generateText.mock.calls[0][0] as Record<string, unknown>;
    const messages = call.messages as Array<Record<string, unknown>>;
    const userMsg = messages?.[1];
    const content = userMsg?.content as Array<Record<string, unknown>>;
    const cachedBlocks = content?.filter(
      (b) => (b.providerOptions as Record<string, unknown> | undefined)?.anthropic !== undefined
    );
    // Only segmentIndex 0 survives the cap of 1
    expect(cachedBlocks).toHaveLength(1);
    expect(cachedBlocks?.[0]?.text).toBe("s0");
  });
});

describe("Anthropic cache injection — caller providerOptions survive verbatim", () => {
  it("preserves openrouter.promptCacheKey and arbitrary provider keys alongside injected cacheControl", async () => {
    const { generateText } = mockModules();
    const { handleTextLarge } = await import("../models/text");

    await handleTextLarge(createRuntime(), {
      prompt: "hello",
      providerOptions: {
        openrouter: { promptCacheKey: "caller-key-123" },
        gateway: { caching: "auto" },
        customProvider: { nested: { flag: true }, count: 7 },
      },
    } as never);

    const call = generateText.mock.calls[0][0] as Record<string, unknown>;
    const providerOpts = call.providerOptions as Record<string, unknown>;
    // Caller keys survive unchanged into the serialized request.
    expect(providerOpts.openrouter).toEqual({
      promptCacheKey: "caller-key-123",
    });
    expect(providerOpts.gateway).toEqual({ caching: "auto" });
    expect(providerOpts.customProvider).toEqual({
      nested: { flag: true },
      count: 7,
    });
    // And the injected message-level cacheControl is still applied on the system message.
    const messages = call.messages as Array<Record<string, unknown>>;
    const anthropicOpts = (messages?.[0]?.providerOptions as Record<string, unknown>)?.anthropic as
      | Record<string, unknown>
      | undefined;
    expect(anthropicOpts?.cacheControl).toEqual(expect.objectContaining({ type: "ephemeral" }));
  });

  it("stamps cacheControl on multiple segment breakpoints while caller providerOptions survive", async () => {
    const { generateText } = mockModules();
    const { handleTextLarge } = await import("../models/text");

    await handleTextLarge(createRuntime(), {
      prompt: "s0s1s2",
      promptSegments: [
        { content: "s0", stable: true },
        { content: "s1", stable: true },
        { content: "s2", stable: false },
      ],
      providerOptions: {
        openrouter: { promptCacheKey: "multi-bp" },
        anthropic: {
          cacheBreakpoints: [
            { segmentIndex: 0, cacheControl: { type: "ephemeral" } },
            { segmentIndex: 1, cacheControl: { type: "ephemeral", ttl: "1h" } },
          ],
        },
      },
    } as never);

    const call = generateText.mock.calls[0][0] as Record<string, unknown>;
    const messages = call.messages as Array<Record<string, unknown>>;
    const content = messages?.[1]?.content as Array<Record<string, unknown>>;
    expect(content).toHaveLength(3);
    const cc0 = (content[0]?.providerOptions as Record<string, unknown>)?.anthropic as
      | Record<string, unknown>
      | undefined;
    const cc1 = (content[1]?.providerOptions as Record<string, unknown>)?.anthropic as
      | Record<string, unknown>
      | undefined;
    expect(cc0?.cacheControl).toEqual({ type: "ephemeral" });
    expect(cc1?.cacheControl).toEqual({ type: "ephemeral", ttl: "1h" });
    expect(content[2]?.providerOptions).toBeUndefined();
    // Caller-supplied openrouter option survives.
    expect((call.providerOptions as Record<string, unknown>).openrouter).toEqual({
      promptCacheKey: "multi-bp",
    });
  });
});

describe("Anthropic cache injection — malformed cacheControl fails loudly", () => {
  it("throws a typed error and sends no request for an unsupported type", async () => {
    const { generateText } = mockModules();
    const { handleTextLarge } = await import("../models/text");

    await expect(
      handleTextLarge(createRuntime(), {
        prompt: "hello",
        providerOptions: {
          anthropic: { cacheControl: { type: "persistent" } },
        },
      } as never)
    ).rejects.toMatchObject({
      name: "ElizaError",
      code: "OPENROUTER_INVALID_CACHE_CONTROL",
      message: expect.stringMatching(/cacheControl/),
    });
    expect(generateText).not.toHaveBeenCalled();
  });

  it("throws and sends no request when cacheControl is not an object", async () => {
    const { generateText } = mockModules();
    const { handleTextLarge } = await import("../models/text");

    await expect(
      handleTextLarge(createRuntime(), {
        prompt: "hello",
        providerOptions: { anthropic: { cacheControl: "ephemeral" } },
      } as never)
    ).rejects.toThrow(/cacheControl/);
    expect(generateText).not.toHaveBeenCalled();
  });

  it("throws and sends no request for an unsupported cacheControl TTL", async () => {
    const { generateText } = mockModules();
    const { handleTextLarge } = await import("../models/text");

    await expect(
      handleTextLarge(createRuntime(), {
        prompt: "hello",
        providerOptions: {
          anthropic: { cacheControl: { type: "ephemeral", ttl: "2h" } },
        },
      } as never)
    ).rejects.toThrow(/ttl/);
    expect(generateText).not.toHaveBeenCalled();
  });
});

describe("Anthropic cache breakpoints — malformed plans fail loudly", () => {
  function segmentedParams(anthropic: Record<string, unknown>): GenerateTextParams {
    return {
      prompt: "s0s1s2s3",
      promptSegments: [
        { content: "s0", stable: true },
        { content: "s1", stable: false },
        { content: "s2", stable: true },
        { content: "s3", stable: false },
      ],
      providerOptions: { anthropic },
    } as never;
  }

  async function expectBreakpointRejection(params: GenerateTextParams, pattern: RegExp) {
    vi.resetModules();
    const { generateText } = mockModules();
    const { handleTextLarge } = await import("../models/text");

    await expect(handleTextLarge(createRuntime(), params)).rejects.toMatchObject({
      name: "ElizaError",
      code: "OPENROUTER_INVALID_CACHE_BREAKPOINT",
      message: expect.stringMatching(pattern),
    });
    expect(generateText).not.toHaveBeenCalled();
  }

  it("rejects a non-array cacheBreakpoints value", async () => {
    await expectBreakpointRejection(
      segmentedParams({ cacheBreakpoints: "not-an-array" }),
      /expected an array/
    );
  });

  const malformedBreakpointCases: Array<[string, unknown, RegExp]> = [
    ["null entry", [null], /cacheBreakpoints\[0\]/],
    ["primitive entry", [42], /cacheBreakpoints\[0\]/],
    [
      "string segment index",
      [{ segmentIndex: "0", cacheControl: { type: "ephemeral" } }],
      /segmentIndex/,
    ],
    [
      "negative segment index",
      [{ segmentIndex: -1, cacheControl: { type: "ephemeral" } }],
      /segmentIndex/,
    ],
    [
      "fractional segment index",
      [{ segmentIndex: 0.5, cacheControl: { type: "ephemeral" } }],
      /segmentIndex/,
    ],
    ["missing cacheControl", [{ segmentIndex: 0 }], /cacheControl/],
    [
      "unsupported cacheControl type",
      [{ segmentIndex: 0, cacheControl: { type: "persistent" } }],
      /cacheControl/,
    ],
    [
      "unsupported TTL",
      [{ segmentIndex: 0, cacheControl: { type: "ephemeral", ttl: "2h" } }],
      /ttl/,
    ],
    ["numeric TTL", [{ segmentIndex: 0, cacheControl: { type: "ephemeral", ttl: 300 } }], /ttl/],
  ];

  it.each(malformedBreakpointCases)("rejects a %s", async (_label, cacheBreakpoints, pattern) => {
    await expectBreakpointRejection(segmentedParams({ cacheBreakpoints }), pattern);
  });

  it("rejects a mixed plan instead of applying only its valid entries", async () => {
    await expectBreakpointRejection(
      segmentedParams({
        cacheBreakpoints: [
          { segmentIndex: 0, cacheControl: { type: "ephemeral" } },
          { segmentIndex: 1, cacheControl: { type: "ephemeral", ttl: "30s" } },
        ],
      }),
      /cacheBreakpoints\[1\]/
    );
  });

  it("validates entries beyond the applied cap", async () => {
    await expectBreakpointRejection(
      segmentedParams({
        maxBreakpoints: 1,
        cacheBreakpoints: [
          { segmentIndex: 0, cacheControl: { type: "ephemeral" } },
          { segmentIndex: 1, cacheControl: { type: "broken" } },
        ],
      }),
      /cacheBreakpoints\[1\]/
    );
  });

  it("rejects duplicate segment indices before Map materialization", async () => {
    await expectBreakpointRejection(
      segmentedParams({
        cacheBreakpoints: [
          { segmentIndex: 0, cacheControl: { type: "ephemeral" } },
          { segmentIndex: 0, cacheControl: { type: "ephemeral", ttl: "1h" } },
        ],
      }),
      /duplicate index/
    );
  });

  it("rejects a segment index outside promptSegments", async () => {
    await expectBreakpointRejection(
      segmentedParams({
        cacheBreakpoints: [{ segmentIndex: 4, cacheControl: { type: "ephemeral" } }],
      }),
      /outside promptSegments/
    );
  });

  const malformedMaxBreakpointCases: Array<[string, unknown]> = [
    ["negative", -1],
    ["fractional", 1.5],
    ["over the provider cap", 5],
    ["non-numeric", "3"],
  ];

  it.each(
    malformedMaxBreakpointCases
  )("rejects a %s maxBreakpoints value", async (_label, maxBreakpoints) => {
    await expectBreakpointRejection(
      segmentedParams({
        maxBreakpoints,
        cacheBreakpoints: [{ segmentIndex: 0, cacheControl: { type: "ephemeral" } }],
      }),
      /maxBreakpoints/
    );
  });

  it("accepts the core planner's four-block cap while applying at most three user markers", async () => {
    const { generateText } = mockModules();
    const { handleTextLarge } = await import("../models/text");

    await handleTextLarge(
      createRuntime(),
      segmentedParams({
        maxBreakpoints: 4,
        cacheBreakpoints: [
          { segmentIndex: 0, cacheControl: { type: "ephemeral" } },
          { segmentIndex: 1, cacheControl: { type: "ephemeral" } },
          { segmentIndex: 2, cacheControl: { type: "ephemeral" } },
          { segmentIndex: 3, cacheControl: { type: "ephemeral" } },
        ],
      })
    );

    const call = generateText.mock.calls[0][0] as Record<string, unknown>;
    const messages = call.messages as Array<Record<string, unknown>>;
    const content = messages[1]?.content as Array<Record<string, unknown>>;
    expect(content.filter((part) => part.providerOptions)).toHaveLength(3);
  });

  it("rejects breakpoints without promptSegments on prompt and messages inputs", async () => {
    const cacheBreakpoints = [{ segmentIndex: 0, cacheControl: { type: "ephemeral" } }];
    await expectBreakpointRejection(
      {
        prompt: "flat prompt",
        providerOptions: { anthropic: { cacheBreakpoints } },
      } as never,
      /promptSegments are required/
    );
    await expectBreakpointRejection(
      {
        messages: [{ role: "user", content: "flat message" }],
        providerOptions: { anthropic: { cacheBreakpoints } },
      } as never,
      /promptSegments are required/
    );
  });

  it("validates malformed breakpoints on the messages plus promptSegments path", async () => {
    await expectBreakpointRejection(
      {
        messages: [{ role: "user", content: "s0" }],
        promptSegments: [{ content: "s0", stable: true }],
        providerOptions: {
          anthropic: {
            cacheBreakpoints: [{ segmentIndex: 0, cacheControl: { type: "ephemeral", ttl: "2h" } }],
          },
        },
      } as never,
      /ttl/
    );
  });
});

describe("Non-Anthropic routes skip Anthropic cache validation", () => {
  it("sends the request without parsing the unused malformed namespace", async () => {
    const { generateText } = mockModules();
    const { handleTextLarge } = await import("../models/text");
    const anthropic = {
      cacheControl: { type: "persistent", ttl: "2h" },
      cacheBreakpoints: "not-an-array",
      maxBreakpoints: "unbounded",
    };

    await handleTextLarge(createRuntime({ OPENROUTER_LARGE_MODEL: "google/gemini-2.5-flash" }), {
      prompt: "hello",
      providerOptions: { anthropic },
    } as never);

    expect(generateText).toHaveBeenCalledTimes(1);
    const call = generateText.mock.calls[0][0] as Record<string, unknown>;
    expect((call.providerOptions as Record<string, unknown>).anthropic).toEqual(anthropic);
  });
});

describe("Anthropic cache injection — cacheSystem:false opt-out", () => {
  it("passes system as plain string and does not inject cacheControl on system message", async () => {
    const { generateText } = mockModules();
    const { handleTextLarge } = await import("../models/text");

    await handleTextLarge(createRuntime(), {
      messages: [
        { role: "system", content: "system prompt" },
        { role: "user", content: "hello" },
      ],
      providerOptions: {
        anthropic: { cacheSystem: false },
      },
    } as never);

    const call = generateText.mock.calls[0][0] as Record<string, unknown>;
    // With cacheSystem:false the system is forwarded as call.system, not as a message
    // with providerOptions, so there is no Anthropic cacheControl on any message.
    expect(call.system).toBe("system prompt");
    expect(call.messages).toEqual([{ role: "user", content: "hello" }]);
    if (Array.isArray(call.messages)) {
      for (const msg of call.messages as Array<Record<string, unknown>>) {
        expect(msg?.providerOptions).toBeUndefined();
      }
    }
  });

  it("still applies valid user breakpoints and strips local fields", async () => {
    const { generateText } = mockModules();
    const { handleTextLarge } = await import("../models/text");

    await handleTextLarge(createRuntime(), {
      prompt: "s0s1",
      promptSegments: [
        { content: "s0", stable: true },
        { content: "s1", stable: false },
      ],
      providerOptions: {
        anthropic: {
          cacheSystem: false,
          maxBreakpoints: 1,
          cacheBreakpoints: [{ segmentIndex: 0, cacheControl: { type: "ephemeral", ttl: "1h" } }],
        },
      },
    } as never);

    const call = generateText.mock.calls[0][0] as Record<string, unknown>;
    expect(call.system).toBe("system prompt");
    const messages = call.messages as Array<Record<string, unknown>>;
    const content = messages[0]?.content as Array<Record<string, unknown>>;
    expect(content[0]?.providerOptions).toEqual({
      anthropic: { cacheControl: { type: "ephemeral", ttl: "1h" } },
    });
    expect(JSON.stringify(call.providerOptions ?? {})).not.toContain("cacheSystem");
    expect(JSON.stringify(call.providerOptions ?? {})).not.toContain("cacheBreakpoints");
    expect(JSON.stringify(call.providerOptions ?? {})).not.toContain("maxBreakpoints");
  });
});

describe("Anthropic cache injection — tools and trajectory breakpoints", () => {
  const trajectory = [
    { role: "user", content: [{ type: "text", text: "question" }] },
    {
      role: "assistant",
      content: [{ type: "tool-call", toolCallId: "1", toolName: "READ", input: {} }],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "1",
          toolName: "READ",
          output: { type: "text", value: "result" },
        },
      ],
    },
  ];

  it("stamps only the last tool and the kept-trajectory tail", async () => {
    const { generateText } = mockModules();
    const { handleTextLarge } = await import("../models/text");
    await handleTextLarge(createRuntime(), {
      prompt: "ignored",
      messages: trajectory,
      tools: {
        READ: { description: "Read", inputSchema: { type: "object" } },
        WRITE: { description: "Write", inputSchema: { type: "object" } },
      },
    } as never);

    const call = generateText.mock.calls[0][0] as Record<string, unknown>;
    const tools = call.tools as Record<string, Record<string, unknown>>;
    expect(tools.READ.providerOptions).toBeUndefined();
    expect(tools.WRITE.providerOptions).toEqual({
      anthropic: { cacheControl: { type: "ephemeral" } },
    });
    const messages = call.messages as Array<Record<string, unknown>>;
    const tail = (messages.at(-1)?.content as Array<Record<string, unknown>>).at(-1);
    expect(tail?.providerOptions).toEqual({
      anthropic: { cacheControl: { type: "ephemeral" } },
    });
    const leadingUserPart = (messages[1]?.content as Array<Record<string, unknown>>)[0];
    expect(leadingUserPart.providerOptions).toBeUndefined();
  });

  it("honors opt-outs, strips local flags, and preserves the runtime TTL", async () => {
    const { generateText } = mockModules();
    const { handleTextLarge } = await import("../models/text");
    await handleTextLarge(createRuntime({ ANTHROPIC_PROMPT_CACHE_TTL: "1h" }), {
      prompt: "ignored",
      messages: trajectory,
      tools: { READ: { description: "Read", inputSchema: { type: "object" } } },
      providerOptions: {
        anthropic: { cacheTools: false, cacheTrajectory: false },
      },
    } as never);

    const call = generateText.mock.calls[0][0] as Record<string, unknown>;
    const tools = call.tools as Record<string, Record<string, unknown>>;
    expect(tools.READ.providerOptions).toBeUndefined();
    const messages = call.messages as Array<Record<string, unknown>>;
    const tail = (messages.at(-1)?.content as Array<Record<string, unknown>>).at(-1);
    expect(tail?.providerOptions).toBeUndefined();
    expect(JSON.stringify(call.providerOptions ?? {})).not.toContain("cacheTools");
    expect(JSON.stringify(call.providerOptions ?? {})).not.toContain("cacheTrajectory");
    const systemAnthropic = (messages[0]?.providerOptions as Record<string, unknown>)?.anthropic;
    expect(systemAnthropic).toEqual({
      cacheControl: { type: "ephemeral", ttl: "1h" },
    });
  });
});

describe("Anthropic cache injection — breakpoint budget", () => {
  it("reserves one of the four cache slots for the tools breakpoint", async () => {
    const { generateText } = mockModules();
    const { handleTextLarge } = await import("../models/text");
    await handleTextLarge(createRuntime(), {
      prompt: "s0s1s2",
      promptSegments: [
        { content: "s0", stable: true },
        { content: "s1", stable: true },
        { content: "s2", stable: true },
      ],
      tools: { READ: { description: "Read", inputSchema: { type: "object" } } },
      providerOptions: {
        anthropic: {
          maxBreakpoints: 3,
          cacheBreakpoints: [
            { segmentIndex: 0, cacheControl: { type: "ephemeral" } },
            { segmentIndex: 1, cacheControl: { type: "ephemeral" } },
            { segmentIndex: 2, cacheControl: { type: "ephemeral" } },
          ],
        },
      },
    } as never);
    const call = generateText.mock.calls[0][0] as Record<string, unknown>;
    const messages = call.messages as Array<Record<string, unknown>>;
    const segmentParts = messages[1]?.content as Array<Record<string, unknown>>;
    expect(segmentParts.filter((part) => part.providerOptions)).toHaveLength(2);
    expect(
      (call.tools as Record<string, Record<string, unknown>>).READ.providerOptions
    ).toBeDefined();
  });
});
