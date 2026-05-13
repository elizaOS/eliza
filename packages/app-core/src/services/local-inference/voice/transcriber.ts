/**
 * Streaming ASR adapters for the local voice pipeline.
 *
 * Implements the `StreamingTranscriber` contract from `voice/types.ts`:
 * PCM frames in (`feed`), running partial-transcript events out, `flush()`
 * to force-finalize on `speech-end`. Two adapters, resolved in priority
 * order by `createStreamingTranscriber()`:
 *
 *   1. `FfiStreamingTranscriber` — the FINAL path. Drives the fused
 *      `libelizainference` streaming ASR ABI (`eliza_inference_asr_stream_*`,
 *      ABI v2 — declared in `packages/app-core/scripts/omnivoice-fuse/ffi.h`,
 *      bound in `voice/ffi-bindings.ts`). The C side is W7's job; until the
 *      real fused build advertises streaming ASR the binding's `mmap`/`asr`
 *      calls return `ELIZA_ERR_NOT_IMPLEMENTED`, which surfaces as a thrown
 *      error here. Selected only when `ffi.asrStreamSupported()` is true.
 *
 *   2. `FfiBatchTranscriber` — the contract-clean INTERIM path. Runs the
 *      fused build's *batch* decoder (`eliza_inference_asr_transcribe`, ABI
 *      v1) over a sliding window with overlap, so each call covers ≤ ~6–7 s
 *      of audio — incremental, not "buffer the whole utterance, one giant
 *      decode". It lives inside the single shipped llama.cpp/GGML build and
 *      emits the Qwen2-BPE text-vocab (AGENTS.md §1/§4), so it does not
 *      vendor a second ggml or introduce a tokenizer-family mismatch.
 *      Selected whenever a `libelizainference` handle + bundled ASR model are
 *      present (which is always true when the fused build is loaded).
 *
 * If neither is available, `createStreamingTranscriber()` throws
 * `AsrUnavailableError` — a real failure, never a silent empty-transcript
 * degrade (AGENTS.md §3 + §9). There is no whisper.cpp fallback path: that
 * dependency vendored a second GGML, mismatched the Qwen2-BPE vocab, and is
 * not the local-inference contract we ship.
 */

import type {
  ElizaInferenceContextHandle,
  ElizaInferenceFfi,
} from "./ffi-bindings";
import {
  makeOpenVinoWhisperDecoder,
  resolveOpenVinoWhisperRuntime,
} from "./openvino-whisper-asr";
import type {
  PcmFrame,
  StreamingTranscriber,
  TranscriberEvent,
  TranscriberEventListener,
  TranscriptUpdate,
  VadEvent,
  VadEventSource,
  VoiceInputSource,
  VoiceSpeaker,
  VoiceTurnMetadata,
} from "./types";

/** The local voice runtime resamples mic input to 16 kHz mono for ASR. */
export const ASR_SAMPLE_RATE = 16_000;

/**
 * Raised when no ASR backend can be resolved. Distinct error class so the
 * caller (engine, `TRANSCRIPTION` model handler) can surface "ASR is not
 * installed" with an actionable message rather than treating an empty
 * string as a successful transcription.
 */
export class AsrUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AsrUnavailableError";
  }
}

/* ==================================================================== *
 * Shared base — event fan-out, VAD gating, word detection.
 * ==================================================================== */

const WORD_RE = /[\p{L}\p{N}][\p{L}\p{N}'-]*/gu;
const VAD_PREROLL_MAX_FRAMES = 10;

function extractWords(text: string): string[] {
  const out = text.match(WORD_RE);
  return out ? Array.from(out) : [];
}

/**
 * Linear-interpolation resample of mono fp32 PCM. Used to coerce mic
 * frames (commonly 16 / 24 / 48 kHz) to the ASR rate. Not a polyphase
 * filter — adequate for speech ASR; the fused build does its own
 * resampling so this is interim-batch only.
 */
export function resampleLinear(
  pcm: Float32Array,
  fromRate: number,
  toRate: number,
): Float32Array {
  if (fromRate === toRate || pcm.length === 0) return pcm;
  const ratio = toRate / fromRate;
  const outLen = Math.max(1, Math.round(pcm.length * ratio));
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const srcPos = i / ratio;
    const i0 = Math.floor(srcPos);
    const i1 = Math.min(i0 + 1, pcm.length - 1);
    const frac = srcPos - i0;
    out[i] = pcm[i0] * (1 - frac) + pcm[i1] * frac;
  }
  return out;
}

/**
 * Base implementing the boilerplate every adapter shares: listener
 * fan-out, the `words`-once-per-segment latch, and (optional) VAD-event
 * gating. Subclasses implement `onFrame` / `onFlush` / `onDispose` and
 * call `emitPartial` / `emitFinal`.
 */
export abstract class BaseStreamingTranscriber implements StreamingTranscriber {
  private readonly listeners = new Set<TranscriberEventListener>();
  private readonly metadata: TranscriptMetadataDefaults;
  /** True between `speech-start`/first-frame and the next `flush()`. */
  protected segmentOpen = false;
  /** Latched once `words` is emitted for the current segment. */
  private wordsEmitted = false;
  /** When set, frames are only forwarded while the VAD is in an active speech window. */
  private vadActive: boolean | null = null;
  private readonly vadPrerollFrames: PcmFrame[] = [];
  private vadUnsub: (() => void) | null = null;
  private disposed = false;

  constructor(vad?: VadEventSource, metadata: TranscriptMetadataDefaults = {}) {
    this.metadata = metadata;
    if (vad) {
      this.vadActive = false;
      this.vadUnsub = vad.onVadEvent((ev) => this.onVadEvent(ev));
    }
  }

  on(listener: TranscriberEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  feed(frame: PcmFrame): void {
    if (this.disposed) {
      throw new Error("[asr] feed() called on a disposed transcriber");
    }
    if (frame.pcm.length === 0) return;
    // VAD gating: while the async VAD is still deciding, retain a tiny
    // leading pre-roll so the first voiced frames are not lost.
    if (this.vadActive === false) {
      this.rememberVadPreroll(frame);
      return;
    }
    if (!this.segmentOpen) {
      this.segmentOpen = true;
      this.wordsEmitted = false;
    }
    this.onFrame(frame);
  }

  async flush(): Promise<TranscriptUpdate> {
    if (this.disposed) {
      throw new Error("[asr] flush() called on a disposed transcriber");
    }
    const update = this.withMetadata(await this.onFlush());
    this.segmentOpen = false;
    this.wordsEmitted = false;
    this.emit({ kind: "final", update });
    return update;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.vadUnsub?.();
    this.vadUnsub = null;
    this.listeners.clear();
    this.onDispose();
  }

  /** Subclass hook: a (VAD-gated) PCM frame for the current speech segment. */
  protected abstract onFrame(frame: PcmFrame): void;
  /** Subclass hook: drain buffered audio, run a final decode, return the final transcript. */
  protected abstract onFlush(): Promise<TranscriptUpdate>;
  /** Subclass hook: release native resources. */
  protected abstract onDispose(): void;

  private rememberVadPreroll(frame: PcmFrame): void {
    this.vadPrerollFrames.push({
      ...frame,
      pcm: frame.pcm.slice(),
    });
    while (this.vadPrerollFrames.length > VAD_PREROLL_MAX_FRAMES) {
      this.vadPrerollFrames.shift();
    }
  }

  private drainVadPreroll(): void {
    if (this.vadPrerollFrames.length === 0) return;
    const frames = this.vadPrerollFrames.splice(0);
    if (!this.segmentOpen) {
      this.segmentOpen = true;
      this.wordsEmitted = false;
    }
    for (const frame of frames) this.onFrame(frame);
  }

  /** Emit a running-partial event and (the first time it has words) a `words` event. */
  protected emitPartial(update: TranscriptUpdate): void {
    const enriched = this.withMetadata(update);
    this.emit({ kind: "partial", update: enriched });
    if (!this.wordsEmitted) {
      const words = extractWords(enriched.partial);
      if (words.length > 0) {
        this.wordsEmitted = true;
        this.emit({ kind: "words", words });
      }
    }
  }

  private withMetadata(update: TranscriptUpdate): TranscriptUpdate {
    if (
      !this.metadata.source &&
      !this.metadata.speaker &&
      !this.metadata.turn
    ) {
      return update;
    }
    const source = update.source ?? this.metadata.source;
    const speaker = update.speaker ?? this.metadata.speaker;
    const segments =
      update.segments ?? update.turn?.segments ?? this.metadata.turn?.segments;
    const turn =
      update.turn || this.metadata.turn
        ? {
            ...this.metadata.turn,
            ...update.turn,
            source:
              update.turn?.source ??
              update.source ??
              this.metadata.turn?.source ??
              source,
            primarySpeaker:
              update.turn?.primarySpeaker ??
              update.speaker ??
              this.metadata.turn?.primarySpeaker ??
              speaker,
          }
        : undefined;
    return {
      ...update,
      ...(source ? { source } : {}),
      ...(speaker ? { speaker } : {}),
      ...(segments ? { segments } : {}),
      ...(turn ? { turn } : {}),
    };
  }

  private emit(event: TranscriberEvent): void {
    for (const l of this.listeners) l(event);
  }

  private onVadEvent(ev: VadEvent): void {
    switch (ev.type) {
      case "speech-start":
      case "speech-active":
        this.vadActive = true;
        this.drainVadPreroll();
        break;
      case "speech-pause":
        // Pause keeps the segment "armed" but stops accepting new audio
        // until speech resumes. The turn controller decides whether a
        // pause finalizes; this layer just stops decoding.
        this.vadActive = false;
        break;
      case "speech-end":
        this.vadActive = false;
        this.vadPrerollFrames.length = 0;
        break;
      case "blip":
        // A blip never opens a speech window — ignore.
        break;
    }
  }
}

export interface TranscriptMetadataDefaults {
  source?: VoiceInputSource;
  speaker?: VoiceSpeaker;
  turn?: VoiceTurnMetadata;
}

/* ==================================================================== *
 * Fused (final) path — eliza_inference_asr_stream_* (ABI v2).
 * ==================================================================== */

/**
 * True when the loaded fused library has a working streaming ASR decoder
 * (not just the v2 symbols — the stub exports them but `asrStreamSupported`
 * returns false). This is the gate `createStreamingTranscriber` uses to
 * pick the fused path over the fused-batch interim adapter.
 */
export function ffiSupportsStreamingAsr(
  ffi: ElizaInferenceFfi | null | undefined,
): boolean {
  if (!ffi || typeof ffi.asrStreamSupported !== "function") return false;
  return ffi.asrStreamSupported();
}

/**
 * `StreamingTranscriber` over the fused `libelizainference` streaming ASR
 * ABI. Each `feed()` forwards the (resampled) PCM into `asrStreamFeed`;
 * after a feed it reads the running partial via `asrStreamPartial`.
 * `flush()` calls `asrStreamFinish` then re-opens a fresh stream for the
 * next segment. Token ids, when the library returns them, are surfaced in
 * `TranscriptUpdate.tokens` — the fused build shares the text vocabulary
 * (AGENTS.md §1) so they feed STT-finish token injection directly.
 *
 * The C side is owned by W7; until the fused build implements these
 * symbols every call throws (the binding maps `ELIZA_ERR_NOT_IMPLEMENTED`
 * to a `VoiceLifecycleError`). That is intentional — no fake transcripts.
 */
export class FfiStreamingTranscriber extends BaseStreamingTranscriber {
  private readonly ffi: ElizaInferenceFfi;
  private readonly getContext: () => ElizaInferenceContextHandle;
  /** Token count to ask the library for per partial; 0 = don't request tokens. */
  private readonly maxTokens: number;
  private stream: bigint | null = null;

  constructor(args: {
    ffi: ElizaInferenceFfi;
    getContext: () => ElizaInferenceContextHandle;
    vad?: VadEventSource;
    metadata?: TranscriptMetadataDefaults;
    source?: VoiceInputSource;
    /** Cap on token ids read back per transcript snapshot. Default 256. */
    maxTokens?: number;
  }) {
    super(args.vad, {
      ...args.metadata,
      source: args.metadata?.source ?? args.source,
    });
    if (!ffiSupportsStreamingAsr(args.ffi)) {
      throw new AsrUnavailableError(
        "[asr] fused libelizainference does not advertise a working streaming ASR decoder (eliza_inference_asr_stream_supported() == 0) — rebuild the fused omnivoice target or use the fused-batch interim adapter",
      );
    }
    this.ffi = args.ffi;
    this.getContext = args.getContext;
    this.maxTokens = Math.max(0, Math.floor(args.maxTokens ?? 256));
  }

  private ensureStream(): bigint {
    if (this.stream !== null) return this.stream;
    this.stream = this.ffi.asrStreamOpen({
      ctx: this.getContext(),
      sampleRateHz: ASR_SAMPLE_RATE,
    });
    return this.stream;
  }

  protected onFrame(frame: PcmFrame): void {
    const pcm = resampleLinear(frame.pcm, frame.sampleRate, ASR_SAMPLE_RATE);
    const handle = this.ensureStream();
    this.ffi.asrStreamFeed({ stream: handle, pcm });
    const update = this.ffi.asrStreamPartial({
      stream: handle,
      maxTokens: this.maxTokens,
    });
    this.emitPartial({ ...update, isFinal: false });
  }

  protected async onFlush(): Promise<TranscriptUpdate> {
    if (this.stream === null) {
      return { partial: "", isFinal: true };
    }
    const handle = this.stream;
    const update = this.ffi.asrStreamFinish({
      stream: handle,
      maxTokens: this.maxTokens,
    });
    this.ffi.asrStreamClose(handle);
    this.stream = null;
    return { ...update, isFinal: true };
  }

  protected onDispose(): void {
    if (this.stream !== null) {
      this.ffi.asrStreamClose(this.stream);
      this.stream = null;
    }
  }
}

/* ==================================================================== *
 * Fused batch (interim streaming) path — eliza_inference_asr_transcribe.
 * ==================================================================== */

export interface FfiBatchTranscriberOptions {
  ffi: ElizaInferenceFfi;
  getContext: () => ElizaInferenceContextHandle;
  vad?: VadEventSource;
  metadata?: TranscriptMetadataDefaults;
  source?: VoiceInputSource;
  /** Sliding-window length, seconds. Each batch decode covers ≤ this + overlap. Default 6.0. */
  windowSeconds?: number;
  /** Trailing overlap kept when committing a prefix chunk, seconds. Default 1.0. */
  overlapSeconds?: number;
  /** Minimum new audio (seconds) accumulated before the next decode pass. Default 1.2. */
  stepSeconds?: number;
}

/**
 * Interim streaming-ASR adapter over the fused `libelizainference` **batch**
 * decoder (`eliza_inference_asr_transcribe`, ABI v1). The fused build's true
 * streaming decoder (`eliza_inference_asr_stream_*`, ABI v2) is W7's job and
 * is an honest stub today; until it lands this adapter is the contract-clean
 * interim — it runs inside the one shipped llama.cpp/GGML build and emits
 * Qwen2-BPE token-vocab text (AGENTS.md §1, §4), so no second ggml is
 * vendored and no tokenizer-family mismatch is introduced.
 *
 * It runs a *windowed re-transcription with overlap* strategy: a prefix older
 * than `windowSeconds` is committed (decoded once, in window-sized chunks
 * with `overlapSeconds` carry-over) and only the tail window is re-decoded
 * each step. So each `asr_transcribe` call is bounded by `windowSeconds +
 * overlap` of audio (≈6–7 s) — incremental, not "buffer the whole utterance,
 * run one giant batch decode". Decodes run serially on the shared ASR mutex
 * (the fused context's ASR region is single-threaded).
 *
 * Requires `ffi.mmapAcquire(ctx, "asr")` to have been called on `getContext()`
 * — the `EngineVoiceBridge` lifecycle does this when voice input is armed.
 */
export class FfiBatchTranscriber extends BaseStreamingTranscriber {
  private readonly ffi: ElizaInferenceFfi;
  private readonly getContext: () => ElizaInferenceContextHandle;
  private readonly windowSamples: number;
  private readonly overlapSamples: number;
  private readonly stepSamples: number;
  /** All 16 kHz samples accumulated for the current speech segment. */
  private buf: Float32Array = new Float32Array(0);
  /** Samples in `buf` already folded into `committed`. */
  private committedSamples = 0;
  /** Text decoded from `buf[0 .. committedSamples)`. */
  private committed = "";
  /** `buf.length` at the last decode pass — throttles to `stepSamples`. */
  private lastDecodeAt = 0;
  /** Decode chain — `asr_transcribe` calls serialize on the native ASR mutex anyway. */
  private decodeChain: Promise<void> = Promise.resolve();

  constructor(opts: FfiBatchTranscriberOptions) {
    super(opts.vad, {
      ...opts.metadata,
      source: opts.metadata?.source ?? opts.source,
    });
    this.ffi = opts.ffi;
    this.getContext = opts.getContext;
    const windowSeconds = opts.windowSeconds ?? 6.0;
    const overlapSeconds = Math.min(opts.overlapSeconds ?? 1.0, windowSeconds);
    const stepSeconds = opts.stepSeconds ?? 1.2;
    this.windowSamples = Math.round(windowSeconds * ASR_SAMPLE_RATE);
    this.overlapSamples = Math.round(overlapSeconds * ASR_SAMPLE_RATE);
    this.stepSamples = Math.round(stepSeconds * ASR_SAMPLE_RATE);
  }

  private decodeWindow(pcm16k: Float32Array): string {
    if (pcm16k.length === 0) return "";
    return this.ffi
      .asrTranscribe({
        ctx: this.getContext(),
        pcm: pcm16k,
        sampleRateHz: ASR_SAMPLE_RATE,
      })
      .trim();
  }

  protected onFrame(frame: PcmFrame): void {
    const pcm = resampleLinear(frame.pcm, frame.sampleRate, ASR_SAMPLE_RATE);
    this.buf = concatFloat32(this.buf, pcm);
    if (this.buf.length - this.lastDecodeAt < this.stepSamples) return;
    this.lastDecodeAt = this.buf.length;
    this.scheduleDecode(false);
  }

  protected async onFlush(): Promise<TranscriptUpdate> {
    this.scheduleDecode(true);
    await this.decodeChain;
    const final = this.committed.trim();
    this.resetSegment();
    return { partial: final, isFinal: true };
  }

  protected onDispose(): void {
    this.resetSegment();
  }

  private resetSegment(): void {
    this.buf = new Float32Array(0);
    this.committedSamples = 0;
    this.committed = "";
    this.lastDecodeAt = 0;
  }

  private scheduleDecode(final: boolean): void {
    this.decodeChain = this.decodeChain.then(() => this.runDecode(final));
  }

  private async runDecode(final: boolean): Promise<void> {
    const total = this.buf.length;
    if (total <= this.committedSamples && !final) return;

    // Commit any prefix that has scrolled fully out of the sliding window.
    while (total - this.committedSamples > this.windowSamples) {
      const chunkEnd = Math.min(
        total,
        this.committedSamples + this.windowSamples,
      );
      const chunk = this.buf.subarray(this.committedSamples, chunkEnd);
      const text = this.decodeWindow(chunk);
      this.committed = joinTranscriptParts(this.committed, text);
      const advance = Math.max(1, this.windowSamples - this.overlapSamples);
      this.committedSamples = Math.min(total, this.committedSamples + advance);
    }

    const tail = this.buf.subarray(this.committedSamples, total);
    const tailText = this.decodeWindow(tail);

    if (final) {
      this.committed = joinTranscriptParts(this.committed, tailText);
      this.committedSamples = total;
      return;
    }

    this.emitPartial({
      partial: joinTranscriptParts(this.committed, tailText).trim(),
      isFinal: false,
    });
  }
}

function concatFloat32(a: Float32Array, b: Float32Array): Float32Array {
  if (a.length === 0) return b.slice();
  if (b.length === 0) return a;
  const out = new Float32Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/**
 * Join two transcript fragments, collapsing the seam: drop a trailing
 * partial-word from `head` if `tail` begins mid-word (overlap re-decode
 * can split a word at the chunk boundary). Conservative — only trims when
 * both sides clearly continue the same token-ish run.
 */
function joinTranscriptParts(head: string, tail: string): string {
  const h = head.trimEnd();
  const t = tail.trimStart();
  if (!h) return t;
  if (!t) return h;
  // If `tail` starts with a continuation of `head`'s last word, prefer
  // `tail`'s spelling of the overlap region: drop `head`'s last word when
  // `tail`'s first word starts with the same prefix (case-insensitive).
  const headLast = h.match(/[\p{L}\p{N}'-]+$/u)?.[0] ?? "";
  const tailFirst = t.match(/^[\p{L}\p{N}'-]+/u)?.[0] ?? "";
  if (headLast && tailFirst?.toLowerCase().startsWith(headLast.toLowerCase())) {
    return `${h.slice(0, h.length - headLast.length).trimEnd()} ${t}`.trim();
  }
  return `${h} ${t}`;
}

/* ==================================================================== *
 * OpenVINO Whisper streaming transcriber.
 * ==================================================================== */

/** Injectable decoder: decodes one PCM window (16 kHz mono fp32) into text. */
export type StreamingPcmDecoder = (pcm16k: Float32Array) => Promise<string>;

export interface OpenVinoStreamingTranscriberOptions {
  vad?: VadEventSource;
  /** Optional attribution metadata stamped onto emitted transcript updates. */
  metadata?: TranscriptMetadataDefaults;
  /** Convenience shorthand for `metadata.source`. */
  source?: VoiceInputSource;
  /** Sliding-window length, seconds. Default 3.0. */
  windowSeconds?: number;
  /** Trailing overlap kept when committing a prefix chunk, seconds. Default 0.5. */
  overlapSeconds?: number;
  /** Minimum new audio (seconds) accumulated before the next decode pass. Default 0.7. */
  stepSeconds?: number;
  /** The decoder. Required — the OpenVINO adapter supplies its python-worker decoder here. */
  decoder: StreamingPcmDecoder;
  /**
   * Extra cleanup invoked from `dispose()` after segment buffers are reset.
   * Used when the injected `decoder` owns a persistent subprocess (the
   * OpenVINO whisper worker) that needs to be torn down with the
   * transcriber.
   */
  onDispose?: () => void;
}

/**
 * Sliding-window streaming transcriber driven by an injected decoder. The
 * OpenVINO Whisper adapter is the only consumer today: it supplies a decoder
 * function bound to its persistent Python worker. The previous whisper.cpp
 * adapter has been removed (it vendored a second GGML + mismatched the
 * Qwen2-BPE vocab).
 */
export class OpenVinoStreamingTranscriber extends BaseStreamingTranscriber {
  private readonly windowSamples: number;
  private readonly overlapSamples: number;
  private readonly stepSamples: number;
  private readonly decode: StreamingPcmDecoder;
  private readonly extraDispose: (() => void) | undefined;
  /** All 16 kHz samples accumulated for the current speech segment. */
  private buf: Float32Array = new Float32Array(0);
  /** Samples in `buf` already folded into `committed`. */
  private committedSamples = 0;
  /** Text decoded from `buf[0 .. committedSamples)`. */
  private committed = "";
  /** Samples present at the last decode pass — used to throttle to `stepSamples`. */
  private lastDecodeAt = 0;
  private decodeChain: Promise<void> = Promise.resolve();

  constructor(opts: OpenVinoStreamingTranscriberOptions) {
    super(opts.vad, {
      ...opts.metadata,
      source: opts.metadata?.source ?? opts.source,
    });
    const windowSeconds = opts.windowSeconds ?? 3.0;
    const overlapSeconds = Math.min(opts.overlapSeconds ?? 0.5, windowSeconds);
    const stepSeconds = opts.stepSeconds ?? 0.7;
    this.windowSamples = Math.round(windowSeconds * ASR_SAMPLE_RATE);
    this.overlapSamples = Math.round(overlapSeconds * ASR_SAMPLE_RATE);
    this.stepSamples = Math.round(stepSeconds * ASR_SAMPLE_RATE);
    this.decode = opts.decoder;
    this.extraDispose = opts.onDispose;
  }

  protected onFrame(frame: PcmFrame): void {
    const pcm = resampleLinear(frame.pcm, frame.sampleRate, ASR_SAMPLE_RATE);
    this.buf = concatFloat32(this.buf, pcm);
    if (this.buf.length - this.lastDecodeAt < this.stepSamples) return;
    this.lastDecodeAt = this.buf.length;
    this.scheduleDecode(false);
  }

  protected async onFlush(): Promise<TranscriptUpdate> {
    this.scheduleDecode(true);
    await this.decodeChain;
    const final = this.committed.trim();
    this.resetSegment();
    return { partial: final, isFinal: true };
  }

  protected onDispose(): void {
    this.resetSegment();
    if (this.extraDispose) {
      try {
        this.extraDispose();
      } catch {
        /* dispose hooks are best-effort */
      }
    }
  }

  private resetSegment(): void {
    this.buf = new Float32Array(0);
    this.committedSamples = 0;
    this.committed = "";
    this.lastDecodeAt = 0;
  }

  private scheduleDecode(final: boolean): void {
    this.decodeChain = this.decodeChain.then(() => this.runDecode(final));
  }

  private async runDecode(final: boolean): Promise<void> {
    const total = this.buf.length;
    if (total <= this.committedSamples && !final) return;

    // Commit any prefix that has scrolled fully out of the sliding window.
    while (total - this.committedSamples > this.windowSamples) {
      const chunkEnd = Math.min(
        total,
        this.committedSamples + this.windowSamples,
      );
      const chunk = this.buf.subarray(this.committedSamples, chunkEnd);
      const text = (await this.decode(chunk)).trim();
      this.committed = joinTranscriptParts(this.committed, text);
      const advance = Math.max(1, this.windowSamples - this.overlapSamples);
      this.committedSamples = Math.min(total, this.committedSamples + advance);
    }

    const tail = this.buf.subarray(this.committedSamples, total);
    const tailText = tail.length > 0 ? (await this.decode(tail)).trim() : "";

    if (final) {
      this.committed = joinTranscriptParts(this.committed, tailText);
      this.committedSamples = total;
      return;
    }

    const partialText = joinTranscriptParts(this.committed, tailText).trim();
    this.emitPartial({ partial: partialText, isFinal: false });
  }
}

/* ==================================================================== *
 * Adapter selection.
 * ==================================================================== */

export interface CreateStreamingTranscriberOptions {
  /** Fused FFI handle (when a `libelizainference` build is loaded), else null. */
  ffi?: ElizaInferenceFfi | null;
  /** Provider for the fused context pointer (the bridge owns the lazy create). */
  getContext?: () => ElizaInferenceContextHandle;
  /**
   * Whether a bundled ASR model directory is present. The fused path is
   * only chosen when this is true AND the library advertises streaming
   * ASR.
   */
  asrBundlePresent?: boolean;
  /** VAD event stream to gate decoding (W1). */
  vad?: VadEventSource;
  /** Optional attribution metadata stamped onto emitted transcript updates. */
  metadata?: TranscriptMetadataDefaults;
  /** Convenience shorthand for `metadata.source`. */
  source?: VoiceInputSource;
  /** Fused-batch-interim window/step overrides (see `FfiBatchTranscriber`). */
  ffiBatch?: Omit<FfiBatchTranscriberOptions, "ffi" | "getContext">;
  /**
   * Force a specific backend.
   *   `"fused"`            → fused streaming ASR only (throws if unavailable),
   *   `"ffi-batch"`        → fused batch (interim) only (throws if unavailable),
   *   `"openvino-whisper"` → OpenVINO Whisper (NPU→CPU autoprobe) only,
   *   `"auto"`             (default) → fused streaming → fused batch →
   *                                    OpenVINO whisper (when enabled) → throw.
   */
  prefer?: "auto" | "fused" | "ffi-batch" | "openvino-whisper";
  /**
   * Permit the OpenVINO Whisper adapter (NPU→CPU autoprobe). Off by default
   * — Eliza-1 voice bridges run only the fused path. Set explicitly to `true`
   * to keep the OpenVINO Whisper tier when the fused build is unavailable.
   */
  allowOpenVinoWhisper?: boolean;
}

/**
 * Resolve the ASR adapter chain:
 *   1. fused streaming ASR (`eliza_inference_asr_stream_*`, ABI v2 — the FINAL
 *      path, W7),
 *   2. fused batch (interim) — windowed `eliza_inference_asr_transcribe` (ABI
 *      v1); contract-clean (one ggml, shared text vocab) and available now,
 *   3. OpenVINO Whisper — Intel NPU→CPU autoprobe via the persistent Python
 *      worker (`scripts/openvino-whisper-asr-worker.py`). Off by default
 *      (`allowOpenVinoWhisper: true` to opt in). Selected only when the
 *      OpenVINO runtime + Whisper IR are present on disk.
 *
 * No silent fallback to an empty transcript — if nothing is available the
 * caller gets a hard, actionable failure (AGENTS.md §3 + §9). The whisper.cpp
 * interim fallback has been removed.
 */
export function createStreamingTranscriber(
  opts: CreateStreamingTranscriberOptions = {},
): StreamingTranscriber {
  const prefer = opts.prefer ?? "auto";
  const allowOpenVinoWhisper = opts.allowOpenVinoWhisper === true;

  const tryFusedStreaming = (): StreamingTranscriber | null => {
    if (!opts.ffi || !opts.getContext) return null;
    if (!opts.asrBundlePresent) return null;
    if (!ffiSupportsStreamingAsr(opts.ffi)) return null;
    return new FfiStreamingTranscriber({
      ffi: opts.ffi,
      getContext: opts.getContext,
      vad: opts.vad,
      metadata: opts.metadata,
      source: opts.source,
    });
  };

  const tryFusedBatch = (): StreamingTranscriber | null => {
    if (!opts.ffi || !opts.getContext) return null;
    if (!opts.asrBundlePresent) return null;
    if (typeof opts.ffi.asrTranscribe !== "function") return null;
    return new FfiBatchTranscriber({
      ...opts.ffiBatch,
      ffi: opts.ffi,
      getContext: opts.getContext,
      vad: opts.vad,
      metadata: opts.metadata,
      source: opts.source,
    });
  };

  const tryOpenVinoWhisper = (): StreamingTranscriber | null => {
    const runtime = resolveOpenVinoWhisperRuntime();
    if (!runtime) return null;
    const { decoder, dispose } = makeOpenVinoWhisperDecoder(runtime);
    try {
      return new OpenVinoStreamingTranscriber({
        vad: opts.vad,
        metadata: opts.metadata,
        source: opts.source,
        decoder,
        onDispose: dispose,
      });
    } catch (err) {
      try {
        dispose();
      } catch {
        /* ignore */
      }
      throw err;
    }
  };

  if (prefer === "fused") {
    const fused = tryFusedStreaming();
    if (fused) return fused;
    throw new AsrUnavailableError(
      "[asr] fused streaming ASR was requested but is not available (no libelizainference handle, no bundled ASR model, or the build does not export eliza_inference_asr_stream_*)",
    );
  }
  if (prefer === "ffi-batch") {
    const batch = tryFusedBatch();
    if (batch) return batch;
    throw new AsrUnavailableError(
      "[asr] fused batch ASR was requested but is not available (no libelizainference handle, no bundled ASR model, or the build does not export eliza_inference_asr_transcribe)",
    );
  }
  if (prefer === "openvino-whisper") {
    const ov = tryOpenVinoWhisper();
    if (ov) return ov;
    throw new AsrUnavailableError(
      "[asr] OpenVINO whisper ASR was requested but is not available (no openvino python venv, no whisper IR model, or worker script missing — set ELIZA_OPENVINO_PYTHON / ELIZA_OPENVINO_WHISPER_MODEL / ELIZA_OPENVINO_WHISPER_WORKER)",
    );
  }

  // auto
  const fused = tryFusedStreaming();
  if (fused) return fused;
  const batch = tryFusedBatch();
  if (batch) return batch;
  if (allowOpenVinoWhisper) {
    const ov = tryOpenVinoWhisper();
    if (ov) return ov;
  }

  throw new AsrUnavailableError(
    "[asr] no fused ASR decoder available — load the fused libelizainference build with a bundled ASR model (eliza_inference_asr_stream_* or eliza_inference_asr_transcribe). The whisper.cpp interim fallback has been removed; the local-inference path requires the fused omnivoice build.",
  );
}
