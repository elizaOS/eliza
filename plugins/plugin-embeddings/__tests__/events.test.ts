/**
 * Regression tests for truncatePrompt via emitModelUsageEvent.
 * Ensures total output <= MAX_PROMPT_LENGTH (200) inclusive of suffix,
 * suffix preservation, and well-formed surrogate handling (non-BMP boundary).
 */

import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { emitModelUsageEvent } from "../src/utils/events";

const MAX = 200;
const SUFFIX = "…";

function createRuntime(): { runtime: IAgentRuntime; emit: ReturnType<typeof vi.fn> } {
  const emit = vi.fn(async () => undefined);
  const runtime = {
    emitEvent: emit,
  } as unknown as IAgentRuntime;
  return { runtime, emit };
}

function emittedPrompt(emit: ReturnType<typeof vi.fn>): string {
  expect(emit).toHaveBeenCalledTimes(1);
  const [, payload] = emit.mock.calls[0] as [unknown, { prompt: string }];
  return payload.prompt;
}

describe("emitModelUsageEvent truncation", () => {
  it("keeps at-cap (200) unchanged", () => {
    const { runtime, emit } = createRuntime();
    const prompt = "a".repeat(MAX);
    emitModelUsageEvent(runtime, "TEXT_EMBEDDING" as never, prompt, {});
    const out = emittedPrompt(emit);
    expect(out).toBe(prompt);
    expect(out.length).toBe(MAX);
  });

  it("truncates one-over (201) to 200 inclusive of suffix", () => {
    const { runtime, emit } = createRuntime();
    const prompt = "a".repeat(MAX + 1);
    emitModelUsageEvent(runtime, "TEXT_EMBEDDING" as never, prompt, {});
    const out = emittedPrompt(emit);
    expect(out.length).toBe(MAX);
    expect(out.endsWith(SUFFIX)).toBe(true);
    expect(out).toBe("a".repeat(MAX - SUFFIX.length) + SUFFIX);
    // Verify strict JSON well-formed
    expect(() => JSON.stringify({ prompt: out })).not.toThrow();
  });

  it("preserves suffix and respects cap for long prompt", () => {
    const { runtime, emit } = createRuntime();
    const prompt = "b".repeat(500);
    emitModelUsageEvent(runtime, "TEXT_EMBEDDING" as never, prompt, {});
    const out = emittedPrompt(emit);
    expect(out.length).toBe(MAX);
    expect(out.endsWith(SUFFIX)).toBe(true);
    expect(out.slice(0, MAX - SUFFIX.length)).toBe("b".repeat(MAX - SUFFIX.length));
  });

  it("does not split surrogate pair at truncation boundary (non-BMP)", () => {
    const { runtime, emit } = createRuntime();
    // 198 'a' + two emoji (each 2 code units) = 202 code units, forces cut inside first emoji if naive slice
    const prompt = `${"a".repeat(198)}😀😀`; // length 202
    expect(prompt.length).toBe(202);
    emitModelUsageEvent(runtime, "TEXT_EMBEDDING" as never, prompt, {});
    const out = emittedPrompt(emit);
    expect(out.length).toBeLessThanOrEqual(MAX);
    expect(out.endsWith(SUFFIX)).toBe(true);
    // Must be well-formed: no lone surrogate at end before suffix
    expect(/[\uD800-\uDBFF]$/.test(out.slice(0, -1))).toBe(false);
    expect(() => JSON.stringify({ prompt: out })).not.toThrow();
    // With 198 'a' + emoji, naive 199 slice would end with high surrogate; we expect 198 'a' + suffix = 199
    expect(out.length).toBe(199);
  });

  it("handles single emoji at boundary without breaking", () => {
    const { runtime, emit } = createRuntime();
    const prompt = `${"a".repeat(199)}😀`; // 201
    emitModelUsageEvent(runtime, "TEXT_EMBEDDING" as never, prompt, {});
    const out = emittedPrompt(emit);
    expect(out.length).toBe(MAX);
    expect(out.endsWith(SUFFIX)).toBe(true);
    expect(() => JSON.stringify({ prompt: out })).not.toThrow();
  });
});
