/**
 * Unit tests for the streaming ASR adapters (`voice/transcriber.ts`).
 *
 * No native binary, no real fused library: the whisper.cpp adapter takes
 * an injected decoder (a fake "ASR backend"), and the fused adapter takes
 * a fake `ElizaInferenceFfi`. A tiny fake PCM source drives `feed()`.
 */

import { describe, expect, it } from "vitest";
import type {
  ElizaInferenceContextHandle,
  ElizaInferenceFfi,
  ElizaInferenceRegion,
} from "./ffi-bindings";
import {
  ASR_SAMPLE_RATE,
  AsrUnavailableError,
  createStreamingTranscriber,
  FfiStreamingTranscriber,
  parseWhisperStdout,
  resampleLinear,
  WhisperCppStreamingTranscriber,
} from "./transcriber";
import type {
  PcmFrame,
  TranscriberEvent,
  VadEvent,
  VadEventSource,
} from "./types";

/* ---- test doubles -------------------------------------------------- */

/** Emits N frames of `framesSamples` samples each at `sampleRate`. */
function makeFrames(
  count: number,
  samplesPerFrame: number,
  sampleRate = ASR_SAMPLE_RATE,
): PcmFrame[] {
  return Array.from({ length: count }, (_v, i) => ({
    pcm: new Float32Array(samplesPerFrame).fill(0.01),
    sampleRate,
    timestampMs: i,
  }));
}

/** A minimal VAD source whose `emit` the test drives manually. */
class FakeVad implements VadEventSource {
  private listeners = new Set<(e: VadEvent) => void>();
  onVadEvent(l: (e: VadEvent) => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
  emit(e: VadEvent): void {
    for (const l of this.listeners) l(e);
  }
}

/** Collect all transcriber events for assertions. */
function collect(t: {
  on(l: (e: TranscriberEvent) => void): () => void;
}): TranscriberEvent[] {
  const out: TranscriberEvent[] = [];
  t.on((e) => out.push(e));
  return out;
}

/**
 * A scripted whisper decoder: returns the n-th canned transcript for the
 * n-th call, records every window length it was handed (so the test can
 * assert the windows are bounded — i.e. genuinely incremental).
 */
function scriptedDecoder(scripts: string[]) {
  const windows: number[] = [];
  let i = 0;
  const decode = async (pcm16k: Float32Array): Promise<string> => {
    windows.push(pcm16k.length);
    const out = scripts[Math.min(i, scripts.length - 1)] ?? "";
    i++;
    return out;
  };
  return {
    decode,
    windows,
    get calls() {
      return i;
    },
  };
}

/* ---- whisper.cpp interim adapter ---------------------------------- */

describe("WhisperCppStreamingTranscriber", () => {
  it("emits incremental partials and a final transcript on flush", async () => {
    const dec = scriptedDecoder(["hello", "hello there", "hello there friend"]);
    const t = new WhisperCppStreamingTranscriber({
      decoder: dec.decode,
      windowSeconds: 100, // big window → no prefix commit in this short clip
      stepSeconds: 0.05, // decode after each small frame
    });
    const events = collect(t);

    // ~0.05 s per frame at 16 kHz = 800 samples; step is 0.05 s.
    for (const f of makeFrames(3, Math.round(0.06 * ASR_SAMPLE_RATE))) {
      t.feed(f);
      // let the serial decode chain drain.
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 0));
    }

    const partials = events.filter((e) => e.kind === "partial");
    expect(partials.length).toBeGreaterThanOrEqual(1);
    // Running transcript grows (last partial is the longest seen).
    expect(partials.at(-1)).toMatchObject({
      kind: "partial",
      update: { partial: expect.stringContaining("hello"), isFinal: false },
    });

    const final = await t.flush();
    expect(final.isFinal).toBe(true);
    expect(final.partial.length).toBeGreaterThan(0);
    // A `final` event was emitted too.
    expect(events.some((e) => e.kind === "final")).toBe(true);

    t.dispose();
  });

  it("commits a bounded prefix when the segment exceeds the window (windows stay small)", async () => {
    const dec = scriptedDecoder(["a", "a b", "a b c", "a b c d", "a b c d e"]);
    const t = new WhisperCppStreamingTranscriber({
      decoder: dec.decode,
      windowSeconds: 0.5, // tiny window → forces prefix commits
      overlapSeconds: 0.1,
      stepSeconds: 0.1,
    });
    // Feed ~2 s of audio in 0.2 s frames → far exceeds the 0.5 s window.
    for (const f of makeFrames(10, Math.round(0.2 * ASR_SAMPLE_RATE))) {
      t.feed(f);
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 0));
    }
    await t.flush();
    // Every decode window must be bounded by ~window+overlap of audio —
    // i.e. we never re-decoded the whole 2 s buffer.
    const maxWindow = Math.round((0.5 + 0.1) * ASR_SAMPLE_RATE) + 1;
    expect(Math.max(...dec.windows)).toBeLessThanOrEqual(maxWindow);
    expect(dec.calls).toBeGreaterThan(2); // multiple commit + tail passes
    t.dispose();
  });

  it("fires a `words` event exactly once, the first time a real word appears", async () => {
    const dec = scriptedDecoder(["", "okay", "okay so", "okay so anyway"]);
    const t = new WhisperCppStreamingTranscriber({
      decoder: dec.decode,
      windowSeconds: 100,
      stepSeconds: 0.05,
    });
    const events = collect(t);
    for (const f of makeFrames(4, Math.round(0.06 * ASR_SAMPLE_RATE))) {
      t.feed(f);
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 0));
    }
    const wordEvents = events.filter((e) => e.kind === "words");
    expect(wordEvents).toHaveLength(1);
    expect(wordEvents[0]).toMatchObject({ kind: "words", words: ["okay"] });
    // A fresh segment after flush re-arms the `words` latch.
    await t.flush();
    for (const f of makeFrames(2, Math.round(0.06 * ASR_SAMPLE_RATE))) {
      t.feed(f);
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 0));
    }
    expect(
      events.filter((e) => e.kind === "words").length,
    ).toBeGreaterThanOrEqual(1);
    t.dispose();
  });

  it("gates on the VAD stream — frames outside an active speech window are dropped", async () => {
    const dec = scriptedDecoder(["should not be decoded"]);
    const vad = new FakeVad();
    const t = new WhisperCppStreamingTranscriber({
      decoder: dec.decode,
      vad,
      windowSeconds: 100,
      stepSeconds: 0.01,
    });
    // VAD has not reported speech yet → feeds are dropped.
    for (const f of makeFrames(5, Math.round(0.05 * ASR_SAMPLE_RATE)))
      t.feed(f);
    await new Promise((r) => setTimeout(r, 0));
    expect(dec.calls).toBe(0);

    // Speech becomes active → feeds are now decoded.
    vad.emit({ type: "speech-start", timestampMs: 0, probability: 1 });
    for (const f of makeFrames(2, Math.round(0.05 * ASR_SAMPLE_RATE))) {
      t.feed(f);
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 0));
    }
    expect(dec.calls).toBeGreaterThan(0);

    // Speech ends → feeds are dropped again.
    const before = dec.calls;
    vad.emit({ type: "speech-end", timestampMs: 0, speechDurationMs: 1000 });
    for (const f of makeFrames(3, Math.round(0.05 * ASR_SAMPLE_RATE)))
      t.feed(f);
    await new Promise((r) => setTimeout(r, 0));
    expect(dec.calls).toBe(before);
    t.dispose();
  });

  it("rejects feed/flush after dispose", async () => {
    const t = new WhisperCppStreamingTranscriber({ decoder: async () => "x" });
    t.dispose();
    expect(() =>
      t.feed({
        pcm: new Float32Array([0.1]),
        sampleRate: ASR_SAMPLE_RATE,
        timestampMs: 0,
      }),
    ).toThrow(/disposed/);
    await expect(t.flush()).rejects.toThrow(/disposed/);
  });
});

/* ---- adapter selection -------------------------------------------- */

describe("createStreamingTranscriber — adapter chain", () => {
  it("throws AsrUnavailableError when no backend is available (prefer=whisper, no binary)", () => {
    // No fused ffi; whisper resolution fails (no binary in this env).
    expect(() => createStreamingTranscriber({ prefer: "whisper" })).toThrow(
      AsrUnavailableError,
    );
  });

  it("throws AsrUnavailableError when prefer=fused but no fused streaming ASR", () => {
    expect(() => createStreamingTranscriber({ prefer: "fused" })).toThrow(
      AsrUnavailableError,
    );
    // ffi present but reports no working decoder → still unavailable for `fused`.
    const ffi = makeFakeFfi({ streamSupported: false });
    expect(() =>
      createStreamingTranscriber({
        prefer: "fused",
        ffi,
        getContext: () => 1n,
        asrBundlePresent: true,
      }),
    ).toThrow(AsrUnavailableError);
  });

  it("selects the fused adapter when the library advertises a working streaming decoder", () => {
    const ffi = makeFakeFfi({ streamSupported: true });
    const t = createStreamingTranscriber({
      ffi,
      getContext: () => 1n,
      asrBundlePresent: true,
    });
    expect(t).toBeInstanceOf(FfiStreamingTranscriber);
    t.dispose();
  });

  it("falls through to the whisper adapter when the fused decoder is unavailable but a decoder is injected", () => {
    const ffi = makeFakeFfi({ streamSupported: false });
    const t = createStreamingTranscriber({
      ffi,
      getContext: () => 1n,
      asrBundlePresent: true,
      whisper: { decoder: async () => "fallback" },
    });
    expect(t).toBeInstanceOf(WhisperCppStreamingTranscriber);
    t.dispose();
  });
});

/* ---- fused adapter (against a fake FFI) --------------------------- */

describe("FfiStreamingTranscriber", () => {
  it("feeds frames through the streaming ABI and surfaces partials + tokens; flush finalizes + closes", async () => {
    let feeds = 0;
    let closed = false;
    const ffi = makeFakeFfi({
      streamSupported: true,
      onFeed: () => {
        feeds++;
      },
      partial: () => ({
        partial: feeds === 1 ? "hi" : "hi there",
        tokens: [1, 2],
      }),
      finish: () => ({ partial: "hi there friend", tokens: [1, 2, 3] }),
      onClose: () => {
        closed = true;
      },
    });
    const t = new FfiStreamingTranscriber({ ffi, getContext: () => 1n });
    const events = collect(t);

    t.feed({
      pcm: new Float32Array(160).fill(0.05),
      sampleRate: ASR_SAMPLE_RATE,
      timestampMs: 0,
    });
    t.feed({
      pcm: new Float32Array(160).fill(0.05),
      sampleRate: ASR_SAMPLE_RATE,
      timestampMs: 10,
    });
    expect(feeds).toBe(2);
    const partials = events.filter((e) => e.kind === "partial");
    expect(partials.at(-1)).toMatchObject({
      kind: "partial",
      update: { partial: "hi there", isFinal: false, tokens: [1, 2] },
    });
    // First non-empty partial also produced a `words` event.
    expect(events.some((e) => e.kind === "words")).toBe(true);

    const final = await t.flush();
    expect(final).toMatchObject({
      partial: "hi there friend",
      isFinal: true,
      tokens: [1, 2, 3],
    });
    expect(closed).toBe(true);
    expect(events.some((e) => e.kind === "final")).toBe(true);
    t.dispose();
  });

  it("resamples non-16 kHz frames before feeding", () => {
    const fed: number[] = [];
    const ffi = makeFakeFfi({
      streamSupported: true,
      onFeed: (pcm) => fed.push(pcm.length),
      partial: () => ({ partial: "x" }),
    });
    const t = new FfiStreamingTranscriber({ ffi, getContext: () => 1n });
    // 48 kHz frame of 480 samples (10 ms) → ~160 samples at 16 kHz.
    t.feed({
      pcm: new Float32Array(480).fill(0.05),
      sampleRate: 48_000,
      timestampMs: 0,
    });
    expect(fed[0]).toBe(160);
    t.dispose();
  });

  it("throws AsrUnavailableError when constructed against a library without a working decoder", () => {
    const ffi = makeFakeFfi({ streamSupported: false });
    expect(
      () => new FfiStreamingTranscriber({ ffi, getContext: () => 1n }),
    ).toThrow(AsrUnavailableError);
  });
});

/* ---- pure helpers ------------------------------------------------- */

describe("transcriber helpers", () => {
  it("resampleLinear is a no-op at the same rate and roughly preserves length on downsample", () => {
    const pcm = new Float32Array([0, 0.5, 1, 0.5, 0, -0.5, -1, -0.5]);
    expect(resampleLinear(pcm, 16000, 16000)).toBe(pcm);
    const down = resampleLinear(pcm, 48000, 16000);
    expect(down.length).toBe(Math.round((pcm.length * 16000) / 48000));
  });

  it("parseWhisperStdout extracts transcript text from both timestamped and bare-line output", () => {
    const timestamped =
      "[00:00:00.000 --> 00:00:01.230]   Hello world\n[00:00:01.230 --> 00:00:02.500]   how are you\n";
    expect(parseWhisperStdout(timestamped)).toBe("Hello world how are you");
    const bare = "whisper_init: loading model\n Hello world\n how are you\n";
    expect(parseWhisperStdout(bare)).toBe("Hello world how are you");
    expect(parseWhisperStdout("")).toBe("");
  });
});

/* ---- fake ElizaInferenceFfi -------------------------------------- */

function makeFakeFfi(opts: {
  streamSupported: boolean;
  onFeed?: (pcm: Float32Array) => void;
  partial?: () => { partial: string; tokens?: number[] };
  finish?: () => { partial: string; tokens?: number[] };
  onClose?: () => void;
}): ElizaInferenceFfi {
  let streamHandle = 0n;
  return {
    libraryPath: "/tmp/fake-libelizainference",
    libraryAbiVersion: "2",
    create: (): ElizaInferenceContextHandle => 1n,
    destroy: () => {},
    mmapAcquire: (
      _ctx: ElizaInferenceContextHandle,
      _r: ElizaInferenceRegion,
    ) => {},
    mmapEvict: (
      _ctx: ElizaInferenceContextHandle,
      _r: ElizaInferenceRegion,
    ) => {},
    ttsSynthesize: () => {
      throw new Error("not used");
    },
    asrTranscribe: () => {
      throw new Error("not used");
    },
    ttsStreamSupported: () => false,
    ttsSynthesizeStream: () => {
      throw new Error("not used");
    },
    cancelTts: () => {},
    setVerifierCallback: () => ({ close: () => {} }),
    asrStreamSupported: () => opts.streamSupported,
    asrStreamOpen: () => {
      streamHandle += 1n;
      return streamHandle;
    },
    asrStreamFeed: ({ pcm }) => {
      opts.onFeed?.(pcm);
    },
    asrStreamPartial: () => opts.partial?.() ?? { partial: "" },
    asrStreamFinish: () => opts.finish?.() ?? { partial: "" },
    asrStreamClose: () => {
      opts.onClose?.();
    },
    close: () => {},
  };
}
