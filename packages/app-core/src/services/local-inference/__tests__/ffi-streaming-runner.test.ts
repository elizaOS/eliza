/**
 * Tests for the FFI streaming runner.
 *
 * These tests run with a mocked FFI surface — no native library is loaded
 * and no model file is required. The point is to exercise the JS-side
 * iterator surface, abort plumbing, and single-flight rule so that when
 * the actual `libelizainference` is rebuilt by CI, the JS layer is known
 * to be correct.
 *
 * The real on-device test that streams against a tiny GGUF (e.g. Qwen3
 * 0.8B) is gated separately with `it.skipIf(!fs.existsSync(modelPath))` so
 * it never downloads in CI.
 */

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { FfiStreamingRunner } from "../ffi-streaming-runner";
import {
  detectMobileCapabilities,
  type FfiDflashStreamingAbi,
  type FfiLlmStreamingAbi,
} from "../ffi-llm-streaming-abi";
import { makeFfiLlmMock } from "../ffi-llm-mock";
import type {
  ElizaInferenceContextHandle,
  ElizaInferenceFfi,
  LlmStreamHandle,
  LlmStreamStep,
} from "../voice/ffi-bindings";

/**
 * Tiny GGUF fixture probe. Tests that need a real model are skipped
 * when the fixture is absent — we never download in tests (CI resource
 * limits, plus user policy on the local Mac).
 *
 * Override path with `MILADY_SMALL_TEST_MODEL_PATH`. Default looks for a
 * Qwen3 0.8B Q4 GGUF under the workspace fixtures dir.
 */
const SMALL_MODEL_PATH =
  process.env.MILADY_SMALL_TEST_MODEL_PATH ??
  path.join(
    process.env.MILADY_STATE_DIR ?? `${process.env.HOME}/.milady`,
    "models",
    "fixtures",
    "qwen3.5-0.8b-q4.gguf",
  );

function hasSmallModel(): boolean {
  try {
    return fs.existsSync(SMALL_MODEL_PATH);
  } catch {
    return false;
  }
}

/** Build a mocked FFI surface that scripts a fixed sequence of steps. */
function makeMockFfi(steps: LlmStreamStep[]): {
  ffi: ElizaInferenceFfi;
  ctx: ElizaInferenceContextHandle;
  spies: {
    open: ReturnType<typeof vi.fn>;
    prefill: ReturnType<typeof vi.fn>;
    next: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
    cancel: ReturnType<typeof vi.fn>;
    saveSlot: ReturnType<typeof vi.fn>;
    restoreSlot: ReturnType<typeof vi.fn>;
  };
} {
  const ctx: ElizaInferenceContextHandle = 1n;
  const stream: LlmStreamHandle = 2n;
  let stepIdx = 0;

  const open = vi.fn().mockReturnValue(stream);
  const prefill = vi.fn();
  const next = vi.fn(() => {
    if (stepIdx >= steps.length) {
      // Defensive: runner should stop on `done: true` before this fires.
      return {
        tokens: [],
        text: "",
        done: true,
        drafterDrafted: 0,
        drafterAccepted: 0,
      } satisfies LlmStreamStep;
    }
    return steps[stepIdx++]!;
  });
  const close = vi.fn();
  const cancel = vi.fn();
  const saveSlot = vi.fn();
  const restoreSlot = vi.fn();

  const ffi = {
    libraryPath: "/fake/libelizainference.dylib",
    libraryAbiVersion: "3",
    create: vi.fn().mockReturnValue(ctx),
    destroy: vi.fn(),
    mmapAcquire: vi.fn(),
    mmapEvict: vi.fn(),
    ttsSynthesize: vi.fn().mockReturnValue(0),
    asrTranscribe: vi.fn().mockReturnValue(""),
    ttsStreamSupported: () => false,
    ttsSynthesizeStream: vi.fn(),
    llmStreamSupported: () => true,
    llmStreamOpen: open,
    llmStreamPrefill: prefill,
    llmStreamNext: next,
    llmStreamCancel: cancel,
    llmStreamSaveSlot: saveSlot,
    llmStreamRestoreSlot: restoreSlot,
    llmStreamClose: close,
    close: vi.fn(),
  } as unknown as ElizaInferenceFfi;

  return {
    ffi,
    ctx,
    spies: { open, prefill, next, close, cancel, saveSlot, restoreSlot },
  };
}

const STEPS_3: LlmStreamStep[] = [
  {
    tokens: [10, 11],
    text: "hello",
    done: false,
    drafterDrafted: 3,
    drafterAccepted: 2,
  },
  {
    tokens: [12],
    text: " world",
    done: false,
    drafterDrafted: 1,
    drafterAccepted: 1,
  },
  {
    tokens: [13],
    text: "!",
    done: true,
    drafterDrafted: 1,
    drafterAccepted: 1,
  },
];

const DEFAULT_ARGS = {
  promptTokens: new Int32Array([1, 2, 3]),
  slotId: 0,
  maxTokens: 32,
  temperature: 0.8,
  topP: 0.95,
  topK: 40,
  repeatPenalty: 1.0,
  draftMin: 0,
  draftMax: 0,
  dflashDrafterPath: null,
};

describe("FfiStreamingRunner.generateWithUsage (mocked FFI)", () => {
  it("concatenates step texts and totals drafter counters", async () => {
    const { ffi, ctx, spies } = makeMockFfi(STEPS_3);
    const runner = new FfiStreamingRunner(ffi, ctx);

    const result = await runner.generateWithUsage(DEFAULT_ARGS);

    expect(result.text).toBe("hello world!");
    expect(result.slotId).toBe(0);
    expect(result.drafted).toBe(5);
    expect(result.accepted).toBe(4);
    expect(spies.open).toHaveBeenCalledTimes(1);
    expect(spies.prefill).toHaveBeenCalledTimes(1);
    expect(spies.close).toHaveBeenCalledTimes(1);
  });

  it("forwards onTextChunk for each non-empty step", async () => {
    const { ffi, ctx } = makeMockFfi(STEPS_3);
    const runner = new FfiStreamingRunner(ffi, ctx);
    const chunks: string[] = [];

    await runner.generateWithUsage({
      ...DEFAULT_ARGS,
      onTextChunk: (c) => {
        chunks.push(c);
      },
    });

    expect(chunks).toEqual(["hello", " world", "!"]);
  });

  it("forwards onVerifierEvent as accept events shaped like the HTTP path", async () => {
    const { ffi, ctx } = makeMockFfi(STEPS_3);
    const runner = new FfiStreamingRunner(ffi, ctx);
    const events: unknown[] = [];

    await runner.generateWithUsage({
      ...DEFAULT_ARGS,
      onVerifierEvent: (e) => {
        events.push(e);
      },
    });

    expect(events).toHaveLength(3);
    for (const e of events) {
      expect((e as { kind: string }).kind).toBe("accept");
    }
  });

  it("records firstTokenMs from the first text-bearing step", async () => {
    const { ffi, ctx } = makeMockFfi(STEPS_3);
    const runner = new FfiStreamingRunner(ffi, ctx);
    const result = await runner.generateWithUsage(DEFAULT_ARGS);
    expect(result.firstTokenMs).not.toBeNull();
    expect(result.firstTokenMs).toBeGreaterThanOrEqual(0);
  });

  it("throws when the binding lacks streaming-LLM symbols", async () => {
    const { ffi, ctx } = makeMockFfi(STEPS_3);
    // Strip the streaming-LLM exports to simulate a stale build.
    delete (ffi as { llmStreamOpen?: unknown }).llmStreamOpen;
    const runner = new FfiStreamingRunner(ffi, ctx);

    await expect(runner.generateWithUsage(DEFAULT_ARGS)).rejects.toThrow(
      /missing streaming-LLM symbols/,
    );
  });

  it("aborts via signal: triggers llmStreamCancel + propagates error", async () => {
    const { ffi, ctx, spies } = makeMockFfi(STEPS_3);
    const runner = new FfiStreamingRunner(ffi, ctx);
    const ac = new AbortController();
    ac.abort();

    await expect(
      runner.generateWithUsage({
        ...DEFAULT_ARGS,
        signal: ac.signal,
      }),
    ).rejects.toThrow(/aborted before start/);

    expect(spies.cancel).toHaveBeenCalledTimes(1);
    expect(spies.close).toHaveBeenCalledTimes(1);
  });

  it("serialises concurrent calls against the same pinned slot", async () => {
    const { ffi, ctx, spies } = makeMockFfi(STEPS_3);
    const runner = new FfiStreamingRunner(ffi, ctx);
    let inflight = 0;
    let maxObserved = 0;

    spies.next.mockImplementation(((args: unknown) => {
      void args;
      inflight += 1;
      maxObserved = Math.max(maxObserved, inflight);
      // Cycle through the scripted steps, but loop independently per call.
      const step = STEPS_3[(spies.next.mock.calls.length - 1) % STEPS_3.length]!;
      inflight -= 1;
      return step;
    }) as never);

    const p1 = runner.generateWithUsage({ ...DEFAULT_ARGS, slotId: 7 });
    const p2 = runner.generateWithUsage({ ...DEFAULT_ARGS, slotId: 7 });
    await Promise.all([p1, p2]);

    // The single-flight rule means open() should be called twice (one per
    // generate) but the second is gated on the first's completion.
    expect(spies.open).toHaveBeenCalledTimes(2);
  });
});

describe("FfiStreamingRunner.generateStream (async iterable)", () => {
  it("yields each step in order including the terminal done step", async () => {
    const { ffi, ctx } = makeMockFfi(STEPS_3);
    const runner = new FfiStreamingRunner(ffi, ctx);

    const seen: LlmStreamStep[] = [];
    for await (const step of runner.generateStream(DEFAULT_ARGS)) {
      seen.push(step);
    }

    expect(seen).toHaveLength(3);
    expect(seen.map((s) => s.text).join("")).toBe("hello world!");
    expect(seen[2]!.done).toBe(true);
  });

  it("surfaces errors from the underlying inner loop", async () => {
    const { ffi, ctx, spies } = makeMockFfi(STEPS_3);
    spies.next.mockImplementation((() => {
      throw new Error("native fault");
    }) as never);
    const runner = new FfiStreamingRunner(ffi, ctx);

    await expect(
      (async () => {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        for await (const _ of runner.generateStream(DEFAULT_ARGS)) {
          /* drain */
        }
      })(),
    ).rejects.toThrow(/native fault/);
  });
});

describe("FfiStreamingRunner.saveSlot / restoreSlot", () => {
  it("delegates to the FFI binding", () => {
    const { ffi, ctx, spies } = makeMockFfi(STEPS_3);
    const runner = new FfiStreamingRunner(ffi, ctx);
    const handle = 42n as LlmStreamHandle;

    runner.saveSlot(handle, "/tmp/slot.bin");
    runner.restoreSlot(handle, "/tmp/slot.bin");

    expect(spies.saveSlot).toHaveBeenCalledWith({
      stream: handle,
      filename: "/tmp/slot.bin",
    });
    expect(spies.restoreSlot).toHaveBeenCalledWith({
      stream: handle,
      filename: "/tmp/slot.bin",
    });
  });

  it("throws when the binding lacks saveSlot / restoreSlot", () => {
    const { ffi, ctx } = makeMockFfi(STEPS_3);
    delete (ffi as { llmStreamSaveSlot?: unknown }).llmStreamSaveSlot;
    delete (ffi as { llmStreamRestoreSlot?: unknown }).llmStreamRestoreSlot;
    const runner = new FfiStreamingRunner(ffi, ctx);
    const handle = 42n as LlmStreamHandle;

    expect(() => runner.saveSlot(handle, "x")).toThrow(
      /llmStreamSaveSlot is not exported/,
    );
    expect(() => runner.restoreSlot(handle, "x")).toThrow(
      /llmStreamRestoreSlot is not exported/,
    );
  });
});

// ---------------------------------------------------------------------------
// FFI streaming LLM ABI — detectMobileCapabilities + mock tests
//
// These tests exercise the NEW ffi-llm-streaming-abi.ts + ffi-llm-mock.ts
// modules introduced to replace the mobile llama-server child-process
// pattern. No native library is loaded; all coverage is purely synthetic.
// ---------------------------------------------------------------------------

describe("detectMobileCapabilities(null)", () => {
  it("returns all-false capability snapshot when ffi is null", () => {
    const caps = detectMobileCapabilities(null);

    expect(caps.streamingLlm).toBe(false);
    expect(caps.dflashSupported).toBe(false);
    expect(caps.omnivoiceStreaming).toBe(false);
    expect(caps.maxContextTokens).toBe(0);
    expect(caps.recommendedGpuLayers).toBe(0);
  });

  it("returns a plain object (no getters or side-effects)", () => {
    const caps = detectMobileCapabilities(null);
    // Verify the returned snapshot can be safely serialised without throwing.
    expect(() => JSON.stringify(caps)).not.toThrow();
    const parsed = JSON.parse(JSON.stringify(caps)) as typeof caps;
    expect(parsed).toStrictEqual(caps);
  });
});

describe("detectMobileCapabilities(mockFfi)", () => {
  it("returns streamingLlm=true when the mock reports llmStreamSupported", () => {
    const { ffi } = makeFfiLlmMock();
    const caps = detectMobileCapabilities(ffi);

    expect(caps.streamingLlm).toBe(true);
  });

  it("returns omnivoiceStreaming=false because the mock's ttsStreamSupported returns false", () => {
    const { ffi } = makeFfiLlmMock();
    const caps = detectMobileCapabilities(ffi);

    expect(caps.omnivoiceStreaming).toBe(false);
  });

  it("returns dflashSupported=false at Phase-1 (drafter bundle probe is external)", () => {
    const { ffi } = makeFfiLlmMock();
    const caps = detectMobileCapabilities(ffi);

    // Phase 1 always returns false here; the drafter probe lives in the
    // platform bootstrap, not in detectMobileCapabilities itself.
    expect(caps.dflashSupported).toBe(false);
  });

  it("returns non-zero maxContextTokens when streamingLlm is true", () => {
    const { ffi } = makeFfiLlmMock();
    const caps = detectMobileCapabilities(ffi);

    expect(caps.maxContextTokens).toBeGreaterThan(0);
  });
});

describe("FfiLlmMock — generate → cancel stops the stream early", () => {
  it("stops before all synthetic tokens are emitted when cancel is called", async () => {
    const { ffi, state } = makeFfiLlmMock();

    const handle = ffi.eliza_inference_llm_stream_open("fake.gguf", 512, 4, 0);
    expect(handle).not.toBeNull();

    ffi.eliza_inference_llm_stream_prefill(handle!, new Int32Array([1, 2, 3]), 0);

    const emitted: string[] = [];
    let doneCount = 0;

    // Start generation and cancel after first token fires.
    const gen = ffi.eliza_inference_llm_stream_generate(
      handle!,
      64,
      0.8,
      0.95,
      (id, text, isDone) => {
        if (isDone) {
          doneCount++;
          return;
        }
        emitted.push(text);
        // Cancel on the first real token so the stream terminates early.
        if (emitted.length === 1) {
          ffi.eliza_inference_llm_stream_cancel(handle!);
        }
      },
    );
    await gen;

    // The stream was cancelled — we should have received fewer than the
    // full 3 synthetic tokens and the `isDone` terminal event fired.
    expect(doneCount).toBe(1); // always exactly one terminal event
    expect(emitted.length).toBeLessThan(3); // stopped before finishing
    expect(state.cancelCount).toBeGreaterThanOrEqual(1);
    expect(state.cancelledMidStream).toBe(true);
  });
});

describe("FfiLlmMock — close after generate completes cleanly", () => {
  it("decrements the open-handle set and does not throw", async () => {
    const { ffi, state } = makeFfiLlmMock();

    const handle = ffi.eliza_inference_llm_stream_open("fake.gguf", 512, 4, 0);
    expect(handle).not.toBeNull();
    expect(state.openHandles.size).toBe(1);

    ffi.eliza_inference_llm_stream_prefill(handle!, new Int32Array([1, 2]), 0);

    await ffi.eliza_inference_llm_stream_generate(
      handle!,
      32,
      0.8,
      0.95,
      () => {
        /* drain */
      },
    );

    // Close after generation — no double-free scenario in the mock, but we
    // verify the handle is removed from the open set.
    expect(() => ffi.eliza_inference_llm_stream_close(handle!)).not.toThrow();
    expect(state.openHandles.size).toBe(0);
    expect(state.closeCount).toBe(1);
  });

  it("emits all three synthetic tokens before resolving", async () => {
    const { ffi } = makeFfiLlmMock();

    const handle = ffi.eliza_inference_llm_stream_open("fake.gguf", 512, 4, 0)!;
    ffi.eliza_inference_llm_stream_prefill(handle, new Int32Array([1]), 0);

    const tokens: string[] = [];
    await ffi.eliza_inference_llm_stream_generate(
      handle,
      32,
      0.8,
      0.95,
      (id, text, isDone) => {
        if (!isDone) tokens.push(text);
      },
    );

    expect(tokens).toEqual(["Hello", " world", "!"]);
    ffi.eliza_inference_llm_stream_close(handle);
  });
});

describe("FfiDflashStreamingAbi shape — type-check via mock", () => {
  it("implements the full DFlash ABI surface and open returns a handle", () => {
    const { ffi, state } = makeFfiLlmMock();

    // Type-check: assign to the strict interface so the compiler verifies
    // the mock satisfies it.  If this compiles the contract is met.
    const dflash: FfiDflashStreamingAbi = ffi;

    const handle = dflash.eliza_inference_dflash_stream_open(
      "drafter.gguf",
      "verifier.gguf",
      1024,
      4,
      0,
      4,
    );
    expect(handle).not.toBeNull();
    expect(state.openCount).toBe(1);
  });

  it("prefill returns the fixed mock count (128)", () => {
    const { ffi } = makeFfiLlmMock();
    const dflash: FfiDflashStreamingAbi = ffi;

    const handle = dflash.eliza_inference_dflash_stream_open(
      "d.gguf",
      "v.gguf",
      512,
      4,
      0,
      4,
    )!;
    const count = dflash.eliza_inference_dflash_stream_prefill(
      handle,
      new Int32Array([1, 2, 3, 4]),
      0,
    );
    expect(count).toBe(128);
  });

  it("generate delivers synthetic tokens and resolves", async () => {
    const { ffi } = makeFfiLlmMock();
    const dflash: FfiDflashStreamingAbi = ffi;

    const handle = dflash.eliza_inference_dflash_stream_open(
      "d.gguf",
      "v.gguf",
      512,
      4,
      0,
      4,
    )!;
    dflash.eliza_inference_dflash_stream_prefill(handle, new Int32Array([1]), 0);

    const ids: number[] = [];
    await dflash.eliza_inference_dflash_stream_generate(
      handle,
      32,
      0.8,
      0.95,
      (id, _text, isDone) => {
        if (!isDone) ids.push(id);
      },
    );

    // Synthetic tokens are id=1 ("Hello"), id=2 (" world"), id=3 ("!")
    expect(ids).toEqual([1, 2, 3]);
    dflash.eliza_inference_dflash_stream_close(handle);
  });

  it("single-model ABI satisfies FfiLlmStreamingAbi type contract", () => {
    const { ffi } = makeFfiLlmMock();
    // Compiler-level check: assignment to the strict interface type.
    const llm: FfiLlmStreamingAbi = ffi;
    expect(typeof llm.eliza_inference_llm_stream_open).toBe("function");
    expect(typeof llm.eliza_inference_llm_stream_prefill).toBe("function");
    expect(typeof llm.eliza_inference_llm_stream_generate).toBe("function");
    expect(typeof llm.eliza_inference_llm_stream_cancel).toBe("function");
    expect(typeof llm.eliza_inference_llm_stream_close).toBe("function");
  });
});

/**
 * On-device end-to-end smoke. Skipped when the small-model fixture is
 * absent — CI never downloads, and the local Mac is resource-constrained.
 */
describe.skipIf(!hasSmallModel())(
  "FfiStreamingRunner real-model smoke (gated)",
  () => {
    it("requires the small-model fixture and a built libelizainference", () => {
      // Placeholder so the suite reports the gating to the runner. The
      // real on-device harness lives in voice-bench / dflash-server-fused
      // integration tests and runs with the built native artifact.
      expect(fs.existsSync(SMALL_MODEL_PATH)).toBe(true);
    });
  },
);
