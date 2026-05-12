/**
 * Streaming-ASR pipeline adapter (item A1 / W7).
 *
 * The base `VoicePipeline` in `voice/pipeline.ts` drives a `StreamingTranscriber`
 * as a batch: it pushes the WHOLE VAD-gated utterance buffer in a single
 * `feed()` call, awaits `flush()`, and only then splits the final transcript
 * into tokens for the drafter/verifier loop. That works for both the fused
 * batch decoder and the whisper.cpp interim path, but it leaves the biggest
 * H2 UX seam (incremental partials → planner / barge-in word-confirm /
 * speculative-on-pause) untapped when the fused build is in streaming mode.
 *
 * Rather than rewrite `pipeline.ts` (the Phase 0/1 agent owns it), this
 * module is a small WRAPPER the engine bridge can use to deliver PCM
 * chunks to a `StreamingTranscriber` as they arrive from the mic / VAD,
 * surface every `partial` event to the turn controller via `onPartial`,
 * and only finalize on `speech-end`. Behind a flag — when the fused
 * library advertises `asrStreamSupported() === false` or the flag is off
 * the caller keeps using `VoicePipeline.transcribeAll` exactly as today.
 *
 * Integration point (documented for the Phase 0/1 agent so they can wire
 * it without merge friction):
 *
 *   1. `EngineVoiceBridge` decides whether streaming is available via
 *      `pickStreamingMode({ ffi, asrBundlePresent, flag })`. When the
 *      mode is `"streaming"`, the bridge constructs `StreamingAsrFeeder`
 *      once per turn (passing the same transcriber that would have been
 *      handed to `VoicePipeline`) and routes mic PCM frames through
 *      `feeder.feedFrame(frame)` instead of buffering them.
 *   2. The feeder forwards every transcriber `partial` event to
 *      `onPartial(update)`. When VAD reports `speech-end` the caller
 *      calls `await feeder.finalize()`; the returned `TranscriptUpdate`
 *      is the final and is used to seed the drafter/verifier loop exactly
 *      as before (`splitTranscriptToTokens(final.partial, 0, final.tokens)`).
 *   3. The batch path (`VoicePipeline.transcribeAll`) is unchanged for
 *      every other adapter — there is no fork in `pipeline.ts` itself.
 *
 * This file is intentionally small and side-effect-free so it can land
 * during the merge window without touching files other agents own.
 */

import { splitTranscriptToTokens } from "../pipeline";
import type {
  PcmFrame,
  StreamingTranscriber,
  TextToken,
  TranscriptUpdate,
} from "../types";

/* ==================================================================== *
 * LocalAgreementBuffer — word-level streaming-ASR partial stabilizer.
 *
 * Streaming ASR emits a fresh word-sequence hypothesis on every audio
 * frame. Individual words near the end of the hypothesis can change
 * across frames ("sat" → "cap" → "sat") before settling. This buffer
 * applies LocalAgreement-n (n=2 default) at the word level: a word is
 * emitted to downstream only when it appears at the same position in n
 * consecutive hypotheses. The committed stable prefix is monotonically
 * non-decreasing — once a word is committed it is never retracted.
 *
 * Word-level (not character-level): suited for the VAD pipeline adapter
 * where downstream consumers (drafter, verifier) operate on word tokens.
 * For the character-level prefix variant, see `partial-stabilizer.ts`.
 * ==================================================================== */

/**
 * LocalAgreement-n word-level partial stabilizer.
 *
 * Usage:
 *   const buf = new LocalAgreementBuffer();
 *   const stable = buf.stable(["hello", "there", "world"]);
 *   // → [] on first call (need n=2 consecutive identical prefix)
 *   const stable2 = buf.stable(["hello", "there", "how"]);
 *   // → ["hello", "there"] (matched across two consecutive hypotheses)
 */
export class LocalAgreementBuffer {
  private readonly n: number;
  /** Rolling window of the last `n` hypotheses, oldest first. */
  private window: string[][] = [];
  /** Monotonically growing committed word list. */
  private committed: string[] = [];

  constructor(n = 2) {
    if (!Number.isFinite(n) || n < 1) {
      throw new Error(
        `[LocalAgreementBuffer] n must be a finite integer >= 1; got ${String(n)}`,
      );
    }
    this.n = Math.floor(n);
  }

  /**
   * Feed the latest word-level hypothesis. Returns the stable committed
   * prefix — the longest leading word sequence that has appeared
   * identically in `n` consecutive calls. Monotonically non-decreasing.
   *
   * A rolling window of the last `n` hypotheses is maintained. Once the
   * window is full, the agreed prefix is the intersection across all `n`
   * entries — word i is in the agreed prefix only if it is identical in
   * every hypothesis in the window.
   */
  stable(current: string[]): string[] {
    this.window.push(current);
    if (this.window.length > this.n) {
      this.window.shift();
    }
    // Need a full window of `n` hypotheses before any word can be agreed.
    if (this.window.length < this.n) {
      return this.committed;
    }
    // Intersect: the agreed prefix is the longest common leading prefix
    // across all entries in the window.
    const first = this.window[0]!;
    let agreedLen = first.length;
    for (let i = 1; i < this.window.length; i++) {
      const h = this.window[i]!;
      let matchLen = 0;
      const limit = Math.min(agreedLen, h.length);
      for (let j = 0; j < limit; j++) {
        if (first[j] === h[j]) matchLen++;
        else break;
      }
      agreedLen = matchLen;
      if (agreedLen === 0) break;
    }
    // Extend committed if the new agreement is longer.
    if (agreedLen > this.committed.length) {
      this.committed = first.slice(0, agreedLen);
    }
    return this.committed;
  }

  /** Clear all state. Call at utterance boundaries. */
  reset(): void {
    this.window = [];
    this.committed = [];
  }

  /** The current committed stable word list (read-only view). */
  getCommitted(): string[] {
    return this.committed;
  }
}

/** Available transcription drive modes. */
export type StreamingPipelineMode = "streaming" | "batch";

export interface PickStreamingModeArgs {
  /** True only when the loaded fused library advertises a working streaming decoder. */
  ffiSupportsStreaming: boolean;
  /** True only when the bundled ASR model is present on disk. */
  asrBundlePresent: boolean;
  /**
   * Feature flag — defaults to FALSE so the streaming path stays opt-in
   * until the Phase 0/1 partial-stabilizer wiring lands. Once that lands
   * the engine bridge flips this default to true.
   */
  enableStreaming: boolean;
}

/**
 * Choose the transcription drive mode. Streaming is selected only when:
 *   - the loaded fused library advertises a working streaming decoder
 *     (`asr_stream_supported() === 1`), AND
 *   - the bundled ASR model is present, AND
 *   - the engine bridge has opted in via `enableStreaming`.
 *
 * Any other combination falls back to the existing batch path
 * (`VoicePipeline.transcribeAll`).
 */
export function pickStreamingMode(
  args: PickStreamingModeArgs,
): StreamingPipelineMode {
  if (!args.enableStreaming) return "batch";
  if (!args.ffiSupportsStreaming) return "batch";
  if (!args.asrBundlePresent) return "batch";
  return "streaming";
}

export interface StreamingAsrFeederEvents {
  /**
   * Called for every transcriber `partial` event the feeder observes
   * BEFORE the segment is finalized. Includes the running `partial`
   * text, `isFinal: false`, and (when the fused build supplied them)
   * the shared text-model token ids.
   */
  onPartial?(update: TranscriptUpdate): void;
  /**
   * Called the first time ≥1 real word is recognized in the segment.
   * Wired into the turn controller's word-confirm gate so the agent
   * only barge-in-cancels on real speech, not blips.
   */
  onWords?(words: ReadonlyArray<string>): void;
  /**
   * Called once, after `finalize()` returns, with the final transcript
   * split into contiguous text tokens (`splitTranscriptToTokens`). The
   * batch path delivers the same shape via `transcribeAll`, so the
   * downstream drafter/verifier loop sees an identical signal.
   */
  onFinalTokens?(
    tokens: ReadonlyArray<TextToken>,
    final: TranscriptUpdate,
  ): void;
}

/**
 * Drives a `StreamingTranscriber` chunk-by-chunk on behalf of the engine
 * bridge / turn controller. One instance per active speech segment;
 * `finalize()` returns the final transcript and the feeder is disposed.
 *
 * Construction takes a `StreamingTranscriber` (already constructed via
 * `createStreamingTranscriber` with the same options used for batch).
 * The feeder does NOT own the transcriber's lifecycle — disposal still
 * runs through the engine bridge so the same path is used when the
 * batch fallback is taken.
 */
export class StreamingAsrFeeder {
  private readonly transcriber: StreamingTranscriber;
  private readonly events: StreamingAsrFeederEvents;
  private latestPartial: TranscriptUpdate | null = null;
  private finalized = false;
  private unsubscribe: (() => void) | null = null;

  constructor(args: {
    transcriber: StreamingTranscriber;
    events?: StreamingAsrFeederEvents;
  }) {
    this.transcriber = args.transcriber;
    this.events = args.events ?? {};
    this.unsubscribe = this.transcriber.on((event) => {
      switch (event.kind) {
        case "partial":
          this.latestPartial = event.update;
          this.events.onPartial?.(event.update);
          break;
        case "words":
          this.events.onWords?.(event.words);
          break;
        case "final":
          // Final events are surfaced via `finalize()`'s return value so
          // the caller has a single point of truth. We do not re-emit
          // them here.
          break;
      }
    });
  }

  /**
   * Feed one PCM frame as it arrives from the mic / connector. Drops
   * frames received after `finalize()` (the segment is over).
   */
  feedFrame(frame: PcmFrame): void {
    if (this.finalized) return;
    this.transcriber.feed(frame);
  }

  /**
   * Force-finalize on `speech-end`. Resolves with the final transcript
   * and emits `onFinalTokens` so the caller can seed the drafter /
   * verifier loop without re-running the surface split itself.
   *
   * Calling `finalize()` twice is a hard error — the segment is over.
   */
  async finalize(): Promise<TranscriptUpdate> {
    if (this.finalized) {
      throw new Error(
        "[streaming-asr] finalize() called twice on the same feeder",
      );
    }
    this.finalized = true;
    const final = await this.transcriber.flush();
    const tokens = splitTranscriptToTokens(final.partial, 0, final.tokens);
    this.events.onFinalTokens?.(tokens, final);
    return final;
  }

  /** The most recent `partial` snapshot observed, or `null` until the first decode lands. */
  getLatestPartial(): TranscriptUpdate | null {
    return this.latestPartial;
  }

  /** Detach the transcriber subscription. Does NOT dispose the transcriber itself. */
  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }
}
