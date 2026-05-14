/**
 * Tests for the AOSP streaming-LLM binding shim.
 *
 * No native library is loaded.  The binding contract is exercised
 * entirely against a mock JNI surface — the goal is to lock the JS-side
 * contract (sequencing, cancel, dispose) so when the real
 * libelizainference.so + JNI glue lands the only thing that has to be
 * verified on-device is the C↔Java boundary.
 */

import { describe, expect, it, vi } from "vitest";

import {
  type AospInferenceContextHandle,
  type AospLlmStreamConfig,
  type AospLlmStreamHandle,
  type AospLlmStreamStep,
  type AospStreamingLlmBinding,
  logCapabilities,
  probeAospCapabilities,
  streamGenerate,
  streamGenerateIterable,
} from "../src/aosp-llama-streaming";

/* -------------------------------------------------------------------- */
/* Mock binding factory                                                 */
/* -------------------------------------------------------------------- */

interface MockSpies {
  open: ReturnType<typeof vi.fn>;
  prefill: ReturnType<typeof vi.fn>;
  next: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  saveSlot: ReturnType<typeof vi.fn>;
  restoreSlot: ReturnType<typeof vi.fn>;
}

function makeMockBinding(
  steps: AospLlmStreamStep[],
  options: {
    supported?: boolean;
    cancelAfter?: number;
    throwOnStep?: number;
  } = {},
): { binding: AospStreamingLlmBinding; spies: MockSpies } {
  const ctxHandle: AospInferenceContextHandle = 1n;
  const streamHandle: AospLlmStreamHandle = 2n;
  let stepIdx = 0;
  let cancelled = false;

  void ctxHandle;

  const open = vi.fn().mockReturnValue(streamHandle);
  const prefill = vi.fn();
  const next = vi.fn(() => {
    if (cancelled) {
      // Surface a CANCELLED-shaped step the runner promotes to abort.
      return {
        tokens: [],
        text: "",
        done: true,
        drafterDrafted: 0,
        drafterAccepted: 0,
      } satisfies AospLlmStreamStep;
    }
    if (options.throwOnStep !== undefined && stepIdx === options.throwOnStep) {
      throw new Error("[mock-binding] step boom");
    }
    if (
      options.cancelAfter !== undefined &&
      stepIdx === options.cancelAfter
    ) {
      cancelled = true;
    }
    if (stepIdx >= steps.length) {
      return {
        tokens: [],
        text: "",
        done: true,
        drafterDrafted: 0,
        drafterAccepted: 0,
      } satisfies AospLlmStreamStep;
    }
    return steps[stepIdx++]!;
  });
  const cancel = vi.fn(() => {
    cancelled = true;
  });
  const close = vi.fn();
  const saveSlot = vi.fn();
  const restoreSlot = vi.fn();

  const binding: AospStreamingLlmBinding = {
    llmStreamSupported: () => options.supported !== false,
    llmStreamOpen: open,
    llmStreamPrefill: prefill,
    llmStreamNext: next,
    llmStreamCancel: cancel,
    llmStreamClose: close,
    llmStreamSaveSlot: saveSlot,
    llmStreamRestoreSlot: restoreSlot,
  };

  return {
    binding,
    spies: { open, prefill, next, cancel, close, saveSlot, restoreSlot },
  };
}

const DEFAULT_CONFIG: AospLlmStreamConfig = {
  maxTokens: 64,
  temperature: 0.7,
  topP: 0.95,
  topK: 40,
  repeatPenalty: 1.1,
  slotId: -1,
  promptCacheKey: null,
  draftMin: 0,
  draftMax: 0,
  dflashDrafterPath: null,
  disableThinking: false,
};

const STEPS: AospLlmStreamStep[] = [
  {
    tokens: [101, 102],
    text: "hello",
    done: false,
    drafterDrafted: 2,
    drafterAccepted: 2,
  },
  {
    tokens: [103],
    text: " mobile",
    done: false,
    drafterDrafted: 1,
    drafterAccepted: 1,
  },
  {
    tokens: [104],
    text: "!",
    done: true,
    drafterDrafted: 1,
    drafterAccepted: 1,
  },
];

/* -------------------------------------------------------------------- */
/* Suite                                                                */
/* -------------------------------------------------------------------- */

describe("streamGenerate (AOSP mock JNI)", () => {
  it("aggregates text + drafter counters across steps", async () => {
    const { binding, spies } = makeMockBinding(STEPS);
    const result = await streamGenerate(binding, {
      ctx: 1n,
      config: DEFAULT_CONFIG,
      promptTokens: new Int32Array([7, 8, 9]),
    });
    expect(result.text).toBe("hello mobile!");
    expect(result.steps).toBe(3);
    expect(result.drafted).toBe(4);
    expect(result.accepted).toBe(4);
    expect(spies.open).toHaveBeenCalledTimes(1);
    expect(spies.prefill).toHaveBeenCalledTimes(1);
    expect(spies.close).toHaveBeenCalledTimes(1);
  });

  it("forwards onTextChunk for each non-empty step", async () => {
    const { binding } = makeMockBinding(STEPS);
    const seen: string[] = [];
    await streamGenerate(binding, {
      ctx: 1n,
      config: DEFAULT_CONFIG,
      promptTokens: new Int32Array([1, 2]),
      onTextChunk: (c) => {
        seen.push(c);
      },
    });
    expect(seen).toEqual(["hello", " mobile", "!"]);
  });

  it("rejects when binding reports llmStreamSupported() === false", async () => {
    const { binding, spies } = makeMockBinding(STEPS, { supported: false });
    await expect(
      streamGenerate(binding, {
        ctx: 1n,
        config: DEFAULT_CONFIG,
        promptTokens: new Int32Array([1, 2]),
      }),
    ).rejects.toThrow(/llmStreamSupported\(\) === false/);
    expect(spies.open).not.toHaveBeenCalled();
  });

  it("propagates pre-fired AbortSignal as 'aborted before start'", async () => {
    const { binding, spies } = makeMockBinding(STEPS);
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(
      streamGenerate(binding, {
        ctx: 1n,
        config: DEFAULT_CONFIG,
        promptTokens: new Int32Array([1, 2]),
        signal: ctrl.signal,
      }),
    ).rejects.toThrow(/aborted before start/);
    expect(spies.cancel).toHaveBeenCalled();
    expect(spies.close).toHaveBeenCalled();
  });

  it("cancels and closes when AbortSignal fires mid-stream", async () => {
    const { binding, spies } = makeMockBinding(STEPS);
    const ctrl = new AbortController();
    const chunks: string[] = [];
    const p = streamGenerate(binding, {
      ctx: 1n,
      config: DEFAULT_CONFIG,
      promptTokens: new Int32Array([1, 2]),
      signal: ctrl.signal,
      onTextChunk: (c) => {
        chunks.push(c);
        // Abort after first chunk.
        if (chunks.length === 1) ctrl.abort();
      },
    });
    await expect(p).rejects.toThrow(/aborted/);
    // open + prefill + at least one next + close still ran.
    expect(spies.open).toHaveBeenCalledTimes(1);
    expect(spies.prefill).toHaveBeenCalledTimes(1);
    expect(spies.cancel).toHaveBeenCalled();
    expect(spies.close).toHaveBeenCalledTimes(1);
  });

  it("closes the stream even when llmStreamNext throws", async () => {
    const { binding, spies } = makeMockBinding(STEPS, { throwOnStep: 1 });
    await expect(
      streamGenerate(binding, {
        ctx: 1n,
        config: DEFAULT_CONFIG,
        promptTokens: new Int32Array([1, 2]),
      }),
    ).rejects.toThrow(/step boom/);
    expect(spies.close).toHaveBeenCalledTimes(1);
  });
});

describe("streamGenerateIterable", () => {
  it("yields each step in order and terminates on `done`", async () => {
    const { binding, spies } = makeMockBinding(STEPS);
    const collected: AospLlmStreamStep[] = [];
    for await (const step of streamGenerateIterable(binding, {
      ctx: 1n,
      config: DEFAULT_CONFIG,
      promptTokens: new Int32Array([1, 2]),
    })) {
      collected.push(step);
    }
    expect(collected.length).toBe(3);
    expect(collected[2]!.done).toBe(true);
    expect(spies.close).toHaveBeenCalledTimes(1);
  });

  it("cancels and breaks when consumer stops iterating", async () => {
    const { binding, spies } = makeMockBinding(STEPS);
    const iter = streamGenerateIterable(binding, {
      ctx: 1n,
      config: DEFAULT_CONFIG,
      promptTokens: new Int32Array([1, 2]),
    });
    const first = await iter[Symbol.asyncIterator]().next();
    expect(first.done).toBe(false);
    // `for await` cleanup invokes return() on the iterator → finally block fires.
    if (iter[Symbol.asyncIterator]().return) {
      await iter[Symbol.asyncIterator]().return!();
    }
    expect(spies.close).toHaveBeenCalledTimes(1);
  });
});

describe("probeAospCapabilities", () => {
  it("returns all-false when binding is null", () => {
    const caps = probeAospCapabilities(null, "android", false);
    expect(caps).toEqual({
      streamingLlm: false,
      dflashSupported: false,
      omnivoiceStreaming: false,
      mmprojSupported: false,
    });
  });

  it("never reports dflashSupported on android even when streaming is supported", () => {
    const caps = probeAospCapabilities(
      { llmStreamSupported: () => true },
      "android",
      true,
    );
    expect(caps.streamingLlm).toBe(true);
    expect(caps.omnivoiceStreaming).toBe(true);
    expect(caps.dflashSupported).toBe(false);
    expect(caps.mmprojSupported).toBe(false);
  });

  it("never reports dflashSupported on ios even when streaming is supported", () => {
    const caps = probeAospCapabilities(
      { llmStreamSupported: () => true },
      "ios",
      false,
    );
    expect(caps.dflashSupported).toBe(false);
    expect(caps.mmprojSupported).toBe(false);
  });

  it("enables dflashSupported on desktop when streaming is supported", () => {
    const caps = probeAospCapabilities(
      { llmStreamSupported: () => true },
      "other",
      true,
    );
    expect(caps.dflashSupported).toBe(true);
    expect(caps.mmprojSupported).toBe(true);
  });

  it("logCapabilities does not throw on valid caps", () => {
    expect(() =>
      logCapabilities({
        streamingLlm: true,
        dflashSupported: false,
        omnivoiceStreaming: true,
        mmprojSupported: false,
      }),
    ).not.toThrow();
  });
});
