/**
 * Verifies that embedding usage events preserve complete prompts.
 */

import { type IAgentRuntime, ModelType } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { emitModelUsageEvent } from "../src/utils/events";

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

describe("emitModelUsageEvent prompt capture", () => {
  it("preserves a long prompt", () => {
    const { runtime, emit } = createRuntime();
    const prompt = `${"a".repeat(10_000)}😀tail`;
    emitModelUsageEvent(runtime, ModelType.TEXT_EMBEDDING, prompt, {});
    expect(emittedPrompt(emit)).toBe(prompt);
  });
});
