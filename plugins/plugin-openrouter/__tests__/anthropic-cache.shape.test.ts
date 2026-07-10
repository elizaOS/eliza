/**
 * Shape tests for Anthropic prompt-cache injection in the OpenRouter text handler.
 * Covers the runtime-fallback cacheControl (Fix 2), internal-field stripping from wire
 * options (Fix 3a), segmented-user-content breakpoints with validated shapes and capping
 * (Fix 3b/3c), the cacheSystem:false opt-out, verbatim survival of caller-supplied
 * providerOptions (openrouter + arbitrary keys) alongside injected cacheControl and
 * multi-breakpoint stamping (#15825), the explicit boundary failure when a
 * caller-supplied cacheControl or cacheBreakpoint is malformed (#15825/#15966 — typed
 * ElizaError, no silent drop or normalization, no provider request sent), and the
 * provider-scoping contract that non-Anthropic routes never parse or reject the unused
 * anthropic namespace (#15966). AI SDK and provider are mocked — no network calls,
 * deterministic string fixtures.
 */
import type { IAgentRuntime } from "@elizaos/core";
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
    createOpenRouterProvider: () => ({ chat: (m: string) => ({ modelName: m }) }),
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
    expect(anthropicOpts?.cacheControl).toEqual({ type: "ephemeral", ttl: "1h" });
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
    expect(providerOpts.openrouter).toEqual({ promptCacheKey: "caller-key-123" });
    expect(providerOpts.gateway).toEqual({ caching: "auto" });
    expect(providerOpts.customProvider).toEqual({ nested: { flag: true }, count: 7 });
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
  it("throws a typed error and sends no request when cacheControl has an unsupported type", async () => {
    const { generateText } = mockModules();
    const { handleTextLarge } = await import("../models/text");

    await expect(
      handleTextLarge(createRuntime(), {
        prompt: "hello",
        providerOptions: { anthropic: { cacheControl: { type: "persistent" } } },
      } as never)
    ).rejects.toMatchObject({
      name: "ElizaError",
      code: "OPENROUTER_INVALID_CACHE_CONTROL",
    });
    expect(generateText).not.toHaveBeenCalled();
  });

  it("throws and sends no request when cacheControl is present but not an object", async () => {
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

  it("throws and sends no request when cacheControl.ttl is an unsupported value", async () => {
    const { generateText } = mockModules();
    const { handleTextLarge } = await import("../models/text");

    await expect(
      handleTextLarge(createRuntime(), {
        prompt: "hello",
        providerOptions: { anthropic: { cacheControl: { type: "ephemeral", ttl: "2h" } } },
      } as never)
    ).rejects.toThrow(/ttl/);
    expect(generateText).not.toHaveBeenCalled();
  });
});

describe("Anthropic cache breakpoints — malformed shapes fail loudly (#15966)", () => {
  // Shared fixture: an Anthropic-routed prompt-only call with segments, so any
  // supplied breakpoints are actually consumed by the segmented-content path.
  function segmentedParams(anthropic: Record<string, unknown>) {
    return {
      prompt: "s0s1",
      promptSegments: [
        { content: "s0", stable: true },
        { content: "s1", stable: false },
      ],
      providerOptions: { anthropic },
    } as never;
  }

  async function expectBreakpointRejection(anthropic: Record<string, unknown>, pattern: RegExp) {
    // Fresh registry per invocation so tests that assert several shapes in one
    // body bind the handler to the mock actually being inspected.
    vi.resetModules();
    const { generateText } = mockModules();
    const { handleTextLarge } = await import("../models/text");

    const call = handleTextLarge(createRuntime(), segmentedParams(anthropic));
    await expect(call).rejects.toMatchObject({
      name: "ElizaError",
      code: "OPENROUTER_INVALID_CACHE_BREAKPOINT",
    });
    await expect(call).rejects.toThrow(pattern);
    // No provider request may be sent after a malformed consumed option.
    expect(generateText).not.toHaveBeenCalled();
  }

  it("throws when cacheBreakpoints is present but not an array", async () => {
    await expectBreakpointRejection({ cacheBreakpoints: "not-an-array" }, /expected an array/);
  });

  it("throws when a breakpoint entry is null", async () => {
    await expectBreakpointRejection({ cacheBreakpoints: [null] }, /cacheBreakpoints\[0\]/);
  });

  it("throws when a breakpoint entry is a primitive", async () => {
    await expectBreakpointRejection({ cacheBreakpoints: [42] }, /cacheBreakpoints\[0\]/);
  });

  it("throws when segmentIndex is not a number", async () => {
    await expectBreakpointRejection(
      { cacheBreakpoints: [{ segmentIndex: "not-a-number", cacheControl: { type: "ephemeral" } }] },
      /segmentIndex/
    );
  });

  it("throws when segmentIndex is negative", async () => {
    await expectBreakpointRejection(
      { cacheBreakpoints: [{ segmentIndex: -1, cacheControl: { type: "ephemeral" } }] },
      /segmentIndex/
    );
  });

  it("throws when segmentIndex is a non-integer number", async () => {
    await expectBreakpointRejection(
      { cacheBreakpoints: [{ segmentIndex: 0.5, cacheControl: { type: "ephemeral" } }] },
      /segmentIndex/
    );
  });

  it("throws when a breakpoint cacheControl is missing", async () => {
    await expectBreakpointRejection({ cacheBreakpoints: [{ segmentIndex: 0 }] }, /cacheControl/);
  });

  it("throws when a breakpoint cacheControl type is not ephemeral", async () => {
    await expectBreakpointRejection(
      { cacheBreakpoints: [{ segmentIndex: 0, cacheControl: { type: "invalid" } }] },
      /cacheControl/
    );
  });

  it("throws when a breakpoint TTL is an unsupported duration", async () => {
    await expectBreakpointRejection(
      { cacheBreakpoints: [{ segmentIndex: 0, cacheControl: { type: "ephemeral", ttl: "2h" } }] },
      /ttl/
    );
  });

  it("throws when a breakpoint TTL is numeric", async () => {
    await expectBreakpointRejection(
      { cacheBreakpoints: [{ segmentIndex: 0, cacheControl: { type: "ephemeral", ttl: 300 } }] },
      /ttl/
    );
  });

  it("throws on a mixed array instead of applying only the valid entries", async () => {
    await expectBreakpointRejection(
      {
        cacheBreakpoints: [
          { segmentIndex: 0, cacheControl: { type: "ephemeral" } },
          { segmentIndex: 1, cacheControl: { type: "ephemeral", ttl: "30s" } },
        ],
      },
      /cacheBreakpoints\[1\]/
    );
  });

  it("validates entries past the maxBreakpoints cap instead of dropping them unseen", async () => {
    await expectBreakpointRejection(
      {
        maxBreakpoints: 1,
        cacheBreakpoints: [
          { segmentIndex: 0, cacheControl: { type: "ephemeral" } },
          { segmentIndex: 1, cacheControl: { type: "broken" } },
        ],
      },
      /cacheBreakpoints\[1\]/
    );
  });

  it("throws when maxBreakpoints is present but malformed", async () => {
    await expectBreakpointRejection(
      {
        maxBreakpoints: -1,
        cacheBreakpoints: [{ segmentIndex: 0, cacheControl: { type: "ephemeral" } }],
      },
      /maxBreakpoints/
    );
    await expectBreakpointRejection(
      {
        maxBreakpoints: 1.5,
        cacheBreakpoints: [{ segmentIndex: 0, cacheControl: { type: "ephemeral" } }],
      },
      /maxBreakpoints/
    );
  });

  it("accepts maxBreakpoints: 0 as an explicit opt-out of segment stamping", async () => {
    const { generateText } = mockModules();
    const { handleTextLarge } = await import("../models/text");

    await handleTextLarge(
      createRuntime(),
      segmentedParams({
        maxBreakpoints: 0,
        cacheBreakpoints: [{ segmentIndex: 0, cacheControl: { type: "ephemeral" } }],
      })
    );

    const call = generateText.mock.calls[0][0] as Record<string, unknown>;
    const messages = call.messages as Array<Record<string, unknown>>;
    const content = messages?.[1]?.content;
    // With zero slots the prompt collapses to the unsegmented single text block —
    // valid breakpoints are validated but none are stamped.
    if (Array.isArray(content)) {
      for (const block of content as Array<Record<string, unknown>>) {
        expect(block.providerOptions).toBeUndefined();
      }
    }
  });
});

describe("Non-Anthropic routes skip Anthropic cache validation (#15966)", () => {
  const NON_ANTHROPIC = { OPENROUTER_LARGE_MODEL: "google/gemini-2.5-flash" };

  it("does not reject a malformed anthropic.cacheControl and still sends the request", async () => {
    const { generateText } = mockModules();
    const { handleTextLarge } = await import("../models/text");

    await handleTextLarge(createRuntime(NON_ANTHROPIC), {
      prompt: "hello",
      providerOptions: { anthropic: { cacheControl: { type: "persistent", ttl: "2h" } } },
    } as never);

    expect(generateText).toHaveBeenCalledTimes(1);
    const call = generateText.mock.calls[0][0] as Record<string, unknown>;
    // No Anthropic message-level injection happens on this route; the unused
    // namespace passes through unparsed rather than failing the request.
    expect(call.prompt).toBe("hello");
    expect((call.providerOptions as Record<string, unknown>).anthropic).toEqual({
      cacheControl: { type: "persistent", ttl: "2h" },
    });
  });

  it("does not reject malformed anthropic.cacheBreakpoints and applies no segment stamping", async () => {
    const { generateText } = mockModules();
    const { handleTextLarge } = await import("../models/text");

    await handleTextLarge(createRuntime(NON_ANTHROPIC), {
      prompt: "s0s1",
      promptSegments: [
        { content: "s0", stable: true },
        { content: "s1", stable: false },
      ],
      providerOptions: {
        anthropic: {
          maxBreakpoints: "broken",
          cacheBreakpoints: [null, { segmentIndex: -1, cacheControl: { type: "nope" } }],
        },
      },
    } as never);

    expect(generateText).toHaveBeenCalledTimes(1);
    const call = generateText.mock.calls[0][0] as Record<string, unknown>;
    expect(call.prompt).toBe("s0s1");
    if (Array.isArray(call.messages)) {
      for (const msg of call.messages as Array<Record<string, unknown>>) {
        expect(msg?.providerOptions).toBeUndefined();
      }
    }
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
});
