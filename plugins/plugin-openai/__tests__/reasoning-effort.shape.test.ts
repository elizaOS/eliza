/**
 * Shape test verifying `OPENAI_REASONING_EFFORT` forwards into
 * `providerOptions.openai.reasoningEffort` for the four valid efforts. Mocked
 * runtime.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  __INTERNAL_normalizeNativeMessages,
  __INTERNAL_resolveProviderOptions,
} from "../models/text";

// `isCerebrasMode` resolves settings through utils/config `getSetting`, which
// falls back to `process.env` when the mocked runtime returns null. On a
// credentialed runner (OPENAI_API_KEY / OPENAI_BASE_URL / ELIZA_PROVIDER set,
// e.g. pointing at Cerebras) that fallback flips provider-mode detection and
// breaks every mode-sensitive case below. Pin the mode-detection env to empty
// so the mocked runtime settings are the only input.
beforeEach(() => {
  vi.stubEnv("OPENAI_API_KEY", "");
  vi.stubEnv("OPENAI_BASE_URL", "");
  vi.stubEnv("ELIZA_PROVIDER", "");
  vi.stubEnv("CEREBRAS_API_KEY", "");
  vi.stubEnv("OPENAI_REASONING_EFFORT", "");
});

function buildRuntime(settings: Record<string, string | undefined>): IAgentRuntime {
  return {
    getSetting: vi.fn((key: string) => (key in settings ? (settings[key] ?? null) : null)),
    character: { name: "test" } as never,
  } as unknown as IAgentRuntime;
}

describe("OPENAI_REASONING_EFFORT env-var forwarding", () => {
  it("forwards a valid OPENAI_REASONING_EFFORT into providerOptions.openai.reasoningEffort", () => {
    const runtime = buildRuntime({ OPENAI_REASONING_EFFORT: "low" });
    const opts = __INTERNAL_resolveProviderOptions({ prompt: "hi" } as never, runtime);
    expect(opts).toBeDefined();
    expect(
      (opts as { openai?: { reasoningEffort?: string } } | undefined)?.openai?.reasoningEffort
    ).toBe("low");
  });

  it("accepts all four spec-valid efforts (minimal/low/medium/high)", () => {
    for (const effort of ["minimal", "low", "medium", "high"] as const) {
      const runtime = buildRuntime({ OPENAI_REASONING_EFFORT: effort });
      const opts = __INTERNAL_resolveProviderOptions({ prompt: "hi" } as never, runtime);
      expect(
        (opts as { openai?: { reasoningEffort?: string } } | undefined)?.openai?.reasoningEffort
      ).toBe(effort);
    }
  });

  it("normalizes case + whitespace (LOW → low, ' high ' → high)", () => {
    const runtime = buildRuntime({ OPENAI_REASONING_EFFORT: "  MEDIUM " });
    const opts = __INTERNAL_resolveProviderOptions({ prompt: "hi" } as never, runtime);
    expect(
      (opts as { openai?: { reasoningEffort?: string } } | undefined)?.openai?.reasoningEffort
    ).toBe("medium");
  });

  it("returns no reasoningEffort when env-var is unset (backwards compatible)", () => {
    const runtime = buildRuntime({});
    const opts = __INTERNAL_resolveProviderOptions({ prompt: "hi" } as never, runtime);
    // Either undefined entirely OR an opts object with no reasoningEffort.
    const openai = (opts as { openai?: { reasoningEffort?: string } } | undefined)?.openai;
    expect(openai?.reasoningEffort).toBeUndefined();
  });

  it("ignores an unrecognized effort value (logs warn, sends nothing)", () => {
    const runtime = buildRuntime({ OPENAI_REASONING_EFFORT: "extreme" });
    const opts = __INTERNAL_resolveProviderOptions({ prompt: "hi" } as never, runtime);
    const openai = (opts as { openai?: { reasoningEffort?: string } } | undefined)?.openai;
    expect(openai?.reasoningEffort).toBeUndefined();
  });

  it("caller-supplied providerOptions.openai.reasoningEffort beats the env-var", () => {
    const runtime = buildRuntime({ OPENAI_REASONING_EFFORT: "low" });
    const opts = __INTERNAL_resolveProviderOptions(
      {
        prompt: "hi",
        providerOptions: { openai: { reasoningEffort: "high" } },
      } as never,
      runtime
    );
    expect(
      (opts as { openai?: { reasoningEffort?: string } } | undefined)?.openai?.reasoningEffort
    ).toBe("high");
  });
});

describe("Cerebras default reasoning effort", () => {
  // CEREBRAS_API_KEY set with no OPENAI_API_KEY / OPENAI_BASE_URL ⇒ Cerebras mode.
  // The default only applies to reasoning-capable models (e.g. gpt-oss-120b);
  // non-reasoning models (Llama, etc.) reject reasoning_effort and must not
  // receive it, so these cases pass the model name explicitly.
  const REASONING_MODEL = "gpt-oss-120b";

  it("defaults to 'low' for a reasoning model in Cerebras mode when OPENAI_REASONING_EFFORT is unset", () => {
    const runtime = buildRuntime({ CEREBRAS_API_KEY: "csk-test" });
    const opts = __INTERNAL_resolveProviderOptions(
      { prompt: "hi" } as never,
      runtime,
      REASONING_MODEL
    );
    expect(
      (opts as { openai?: { reasoningEffort?: string } } | undefined)?.openai?.reasoningEffort
    ).toBe("low");
  });

  it("defaults to 'low' for zai-glm-4.7 (hybrid reasoning; the Cerebras default is gemma-4-31b)", () => {
    const runtime = buildRuntime({ CEREBRAS_API_KEY: "csk-test" });
    const opts = __INTERNAL_resolveProviderOptions(
      { prompt: "hi" } as never,
      runtime,
      "zai-glm-4.7"
    );
    expect(
      (opts as { openai?: { reasoningEffort?: string } } | undefined)?.openai?.reasoningEffort
    ).toBe("low");
  });

  it.each([
    "glm-4.7",
    "zai-glm-4.7-preview",
    "my-glm-router",
  ])("does not infer reasoning support from a GLM-like model id: %s", (modelName) => {
    const runtime = buildRuntime({ CEREBRAS_API_KEY: "csk-test" });
    const opts = __INTERNAL_resolveProviderOptions({ prompt: "hi" } as never, runtime, modelName);
    const openai = (opts as { openai?: { reasoningEffort?: string } } | undefined)?.openai;
    expect(openai?.reasoningEffort).toBeUndefined();
  });

  it("does NOT default reasoning effort for a non-reasoning Cerebras model", () => {
    const runtime = buildRuntime({ CEREBRAS_API_KEY: "csk-test" });
    const opts = __INTERNAL_resolveProviderOptions(
      { prompt: "hi" } as never,
      runtime,
      "llama-3.3-70b"
    );
    const openai = (opts as { openai?: { reasoningEffort?: string } } | undefined)?.openai;
    expect(openai?.reasoningEffort).toBeUndefined();
  });

  it("lets an explicit valid OPENAI_REASONING_EFFORT override the Cerebras default", () => {
    const runtime = buildRuntime({ CEREBRAS_API_KEY: "csk-test", OPENAI_REASONING_EFFORT: "high" });
    const opts = __INTERNAL_resolveProviderOptions(
      { prompt: "hi" } as never,
      runtime,
      REASONING_MODEL
    );
    expect(
      (opts as { openai?: { reasoningEffort?: string } } | undefined)?.openai?.reasoningEffort
    ).toBe("high");
  });

  it("falls back to the Cerebras default 'low' when the explicit value is invalid", () => {
    const runtime = buildRuntime({
      CEREBRAS_API_KEY: "csk-test",
      OPENAI_REASONING_EFFORT: "extreme",
    });
    const opts = __INTERNAL_resolveProviderOptions(
      { prompt: "hi" } as never,
      runtime,
      REASONING_MODEL
    );
    expect(
      (opts as { openai?: { reasoningEffort?: string } } | undefined)?.openai?.reasoningEffort
    ).toBe("low");
  });

  it("lets caller-supplied providerOptions.openai.reasoningEffort beat the Cerebras default", () => {
    const runtime = buildRuntime({ CEREBRAS_API_KEY: "csk-test" });
    const opts = __INTERNAL_resolveProviderOptions(
      { prompt: "hi", providerOptions: { openai: { reasoningEffort: "medium" } } } as never,
      runtime,
      REASONING_MODEL
    );
    expect(
      (opts as { openai?: { reasoningEffort?: string } } | undefined)?.openai?.reasoningEffort
    ).toBe("medium");
  });
});

describe("eliza.thinking='off' reasoning suppression (Cerebras mode)", () => {
  // Core's planner loop and Stage-1 formatting calls signal "don't reason"
  // via providerOptions.eliza.thinking = "off". The two documented Cerebras
  // reasoning models use different suppression floors: zai-glm-4.7 accepts
  // "none" while gpt-oss-120b only goes down to "low".
  const thinkingOff = { prompt: "hi", providerOptions: { eliza: { thinking: "off" } } } as never;

  it("maps thinking-off to 'none' for zai-glm-4.7", () => {
    const runtime = buildRuntime({ CEREBRAS_API_KEY: "csk-test" });
    const opts = __INTERNAL_resolveProviderOptions(thinkingOff, runtime, "zai-glm-4.7");
    expect(
      (opts as { openai?: { reasoningEffort?: string } } | undefined)?.openai?.reasoningEffort
    ).toBe("none");
  });

  it("maps thinking-off to 'low' for gpt-oss-120b (rejects 'none')", () => {
    const runtime = buildRuntime({ CEREBRAS_API_KEY: "csk-test" });
    const opts = __INTERNAL_resolveProviderOptions(thinkingOff, runtime, "gpt-oss-120b");
    expect(
      (opts as { openai?: { reasoningEffort?: string } } | undefined)?.openai?.reasoningEffort
    ).toBe("low");
  });

  it("sends nothing for a model without the reasoning_effort knob (llama)", () => {
    const runtime = buildRuntime({ CEREBRAS_API_KEY: "csk-test" });
    const opts = __INTERNAL_resolveProviderOptions(thinkingOff, runtime, "llama-3.3-70b");
    const openai = (opts as { openai?: { reasoningEffort?: string } } | undefined)?.openai;
    expect(openai?.reasoningEffort).toBeUndefined();
  });

  it.each([
    "gemma-4-31b",
    "gpt-oss-20b",
    "zai-glm-4.6",
    "custom-glm-router",
  ])("sends nothing for an undocumented model lookalike: %s", (modelName) => {
    const runtime = buildRuntime({ CEREBRAS_API_KEY: "csk-test" });
    const opts = __INTERNAL_resolveProviderOptions(thinkingOff, runtime, modelName);
    const openai = (opts as { openai?: { reasoningEffort?: string } } | undefined)?.openai;
    expect(openai?.reasoningEffort).toBeUndefined();
  });

  it.each([
    "cerebras:zai-glm-4.7",
    "cerebras/zai-glm-4.7",
    "openai/zai-glm-4.7",
  ])("normalizes a supported provider-prefixed model id: %s", (modelName) => {
    const runtime = buildRuntime({ CEREBRAS_API_KEY: "csk-test" });
    const opts = __INTERNAL_resolveProviderOptions(thinkingOff, runtime, modelName);
    expect(
      (opts as { openai?: { reasoningEffort?: string } } | undefined)?.openai?.reasoningEffort
    ).toBe("none");
  });

  it("suppression outranks a user-pinned OPENAI_REASONING_EFFORT (planner calls stay cheap)", () => {
    const runtime = buildRuntime({ CEREBRAS_API_KEY: "csk-test", OPENAI_REASONING_EFFORT: "high" });
    const opts = __INTERNAL_resolveProviderOptions(thinkingOff, runtime, "zai-glm-4.7");
    expect(
      (opts as { openai?: { reasoningEffort?: string } } | undefined)?.openai?.reasoningEffort
    ).toBe("none");
  });

  it("an explicit caller providerOptions.openai.reasoningEffort still wins", () => {
    const runtime = buildRuntime({ CEREBRAS_API_KEY: "csk-test" });
    const opts = __INTERNAL_resolveProviderOptions(
      {
        prompt: "hi",
        providerOptions: { eliza: { thinking: "off" }, openai: { reasoningEffort: "medium" } },
      } as never,
      runtime,
      "zai-glm-4.7"
    );
    expect(
      (opts as { openai?: { reasoningEffort?: string } } | undefined)?.openai?.reasoningEffort
    ).toBe("medium");
  });

  it("does NOT apply outside Cerebras mode (OpenAI-direct rejects 'none')", () => {
    const runtime = buildRuntime({ OPENAI_API_KEY: "sk-test" });
    const opts = __INTERNAL_resolveProviderOptions(thinkingOff, runtime, "zai-glm-4.7");
    const openai = (opts as { openai?: { reasoningEffort?: string } } | undefined)?.openai;
    expect(openai?.reasoningEffort).toBeUndefined();
  });
});

describe("strip reasoning-content from outbound assistant messages", () => {
  it("drops `type: reasoning` parts from a content array (tool-call branch)", () => {
    const normalized = __INTERNAL_normalizeNativeMessages([
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "let me think..." },
          { type: "text", text: "the answer is 42" },
        ],
        toolCalls: [{ toolCallId: "tc1", toolName: "calc", input: { x: 1 } }],
      },
    ]);
    const assistant = normalized?.[0] as {
      content: Array<{ type: string }>;
    };
    expect(assistant.content.some((p) => p.type === "reasoning")).toBe(false);
    expect(assistant.content.some((p) => p.type === "text")).toBe(true);
    expect(assistant.content.some((p) => p.type === "tool-call")).toBe(true);
  });

  it("drops `type: thinking` parts (Anthropic-style alias) from a content array", () => {
    const normalized = __INTERNAL_normalizeNativeMessages([
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "internal reasoning..." },
          { type: "text", text: "visible reply" },
        ],
      },
    ]);
    const assistant = normalized?.[0] as {
      content: Array<{ type: string }>;
    };
    expect(assistant.content.some((p) => p.type === "thinking")).toBe(false);
    expect(assistant.content).toEqual([{ type: "text", text: "visible reply" }]);
  });

  it("leaves string content untouched (no reasoning-part field to strip)", () => {
    const normalized = __INTERNAL_normalizeNativeMessages([
      { role: "assistant", content: "plain text reply" },
    ]);
    expect((normalized?.[0] as { content: string }).content).toBe("plain text reply");
  });

  it("preserves text + tool-call parts when no reasoning is present", () => {
    const before = [
      { type: "text", text: "hi" },
      { type: "tool-call", toolCallId: "t1", toolName: "x", input: {} },
    ];
    const normalized = __INTERNAL_normalizeNativeMessages([{ role: "assistant", content: before }]);
    expect((normalized?.[0] as { content: unknown[] }).content).toEqual(before);
  });
});
