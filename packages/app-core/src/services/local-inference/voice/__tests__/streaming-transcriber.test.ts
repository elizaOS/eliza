/**
 * Streaming-ASR integration tests for item A1 / W7.
 *
 * Covers:
 *   1. `FfiStreamingTranscriber` against a mocked FFI delivers monotonically
 *      growing partials in feed order and a final on flush. (Complements the
 *      partial-coverage in `voice/transcriber.test.ts` — this version walks
 *      through an utterance one frame at a time and checks the partials are
 *      append-only.)
 *   2. `dispose()` cleans up the native handle without flushing first.
 *   3. `pickStreamingMode` selection table (the integration gate).
 *   4. `StreamingAsrFeeder` forwards `partial` / `words` events,
 *      finalizes once, and emits final tokens via `onFinalTokens`.
 */

import { describe, expect, it } from "vitest";
import type {
  ElizaInferenceContextHandle,
  ElizaInferenceFfi,
  ElizaInferenceRegion,
} from "../ffi-bindings";
import {
  pickStreamingMode,
  StreamingAsrFeeder,
} from "../streaming-asr/streaming-pipeline-adapter";
import { ASR_SAMPLE_RATE, FfiStreamingTranscriber } from "../transcriber";
import type {
  PcmFrame,
  TextToken,
  TranscriberEvent,
  TranscriptUpdate,
} from "../types";

/* ---- helpers --------------------------------------------------------- */

interface ScriptedStream {
  partials: ReadonlyArray<{ partial: string; tokens?: number[] }>;
  final: { partial: string; tokens?: number[] };
}

/**
 * Build a fake `ElizaInferenceFfi` that returns a scripted sequence of
 * partials (one per `asrStreamFeed`) and a scripted final on
 * `asrStreamFinish`. Records every feed length so we can assert frame
 * order is preserved.
 */
function scriptedFfi(script: ScriptedStream): {
  ffi: ElizaInferenceFfi;
  state: {
    feeds: number;
    feedLengths: number[];
    closed: boolean;
    openCount: number;
  };
} {
  const state = {
    feeds: 0,
    feedLengths: [] as number[],
    closed: false,
    openCount: 0,
  };
  let handle = 0n;
  const ffi: ElizaInferenceFfi = {
    libraryPath: "/tmp/fake",
    libraryAbiVersion: "3",
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
    asrTranscribe: () => {
      throw new Error("not used");
    },
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
    asrStreamSupported: () => true,
    asrStreamOpen: () => {
      state.openCount += 1;
      handle += 1n;
      return handle;
    },
    asrStreamFeed: ({ pcm }) => {
      state.feedLengths.push(pcm.length);
      state.feeds += 1;
    },
    asrStreamPartial: () => {
      const idx = Math.min(state.feeds - 1, script.partials.length - 1);
      return script.partials[Math.max(0, idx)] ?? { partial: "" };
    },
    asrStreamFinish: () => script.final,
    asrStreamClose: () => {
      state.closed = true;
    },
    close: () => {},
  };
  return { ffi, state };
}

function collect(t: {
  on(l: (e: TranscriberEvent) => void): () => void;
}): TranscriberEvent[] {
  const out: TranscriberEvent[] = [];
  t.on((e) => out.push(e));
  return out;
}

const PCM_FRAME = (samples: number, ts: number): PcmFrame => ({
  pcm: new Float32Array(samples).fill(0.05),
  sampleRate: ASR_SAMPLE_RATE,
  timestampMs: ts,
});

/* ---- FfiStreamingTranscriber ---------------------------------------- */

describe("FfiStreamingTranscriber — frame-by-frame", () => {
  it("emits monotonically growing partials and a final on flush", async () => {
    const script: ScriptedStream = {
      partials: [
        { partial: "hello", tokens: [11] },
        { partial: "hello there", tokens: [11, 22] },
        { partial: "hello there how", tokens: [11, 22, 33] },
      ],
      final: {
        partial: "hello there how are you",
        tokens: [11, 22, 33, 44, 55],
      },
    };
    const { ffi, state } = scriptedFfi(script);

    const t = new FfiStreamingTranscriber({ ffi, getContext: () => 1n });
    const events = collect(t);

    // 3 frames, one feed each.
    for (let i = 0; i < 3; i++) {
      t.feed(PCM_FRAME(1600, i * 100));
    }

    expect(state.feeds).toBe(3);
    expect(state.openCount).toBe(1);

    const partials = events
      .filter(
        (e): e is TranscriberEvent & { kind: "partial" } =>
          e.kind === "partial",
      )
      .map((e) => e.update.partial);
    expect(partials).toEqual(["hello", "hello there", "hello there how"]);
    // Token ids ride alongside.
    const lastPartial = events
      .filter(
        (e): e is TranscriberEvent & { kind: "partial" } =>
          e.kind === "partial",
      )
      .at(-1);
    expect(lastPartial?.update.tokens).toEqual([11, 22, 33]);

    const final = await t.flush();
    expect(final.partial).toBe("hello there how are you");
    expect(final.isFinal).toBe(true);
    expect(final.tokens).toEqual([11, 22, 33, 44, 55]);
    expect(state.closed).toBe(true);
  });

  it("dispose() closes the native session without flushing", () => {
    const { ffi, state } = scriptedFfi({
      partials: [{ partial: "ok" }],
      final: { partial: "ok done" },
    });
    const t = new FfiStreamingTranscriber({ ffi, getContext: () => 1n });
    t.feed(PCM_FRAME(160, 0));
    expect(state.closed).toBe(false);
    t.dispose();
    expect(state.closed).toBe(true);
  });

  it("dispose() is idempotent", () => {
    const { ffi } = scriptedFfi({
      partials: [{ partial: "" }],
      final: { partial: "" },
    });
    const t = new FfiStreamingTranscriber({ ffi, getContext: () => 1n });
    t.dispose();
    expect(() => t.dispose()).not.toThrow();
  });
});

/* ---- pickStreamingMode --------------------------------------------- */

describe("pickStreamingMode", () => {
  it("returns 'streaming' only when every gate is true", () => {
    expect(
      pickStreamingMode({
        ffiSupportsStreaming: true,
        asrBundlePresent: true,
        enableStreaming: true,
      }),
    ).toBe("streaming");
  });

  it.each([
    {
      ffiSupportsStreaming: false,
      asrBundlePresent: true,
      enableStreaming: true,
    },
    {
      ffiSupportsStreaming: true,
      asrBundlePresent: false,
      enableStreaming: true,
    },
    {
      ffiSupportsStreaming: true,
      asrBundlePresent: true,
      enableStreaming: false,
    },
  ])("falls back to 'batch' when any gate is false (%j)", (args) => {
    expect(pickStreamingMode(args)).toBe("batch");
  });
});

/* ---- StreamingAsrFeeder -------------------------------------------- */

describe("StreamingAsrFeeder", () => {
  it("forwards partial + words events and emits final tokens on finalize", async () => {
    const script: ScriptedStream = {
      partials: [{ partial: "" }, { partial: "hi" }, { partial: "hi there" }],
      final: { partial: "hi there friend", tokens: [1, 2, 3] },
    };
    const { ffi } = scriptedFfi(script);
    const transcriber = new FfiStreamingTranscriber({
      ffi,
      getContext: () => 1n,
    });

    const partials: TranscriptUpdate[] = [];
    const words: string[][] = [];
    const finalEvents: Array<{
      tokens: ReadonlyArray<TextToken>;
      final: TranscriptUpdate;
    }> = [];

    const feeder = new StreamingAsrFeeder({
      transcriber,
      events: {
        onPartial: (u) => partials.push(u),
        onWords: (w) => words.push([...w]),
        onFinalTokens: (tokens, final) => {
          finalEvents.push({ tokens, final });
        },
      },
    });

    feeder.feedFrame(PCM_FRAME(160, 0));
    feeder.feedFrame(PCM_FRAME(160, 10));
    feeder.feedFrame(PCM_FRAME(160, 20));

    expect(partials.length).toBe(3);
    expect(partials.map((p) => p.partial)).toEqual(["", "hi", "hi there"]);
    // "words" fires on the FIRST partial with at least one recognized word.
    expect(words).toEqual([["hi"]]);

    const final = await feeder.finalize();
    expect(final.partial).toBe("hi there friend");
    const finalEvent = finalEvents[0];
    if (!finalEvent) {
      throw new Error("Expected a final transcriber event.");
    }
    // `splitTranscriptToTokens` keeps the leading space attached to each
    // chunk after the first so `tokens.map(t => t.text).join("")` round-trips.
    expect(finalEvent.tokens.map((t) => t.text)).toEqual([
      "hi",
      " there",
      " friend",
    ]);

    feeder.dispose();
    transcriber.dispose();
  });

  it("drops feeds received after finalize()", async () => {
    const script: ScriptedStream = {
      partials: [{ partial: "a" }],
      final: { partial: "a" },
    };
    const { ffi, state } = scriptedFfi(script);
    const transcriber = new FfiStreamingTranscriber({
      ffi,
      getContext: () => 1n,
    });
    const feeder = new StreamingAsrFeeder({ transcriber });

    feeder.feedFrame(PCM_FRAME(160, 0));
    await feeder.finalize();

    feeder.feedFrame(PCM_FRAME(160, 100));
    feeder.feedFrame(PCM_FRAME(160, 200));
    // Only the pre-finalize feed reached the FFI.
    expect(state.feeds).toBe(1);

    feeder.dispose();
  });

  it("rejects a second finalize() call", async () => {
    const { ffi } = scriptedFfi({
      partials: [{ partial: "" }],
      final: { partial: "" },
    });
    const transcriber = new FfiStreamingTranscriber({
      ffi,
      getContext: () => 1n,
    });
    const feeder = new StreamingAsrFeeder({ transcriber });

    await feeder.finalize();
    await expect(feeder.finalize()).rejects.toThrow(/twice/i);
    feeder.dispose();
  });
});
