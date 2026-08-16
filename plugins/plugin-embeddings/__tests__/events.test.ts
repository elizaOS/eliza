/**
 * Verifies that embedding usage events keep prompts within their telemetry
 * budget without producing malformed UTF-16 at the truncation boundary.
 */

import { type IAgentRuntime, ModelType } from "@elizaos/core";
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
    emitModelUsageEvent(runtime, ModelType.TEXT_EMBEDDING, prompt, {});
    const out = emittedPrompt(emit);
    expect(out).toBe(prompt);
    expect(out.length).toBe(MAX);
  });

  it("truncates one-over (201) to 200 inclusive of suffix", () => {
    const { runtime, emit } = createRuntime();
    const prompt = "a".repeat(MAX + 1);
    emitModelUsageEvent(runtime, ModelType.TEXT_EMBEDDING, prompt, {});
    const out = emittedPrompt(emit);
    expect(out.length).toBe(MAX);
    expect(out.endsWith(SUFFIX)).toBe(true);
    expect(out).toBe("a".repeat(MAX - SUFFIX.length) + SUFFIX);
    expect(out.isWellFormed()).toBe(true);
  });

  it("preserves suffix and respects cap for long prompt", () => {
    const { runtime, emit } = createRuntime();
    const prompt = "b".repeat(500);
    emitModelUsageEvent(runtime, ModelType.TEXT_EMBEDDING, prompt, {});
    const out = emittedPrompt(emit);
    expect(out.length).toBe(MAX);
    expect(out.endsWith(SUFFIX)).toBe(true);
    expect(out.slice(0, MAX - SUFFIX.length)).toBe("b".repeat(MAX - SUFFIX.length));
  });

  it("does not split surrogate pair at truncation boundary (non-BMP)", () => {
    const { runtime, emit } = createRuntime();
    // The first emoji straddles the 199-code-unit content boundary.
    const prompt = `${"a".repeat(198)}😀😀`; // length 202
    expect(prompt.length).toBe(202);
    emitModelUsageEvent(runtime, ModelType.TEXT_EMBEDDING, prompt, {});
    const out = emittedPrompt(emit);
    expect(out.length).toBeLessThanOrEqual(MAX);
    expect(out.endsWith(SUFFIX)).toBe(true);
    expect(out.isWellFormed()).toBe(true);
    expect(out.length).toBe(199);
  });

  it("handles single emoji at boundary without breaking", () => {
    const { runtime, emit } = createRuntime();
    const prompt = `${"a".repeat(199)}😀`; // 201
    emitModelUsageEvent(runtime, ModelType.TEXT_EMBEDDING, prompt, {});
    const out = emittedPrompt(emit);
    expect(out.length).toBe(MAX);
    expect(out.endsWith(SUFFIX)).toBe(true);
    expect(out.isWellFormed()).toBe(true);
  });
});
