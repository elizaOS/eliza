/**
 * Mocked unit tests for `text-streaming.ts`.
 *
 * Validates the bridge from `node-llama-cpp`'s push-based `onTextChunk`
 * callback onto the elizaOS `TextStreamResult` shape that the runtime
 * drains. The fake session simulates three deltas ("Hel", "lo ", "world")
 * and asserts:
 *   - the optional `onChunk` hook fires once per delta in order,
 *   - `textStream` yields the same three deltas via the async iterator,
 *   - the resolved `text` promise is the full accumulation,
 *   - `usage` resolves to a `TokenUsage` from the estimator,
 *   - `finishReason` resolves to "stop" on success.
 */

import type { TokenUsage } from "@elizaos/core";
import type { LlamaChatSession } from "node-llama-cpp";
import { describe, expect, it, vi } from "vitest";
import { streamLlamaPrompt } from "../text-streaming.js";

type SimplePromptOptions = {
  onTextChunk?: (text: string) => void;
};

/**
 * Build a minimal `LlamaChatSession`-shaped fake whose `prompt()` invokes
 * the supplied chunks one by one through `onTextChunk`. We yield to the
 * microtask queue between chunks so the consumer's pull side has a chance
 * to interleave — exercising the queue-and-pending-pull path in
 * `streamLlamaPrompt`, not just the burst path.
 */
function makeFakeSession(chunks: string[]): LlamaChatSession {
  return {
    async prompt(_text: string, options?: SimplePromptOptions): Promise<string> {
      let accumulated = "";
      for (const chunk of chunks) {
        accumulated += chunk;
        options?.onTextChunk?.(chunk);
        // Yield so the async iterator's pending `next()` can settle before
        // we push the next chunk. Without this we always hit the
        // already-queued branch and skip the pending-resolve path.
        await Promise.resolve();
      }
      return accumulated;
    },
  } as unknown as LlamaChatSession;
}

describe("streamLlamaPrompt", () => {
  const usage: TokenUsage = {
    promptTokens: 4,
    completionTokens: 3,
    totalTokens: 7,
  };
  const estimateUsage = vi.fn((_p: string, _t: string): TokenUsage => usage);

  it("forwards deltas via onChunk and yields the same chunks via textStream", async () => {
    const onChunk = vi.fn<(delta: string) => void>();
    const session = makeFakeSession(["Hel", "lo ", "world"]);

    const result = streamLlamaPrompt({
      session,
      prompt: "say hi",
      options: {},
      onChunk,
      estimateUsage,
    });

    const collected: string[] = [];
    for await (const delta of result.textStream) {
      collected.push(delta);
    }

    expect(collected).toEqual(["Hel", "lo ", "world"]);
    expect(onChunk).toHaveBeenCalledTimes(3);
    expect(onChunk.mock.calls.map((c) => c[0])).toEqual(["Hel", "lo ", "world"]);
    await expect(result.text).resolves.toBe("Hello world");
    await expect(result.usage).resolves.toEqual(usage);
    await expect(result.finishReason).resolves.toBe("stop");
  });

  it("applies postProcess to the resolved text without affecting deltas", async () => {
    const onChunk = vi.fn<(delta: string) => void>();
    const session = makeFakeSession(["<think>scratch</think>", "real "]);

    const result = streamLlamaPrompt({
      session,
      prompt: "p",
      options: {},
      onChunk,
      estimateUsage,
      postProcess: (raw) => raw.replace(/<think>[\s\S]*?<\/think>/g, "").trim(),
    });

    const collected: string[] = [];
    for await (const delta of result.textStream) {
      collected.push(delta);
    }

    // Stream still emits raw deltas (the runtime decides what to do with
    // think tags at the SSE layer); only the resolved `text` is cleaned.
    expect(collected).toEqual(["<think>scratch</think>", "real "]);
    await expect(result.text).resolves.toBe("real");
  });

  it("invokes onComplete exactly once with the final usage", async () => {
    const onComplete = vi.fn();
    const session = makeFakeSession(["a", "b"]);

    const result = streamLlamaPrompt({
      session,
      prompt: "p",
      options: {},
      estimateUsage,
      onComplete,
    });

    // Drain
    for await (const _ of result.textStream) {
      // intentionally empty
    }
    await result.usage;

    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete.mock.calls[0][0]).toMatchObject({
      fullText: "ab",
      usage,
    });
  });

  it("propagates prompt errors through the textStream iterator", async () => {
    const failingSession = {
      async prompt(): Promise<string> {
        throw new Error("boom");
      },
    } as unknown as LlamaChatSession;

    const result = streamLlamaPrompt({
      session: failingSession,
      prompt: "p",
      options: {},
      estimateUsage,
    });

    await expect(
      (async () => {
        for await (const _ of result.textStream) {
          // unreachable
        }
      })()
    ).rejects.toThrow("boom");

    // usage / finishReason are best-effort — they should resolve to
    // undefined on failure rather than reject, mirroring plugin-ollama's
    // `Promise.resolve(...).catch(() => undefined)` posture.
    await expect(result.usage).resolves.toBeUndefined();
    await expect(result.finishReason).resolves.toBeUndefined();
  });
});
