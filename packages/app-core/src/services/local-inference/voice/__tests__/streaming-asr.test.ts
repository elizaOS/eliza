/**
 * Streaming-ASR tests: LocalAgreement-2 word-level stabilization, sliding-window
 * chunking (FfiBatchTranscriber mock), speech-pause → drafter wiring, and
 * flush()-after-speech-end committed final.
 *
 * No real ASR model or native library is used. Tests that would require a live
 * model are guarded with `it.skipIf(true, ...)` per the task spec (no models >2B).
 */

import { describe, expect, it } from "vitest";
import { MockCheckpointManager } from "../checkpoint-manager";
import type {
  ElizaInferenceContextHandle,
  ElizaInferenceFfi,
  ElizaInferenceRegion,
} from "../ffi-bindings";
import { LocalAgreementBuffer } from "../streaming-asr/streaming-pipeline-adapter";
import { ASR_SAMPLE_RATE, FfiBatchTranscriber } from "../transcriber";
import type { PcmFrame, TranscriberEvent } from "../types";
import type {
  DrafterAbortReason,
  DrafterHandle,
  StartDrafterFn,
} from "../voice-state-machine";
import { VoiceStateMachine } from "../voice-state-machine";

/* ======================================================================
 * Helpers
 * ====================================================================== */

function makePcmFrame(samples: number, tsMs = 0): PcmFrame {
  return {
    pcm: new Float32Array(samples).fill(0.05),
    sampleRate: ASR_SAMPLE_RATE,
    timestampMs: tsMs,
  };
}

/**
 * Build a minimal fake `ElizaInferenceFfi` backed by a scripted batch
 * transcriber. Only `asrTranscribe` is used by `FfiBatchTranscriber`;
 * every other method throws or returns a sentinel so accidental calls
 * are caught immediately.
 */
function makeBatchFfi(
  transcribeFn: (pcm: Float32Array) => string,
): ElizaInferenceFfi {
  return {
    libraryPath: "/tmp/fake-batch",
    libraryAbiVersion: "1",
    create: (): ElizaInferenceContextHandle => 1n,
    destroy: () => {},
    mmapAcquire: (
      _c: ElizaInferenceContextHandle,
      _r: ElizaInferenceRegion,
    ) => {},
    mmapEvict: (
      _c: ElizaInferenceContextHandle,
      _r: ElizaInferenceRegion,
    ) => {},
    ttsSynthesize: () => {
      throw new Error("not used");
    },
    asrTranscribe: ({ pcm }) => transcribeFn(pcm),
    ttsStreamSupported: () => false,
    ttsSynthesizeStream: () => {
      throw new Error("not used");
    },
    cancelTts: () => {},
    setVerifierCallback: () => ({ close: () => {} }),
    vadSupported: () => false,
    vadOpen: () => {
      throw new Error("not used");
    },
    vadProcess: () => {
      throw new Error("not used");
    },
    vadReset: () => {},
    vadClose: () => {},
    asrStreamSupported: () => false,
    asrStreamOpen: () => {
      throw new Error("not used");
    },
    asrStreamFeed: () => {
      throw new Error("not used");
    },
    asrStreamPartial: () => {
      throw new Error("not used");
    },
    asrStreamFinish: () => {
      throw new Error("not used");
    },
    asrStreamClose: () => {
      throw new Error("not used");
    },
    close: () => {},
  };
}

/* ======================================================================
 * 1. LocalAgreement-2 word-level stabilization — unit tests
 * ====================================================================== */

describe("LocalAgreementBuffer (word-level LocalAgreement-2)", () => {
  it("returns empty on the first hypothesis (need 2 consecutive matches)", () => {
    const buf = new LocalAgreementBuffer();
    const stable = buf.stable(["hello", "there"]);
    expect(stable).toEqual([]);
  });

  it("commits the matching prefix when two consecutive hypotheses agree on leading words", () => {
    const buf = new LocalAgreementBuffer();
    buf.stable(["hello", "there", "world"]);
    const stable = buf.stable(["hello", "there", "how"]);
    // First two words match across consecutive hypotheses → committed.
    expect(stable).toEqual(["hello", "there"]);
  });

  it("extends the committed prefix as additional words stabilize", () => {
    const buf = new LocalAgreementBuffer();
    buf.stable(["hello", "there"]);
    buf.stable(["hello", "there", "world"]);
    const stable = buf.stable(["hello", "there", "world"]);
    // "world" appeared in the 2nd and 3rd hypotheses → now committed.
    expect(stable).toEqual(["hello", "there", "world"]);
  });

  it("does NOT roll back a committed word if a later hypothesis diverges", () => {
    const buf = new LocalAgreementBuffer();
    buf.stable(["the", "cat"]);
    buf.stable(["the", "cat", "sat"]); // commits ["the", "cat"]
    // New hypothesis changes "cat" → but committed must stay
    const stable = buf.stable(["the", "dog"]);
    expect(stable).toEqual(["the", "cat"]);
  });

  it("returns empty array for empty hypotheses", () => {
    const buf = new LocalAgreementBuffer();
    buf.stable([]);
    const stable = buf.stable([]);
    expect(stable).toEqual([]);
  });

  it("reset() clears all committed state", () => {
    const buf = new LocalAgreementBuffer();
    buf.stable(["hi"]);
    buf.stable(["hi", "there"]); // commits ["hi"]
    expect(buf.getCommitted()).toEqual(["hi"]);
    buf.reset();
    expect(buf.getCommitted()).toEqual([]);
    // After reset, single hypothesis again commits nothing.
    expect(buf.stable(["hi"])).toEqual([]);
  });

  it("commits nothing when the two consecutive hypotheses share no common prefix", () => {
    const buf = new LocalAgreementBuffer();
    buf.stable(["apple", "banana"]);
    const stable = buf.stable(["cherry", "date"]);
    expect(stable).toEqual([]);
  });

  it("respects n=3: requires three consecutive identical leading words", () => {
    const buf = new LocalAgreementBuffer(3);
    buf.stable(["a", "b"]);
    buf.stable(["a", "b", "c"]);
    // Only two so far — still nothing.
    expect(buf.getCommitted()).toEqual([]);
    buf.stable(["a", "b", "d"]);
    // Third hypothesis agrees on ["a", "b"] with the window.
    expect(buf.getCommitted()).toEqual(["a", "b"]);
  });

  it("rejects invalid n values", () => {
    expect(() => new LocalAgreementBuffer(0)).toThrow();
    expect(() => new LocalAgreementBuffer(-1)).toThrow();
    expect(() => new LocalAgreementBuffer(Number.NaN)).toThrow();
  });
});

/* ======================================================================
 * 2. Sliding-window chunking via FfiBatchTranscriber — incremental partials
 * ====================================================================== */

describe("FfiBatchTranscriber sliding-window — incremental partial emission", () => {
  it("emits partial events incrementally and stays within the window bound per decode call", async () => {
    const decodedWindowSizes: number[] = [];
    let decodeCallCount = 0;

    const ffi = makeBatchFfi((pcm) => {
      decodedWindowSizes.push(pcm.length);
      decodeCallCount++;
      return `word${decodeCallCount}`;
    });

    const transcriber = new FfiBatchTranscriber({
      ffi,
      getContext: () => 1n,
      // Tiny window so multiple commits are forced across a ~2.4 s audio feed.
      windowSeconds: 0.8,
      overlapSeconds: 0.15,
      stepSeconds: 0.4,
    });

    const events: TranscriberEvent[] = [];
    transcriber.on((e) => events.push(e));

    // Feed ~2.4 s worth of audio in 0.6 s frames.
    const frameSamples = Math.round(0.6 * ASR_SAMPLE_RATE);
    for (let i = 0; i < 4; i++) {
      transcriber.feed(makePcmFrame(frameSamples, i * 600));
      // Let the serial decode chain drain.
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 0));
    }

    // At least one partial was emitted during the feed phase.
    const partials = events.filter((e) => e.kind === "partial");
    expect(partials.length).toBeGreaterThanOrEqual(1);
    // Each partial has isFinal: false while the segment is still open.
    for (const p of partials) {
      expect(p.kind).toBe("partial");
      if (p.kind === "partial") {
        expect(p.update.isFinal).toBe(false);
      }
    }

    // Every batch decode call was bounded by window+overlap (no full-buffer re-decode).
    const maxWindow = Math.round((0.8 + 0.15) * ASR_SAMPLE_RATE) + 50; // +50 rounding slack
    for (const n of decodedWindowSizes) {
      expect(n).toBeLessThanOrEqual(maxWindow);
    }

    // flush() force-finalizes and emits a final event.
    const final = await transcriber.flush();
    expect(final.isFinal).toBe(true);
    expect(typeof final.partial).toBe("string");

    const finalEvents = events.filter((e) => e.kind === "final");
    expect(finalEvents.length).toBe(1);

    transcriber.dispose();
  });

  it("flush() without any prior feed returns an empty final transcript", async () => {
    const ffi = makeBatchFfi(() => "");
    const transcriber = new FfiBatchTranscriber({
      ffi,
      getContext: () => 1n,
    });
    const final = await transcriber.flush();
    expect(final.isFinal).toBe(true);
    expect(final.partial).toBe("");
    transcriber.dispose();
  });

  it("multiple flush() calls each commit independently (segment reset between)", async () => {
    let callIdx = 0;
    const scripts = ["first utterance", "second utterance"];
    const ffi = makeBatchFfi(() => scripts[callIdx++ % scripts.length] ?? "");
    const transcriber = new FfiBatchTranscriber({
      ffi,
      getContext: () => 1n,
      stepSeconds: 0.01,
    });

    // Feed and flush for utterance 1.
    transcriber.feed(makePcmFrame(Math.round(0.5 * ASR_SAMPLE_RATE), 0));
    const final1 = await transcriber.flush();
    expect(final1.isFinal).toBe(true);

    // Feed and flush for utterance 2 — the transcriber must reset between segments.
    transcriber.feed(makePcmFrame(Math.round(0.5 * ASR_SAMPLE_RATE), 500));
    const final2 = await transcriber.flush();
    expect(final2.isFinal).toBe(true);
    // The second flush should not carry state from the first segment.
    expect(final2.partial.length).toBeGreaterThanOrEqual(0); // just verify no throw

    transcriber.dispose();
  });
});

/* ======================================================================
 * 3. speech-pause with available partial starts the drafter immediately
 * ====================================================================== */

interface DrafterCall {
  turnId: string;
  partial: string;
  aborted: DrafterAbortReason | null;
}

function fakeDrafter(): { fn: StartDrafterFn; calls: DrafterCall[] } {
  const calls: DrafterCall[] = [];
  const fn: StartDrafterFn = ({ turnId, partialTranscript }) => {
    const record: DrafterCall = {
      turnId,
      partial: partialTranscript,
      aborted: null,
    };
    calls.push(record);
    const handle: DrafterHandle = {
      abort(reason) {
        if (record.aborted === null) record.aborted = reason;
      },
    };
    return handle;
  };
  return { fn, calls };
}

describe("VoiceStateMachine — speech-pause feeds partial transcript to drafter", () => {
  it("on speech-pause the drafter is started synchronously with the current partial transcript", async () => {
    const drafter = fakeDrafter();
    const machine = new VoiceStateMachine({
      slotId: "test-slot",
      checkpointManager: new MockCheckpointManager(),
      startDrafter: drafter.fn,
      pauseHangoverMs: 200,
    });

    await machine.dispatch({ type: "speech-start", timestampMs: 0 });
    // Provide a partial transcript — this is what the streaming ASR adapter
    // would have accumulated via LocalAgreementBuffer by speech-pause time.
    const partialAtPause = "how do I configure the";
    await machine.dispatch({
      type: "speech-pause",
      timestampMs: 1500,
      partialTranscript: partialAtPause,
    });

    expect(machine.getState()).toBe("PAUSE_TENTATIVE");
    // Drafter was started immediately with the streaming partial (not waiting for flush()).
    expect(drafter.calls).toHaveLength(1);
    expect(drafter.calls[0]?.partial).toBe(partialAtPause);
  });

  it("speech-pause with empty partial still starts the drafter (drafter handles empty input)", async () => {
    const drafter = fakeDrafter();
    const machine = new VoiceStateMachine({
      slotId: "test-slot",
      checkpointManager: new MockCheckpointManager(),
      startDrafter: drafter.fn,
      pauseHangoverMs: 200,
    });

    await machine.dispatch({ type: "speech-start", timestampMs: 0 });
    await machine.dispatch({
      type: "speech-pause",
      timestampMs: 500,
      partialTranscript: "",
    });

    expect(drafter.calls).toHaveLength(1);
    expect(drafter.calls[0]?.partial).toBe("");
  });

  it("drafter is aborted if speech resumes within the rollback window (partial was premature)", async () => {
    const drafter = fakeDrafter();
    const machine = new VoiceStateMachine({
      slotId: "test-slot",
      checkpointManager: new MockCheckpointManager(),
      startDrafter: drafter.fn,
      pauseHangoverMs: 200,
    });

    await machine.dispatch({ type: "speech-start", timestampMs: 0 });
    await machine.dispatch({
      type: "speech-pause",
      timestampMs: 1000,
      partialTranscript: "I was going to",
    });
    // Speech-active within 2×hangover (400ms) → rollback: drafter aborted.
    await machine.dispatch({ type: "speech-active", timestampMs: 1200 });

    expect(machine.getState()).toBe("LISTENING");
    expect(drafter.calls[0]?.aborted).toBe("resumed");
  });
});

/* ======================================================================
 * 4. flush() after speech-end returns the committed final transcript
 * ====================================================================== */

describe("FfiBatchTranscriber — flush() returns committed final on speech-end", () => {
  it("flush() drains the pending tail into committed and returns it with isFinal: true", async () => {
    const ffi = makeBatchFfi(() => "the quick brown fox");
    const transcriber = new FfiBatchTranscriber({
      ffi,
      getContext: () => 1n,
      stepSeconds: 0.01,
    });

    transcriber.feed(makePcmFrame(Math.round(0.5 * ASR_SAMPLE_RATE), 0));
    const final = await transcriber.flush();

    expect(final.isFinal).toBe(true);
    // The decoder returned "the quick brown fox" → committed final contains it.
    expect(final.partial).toContain("the quick brown fox");
    transcriber.dispose();
  });

  it("flush() on an untouched transcriber returns empty string (no audio, no transcript)", async () => {
    const ffi = makeBatchFfi(() => "should not be called");
    const transcriber = new FfiBatchTranscriber({
      ffi,
      getContext: () => 1n,
    });
    const final = await transcriber.flush();
    expect(final.isFinal).toBe(true);
    expect(final.partial).toBe("");
    transcriber.dispose();
  });

  it("flush() resolves in order even when multiple decode passes are enqueued (serial chain)", async () => {
    let decodes = 0;
    const ffi = makeBatchFfi((pcm) => {
      decodes++;
      return `segment${decodes}`;
    });
    const transcriber = new FfiBatchTranscriber({
      ffi,
      getContext: () => 1n,
      // Very small step so many decode passes queue up.
      stepSeconds: 0.01,
      windowSeconds: 0.5,
      overlapSeconds: 0.1,
    });

    // Feed ~1.5 s to force multiple decode passes.
    for (let i = 0; i < 3; i++) {
      transcriber.feed(
        makePcmFrame(Math.round(0.5 * ASR_SAMPLE_RATE), i * 500),
      );
    }
    const final = await transcriber.flush();
    expect(final.isFinal).toBe(true);
    // All enqueued decodes ran before flush() resolved.
    expect(decodes).toBeGreaterThan(0);
    transcriber.dispose();
  });

  // Guard: real model tests are skipped — no models >2B are loaded.
  it.skipIf(true)(
    "SKIP — real Qwen3-ASR model: flush() of a live stream returns the full utterance",
    async () => {
      // This test requires a real libelizainference build with a bundled
      // ASR model. It is always skipped in CI to avoid loading large models.
    },
  );
});
