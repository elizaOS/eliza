import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";

import {
  __INTERNAL_normalizeNativeMessages,
  __INTERNAL_resolveProviderOptions,
} from "../models/text";

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

  it("preserves text + tool-call parts when no reasoning is present (no-op safety)", () => {
    const before = [
      { type: "text", text: "hi" },
      { type: "tool-call", toolCallId: "t1", toolName: "x", input: {} },
    ];
    const normalized = __INTERNAL_normalizeNativeMessages([{ role: "assistant", content: before }]);
    expect((normalized?.[0] as { content: unknown[] }).content).toEqual(before);
  });
});
