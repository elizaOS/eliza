/**
 * Streaming ASR adapters for the local voice pipeline.
 *
 * Implements the `StreamingTranscriber` contract from `voice/types.ts`:
 * PCM frames in (`feed`), running partial-transcript events out, `flush()`
 * to force-finalize on `speech-end`. Two adapters, resolved in priority
 * order by `createStreamingTranscriber()`:
 *
 *   1. `FfiStreamingTranscriber` — the low-latency fused
 *      `libelizainference` streaming ASR ABI (`eliza_inference_asr_stream_*`,
 *      ABI v2 — declared in `packages/app-core/scripts/omnivoice-fuse/ffi.h`,
 *      bound in `voice/ffi-bindings.ts`). Selected only when
 *      `ffi.asrStreamSupported()` is true.
 *
 *   2. `FfiBatchTranscriber` — the current fused fallback. It buffers the
 *      active speech segment and calls the implemented batch
 *      `eliza_inference_asr_transcribe` path at `flush()`. This keeps
 *      EngineVoiceBridge on fused Eliza-1 assets when streaming ASR is not
 *      ready, instead of falling through to whisper or throwing despite a
 *      working bundled ASR model.
 *
 *   3. `WhisperCppStreamingTranscriber` — the INTERIM path. Wraps the
 *      whisper.cpp `main`/`whisper-cli` one-shot binary (the same way the
 *      Electrobun talkmode/swabble modules do) and runs *windowed*
 *      re-transcription with overlap: it commits a prefix in window-sized
 *      chunks and re-decodes only the tail window each step, so each decode
 *      is bounded by `windowSeconds + overlap` of audio — genuinely
 *      incremental, not "re-transcribe the whole buffer and slice". Needs a
 *      whisper.cpp binary + a GGUF model (resolved via env / `whisper-node`
 *      package / `<local-inference-root>/whisper/`; download the model with
 *      `downloadWhisperModel()`).
 *
 * If neither is available, `createStreamingTranscriber()` throws
 * `AsrUnavailableError` — a real failure, never a silent empty-transcript
 * degrade (AGENTS.md §3 + §9).
 *
 * The whisper.cpp adapter spawns its decoder via an injectable function so
 * the unit tests can run a fake decoder without a native binary; the
 * default decoder uses `Bun.spawn` and is only reached at runtime under Bun.
 */

import { createWriteStream, existsSync, mkdirSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable, type Writable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { localInferenceRoot } from "../paths";
import type {
  ElizaInferenceContextHandle,
  ElizaInferenceFfi,
} from "./ffi-bindings";
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

function extractWords(text: string): string[] {
  const out = text.match(WORD_RE);
  return out ? Array.from(out) : [];
}

/**
 * Linear-interpolation resample of mono fp32 PCM. Used to coerce mic
 * frames (commonly 16 / 24 / 48 kHz) to the ASR rate. Not a polyphase
 * filter — adequate for speech ASR; the fused build does its own
 * resampling so this is whisper-interim only.
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
    // VAD gating: when a VAD source is wired, only decode while speech is
    // active. Frames arriving outside an active window are dropped — the
    // VAD's pre-roll buffer (W1) is responsible for the leading context,
    // not this layer.
    if (this.vadActive === false) return;
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
        break;
      case "speech-pause":
        // Pause keeps the segment "armed" but stops accepting new audio
        // until speech resumes. The turn controller decides whether a
        // pause finalizes; this layer just stops decoding.
        this.vadActive = false;
        break;
      case "speech-end":
        this.vadActive = false;
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
 * pick the fused path over the whisper.cpp interim adapter.
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
        "[asr] fused libelizainference does not advertise a working streaming ASR decoder (eliza_inference_asr_stream_supported() == 0) — rebuild the fused omnivoice target or use the whisper.cpp interim adapter",
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

/**
 * Fused ASR fallback over the implemented batch ABI. This is intentionally
 * honest about latency: it emits a final transcript only at `flush()` and does
 * not advertise running partials. The value is correctness and memory sharing:
 * voice mode stays inside the fused Eliza-1 bundle/runtime even before the
 * native streaming ASR session is implemented.
 */
export class FfiBatchTranscriber extends BaseStreamingTranscriber {
  private readonly ffi: ElizaInferenceFfi;
  private readonly getContext: () => ElizaInferenceContextHandle;
  private buf: Float32Array = new Float32Array(0);
  private sampleRate = ASR_SAMPLE_RATE;

  constructor(args: {
    ffi: ElizaInferenceFfi;
    getContext: () => ElizaInferenceContextHandle;
    vad?: VadEventSource;
    metadata?: TranscriptMetadataDefaults;
    source?: VoiceInputSource;
  }) {
    super(args.vad, {
      ...args.metadata,
      source: args.metadata?.source ?? args.source,
    });
    this.ffi = args.ffi;
    this.getContext = args.getContext;
  }

  protected onFrame(frame: PcmFrame): void {
    const pcm = resampleLinear(frame.pcm, frame.sampleRate, ASR_SAMPLE_RATE);
    this.sampleRate = ASR_SAMPLE_RATE;
    this.buf = concatFloat32(this.buf, pcm);
  }

  protected async onFlush(): Promise<TranscriptUpdate> {
    if (this.buf.length === 0) {
      return { partial: "", isFinal: true };
    }
    const text = this.ffi.asrTranscribe({
      ctx: this.getContext(),
      pcm: this.buf,
      sampleRateHz: this.sampleRate,
    });
    this.buf = new Float32Array(0);
    const update = { partial: text.trim(), isFinal: true };
    this.emitPartial(update);
    return update;
  }

  protected onDispose(): void {
    this.buf = new Float32Array(0);
  }
}

/* ==================================================================== *
 * Whisper.cpp (interim) path — windowed re-transcription with overlap.
 * ==================================================================== */

/** Decodes a 16 kHz mono fp32 PCM window into text. Injectable for tests. */
export type WhisperDecoder = (pcm16k: Float32Array) => Promise<string>;

export interface WhisperCppOptions {
  vad?: VadEventSource;
  /** Optional attribution metadata stamped onto emitted transcript updates. */
  metadata?: TranscriptMetadataDefaults;
  /** Convenience shorthand for `metadata.source`. */
  source?: VoiceInputSource;
  /** Sliding-window length, seconds. Each decode covers ≤ this + overlap. Default 3.0. */
  windowSeconds?: number;
  /** Trailing overlap kept when committing a prefix chunk, seconds. Default 0.5. */
  overlapSeconds?: number;
  /** Minimum new audio (seconds) accumulated before the next decode pass. Default 0.7. */
  stepSeconds?: number;
  /** Override the decoder. Production wires the whisper.cpp `Bun.spawn` decoder. */
  decoder?: WhisperDecoder;
  /** Whisper language hint. Default "en" (the bundled `*.en` models). */
  language?: string;
  /** Whisper.cpp binary path override. */
  binaryPath?: string;
  /** Whisper GGUF model path override. */
  modelPath?: string;
}

interface WhisperConfig {
  windowSamples: number;
  overlapSamples: number;
  stepSamples: number;
  language: string;
}

/**
 * Interim ASR adapter built on the whisper.cpp `main`/`whisper-cli`
 * one-shot binary. Accumulates the current speech segment as 16 kHz mono
 * PCM and runs a *windowed* decode: the prefix older than `windowSeconds`
 * is committed (decoded once, in window-sized chunks with `overlapSeconds`
 * carry-over) and only the tail window is re-decoded each step. The
 * running partial = committed text + tail-window decode. `flush()` runs a
 * final decode of the uncommitted tail and resets.
 */
export class WhisperCppStreamingTranscriber extends BaseStreamingTranscriber {
  private readonly cfg: WhisperConfig;
  private readonly decode: WhisperDecoder;
  /** All 16 kHz samples accumulated for the current speech segment. */
  private buf: Float32Array = new Float32Array(0);
  /** Samples in `buf` already folded into `committed`. */
  private committedSamples = 0;
  /** Text decoded from `buf[0 .. committedSamples)`. */
  private committed = "";
  /** Samples present at the last decode pass — used to throttle to `stepSamples`. */
  private lastDecodeAt = 0;
  private decodeChain: Promise<void> = Promise.resolve();

  constructor(opts: WhisperCppOptions = {}) {
    super(opts.vad, {
      ...opts.metadata,
      source: opts.metadata?.source ?? opts.source,
    });
    const windowSeconds = opts.windowSeconds ?? 3.0;
    const overlapSeconds = Math.min(opts.overlapSeconds ?? 0.5, windowSeconds);
    const stepSeconds = opts.stepSeconds ?? 0.7;
    this.cfg = {
      windowSamples: Math.round(windowSeconds * ASR_SAMPLE_RATE),
      overlapSamples: Math.round(overlapSeconds * ASR_SAMPLE_RATE),
      stepSamples: Math.round(stepSeconds * ASR_SAMPLE_RATE),
      language: opts.language ?? "en",
    };
    this.decode =
      opts.decoder ??
      makeWhisperCppDecoder({
        binaryPath: opts.binaryPath,
        modelPath: opts.modelPath,
        language: this.cfg.language,
      });
  }

  protected onFrame(frame: PcmFrame): void {
    const pcm = resampleLinear(frame.pcm, frame.sampleRate, ASR_SAMPLE_RATE);
    this.buf = concatFloat32(this.buf, pcm);
    if (this.buf.length - this.lastDecodeAt < this.cfg.stepSamples) return;
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

  /**
   * Queue a decode pass. Passes run strictly serially (whisper.cpp `main`
   * is a heavyweight subprocess; overlapping them just thrashes). A
   * `final` pass also drains the uncommitted tail into `committed`.
   */
  private scheduleDecode(final: boolean): void {
    this.decodeChain = this.decodeChain.then(() => this.runDecode(final));
  }

  private async runDecode(final: boolean): Promise<void> {
    const total = this.buf.length;
    if (total <= this.committedSamples && !final) return;

    // Commit any prefix that has scrolled fully out of the sliding window.
    while (total - this.committedSamples > this.cfg.windowSamples) {
      const chunkEnd = Math.min(
        total,
        this.committedSamples + this.cfg.windowSamples,
      );
      const chunk = this.buf.subarray(this.committedSamples, chunkEnd);
      const text = (await this.decode(chunk)).trim();
      this.committed = joinTranscriptParts(this.committed, text);
      // Advance, keeping `overlapSamples` of trailing audio so a word
      // straddling the boundary is not clipped.
      const advance = Math.max(
        1,
        this.cfg.windowSamples - this.cfg.overlapSamples,
      );
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

/**
 * Encode mono fp32 PCM as 16-bit PCM RIFF WAV bytes. Local to this module
 * to avoid an import cycle with `engine-bridge.ts` (which has its own copy
 * keyed to the TTS sample rate). whisper.cpp requires 16-bit PCM WAV input.
 */
function encodeMonoPcm16WavBytes(
  pcm: Float32Array,
  sampleRate: number,
): Uint8Array {
  const bytesPerSample = 2;
  const dataBytes = pcm.length * bytesPerSample;
  const out = new Uint8Array(44 + dataBytes);
  const view = new DataView(out.buffer);
  const ascii = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) out[off + i] = s.charCodeAt(i);
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerSample, true);
  view.setUint16(32, bytesPerSample, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, dataBytes, true);
  let off = 44;
  for (const sample of pcm) {
    const clamped = Math.max(-1, Math.min(1, sample));
    view.setInt16(
      off,
      Math.round(clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff),
      true,
    );
    off += bytesPerSample;
  }
  return out;
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
 * whisper.cpp binary + model resolution + the default `Bun.spawn` decoder.
 * ==================================================================== */

const WHISPER_BIN_NAMES =
  process.platform === "win32"
    ? ["whisper-cli.exe", "main.exe"]
    : ["whisper-cli", "main"];

const WHISPER_DEFAULT_MODEL_FILE = "ggml-base.en.bin";

/** Directory the local voice runtime stages whisper.cpp models into. */
export function whisperDir(): string {
  return path.join(localInferenceRoot(), "whisper");
}

/**
 * Resolve the whisper.cpp binary. Order:
 *   1. explicit `override`
 *   2. `ELIZA_WHISPER_BIN` env var (file must exist)
 *   3. `whisper-node`'s bundled `lib/whisper.cpp/{whisper-cli,main}`
 *   4. `<local-inference-root>/whisper/{whisper-cli,main}`
 * Returns null when none is found.
 */
export function resolveWhisperBinary(override?: string): string | null {
  if (override) return existsSync(override) ? override : null;
  const env = process.env.ELIZA_WHISPER_BIN?.trim();
  if (env && existsSync(env)) return env;
  const candidateDirs = [
    process.env.ELIZA_WHISPER_DIR?.trim() || null,
    whisperBundledNodeDir(),
    whisperDir(),
  ].filter((d): d is string => Boolean(d));
  for (const dir of candidateDirs) {
    for (const name of WHISPER_BIN_NAMES) {
      const candidate = path.join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * Resolve the whisper GGUF model. Order:
 *   1. explicit `override`
 *   2. `ELIZA_WHISPER_MODEL` env var (file must exist)
 *   3. `whisper-node`'s bundled `models/ggml-base.en.bin`
 *   4. `<local-inference-root>/whisper/<file>` (download target — see `downloadWhisperModel`)
 * Returns null when none is found.
 */
export function resolveWhisperModelPath(
  override?: string,
  file = WHISPER_DEFAULT_MODEL_FILE,
): string | null {
  if (override) return existsSync(override) ? override : null;
  const env = process.env.ELIZA_WHISPER_MODEL?.trim();
  if (env && existsSync(env)) return env;
  const bundled = whisperBundledNodeDir();
  if (bundled) {
    const inModels = path.join(bundled, "models", file);
    if (existsSync(inModels)) return inModels;
  }
  const staged = path.join(whisperDir(), file);
  if (existsSync(staged)) return staged;
  return null;
}

function whisperBundledNodeDir(): string | null {
  // `whisper-node` ships whisper.cpp under `lib/whisper.cpp/`. Resolve
  // the package without importing it (it has a native build step).
  const guesses = [
    path.join(
      process.cwd(),
      "node_modules",
      "whisper-node",
      "lib",
      "whisper.cpp",
    ),
    path.join(
      localInferenceRoot(),
      "..",
      "node_modules",
      "whisper-node",
      "lib",
      "whisper.cpp",
    ),
  ];
  for (const g of guesses) {
    if (existsSync(g)) return g;
  }
  return null;
}

const WHISPER_MODEL_URLS: Record<string, string> = {
  "ggml-base.en.bin":
    "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin",
  "ggml-small.en.bin":
    "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en.bin",
  "ggml-tiny.en.bin":
    "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.en.bin",
};

/**
 * Download a whisper GGUF model into `<local-inference-root>/whisper/`.
 * Idempotent — returns the existing path if already staged. This is an
 * explicit, on-demand action (the models are 75–500 MB; we never fetch at
 * install time). Throws on a non-OK HTTP response.
 */
export async function downloadWhisperModel(
  file: string = WHISPER_DEFAULT_MODEL_FILE,
): Promise<string> {
  const url = WHISPER_MODEL_URLS[file];
  if (!url) {
    throw new Error(
      `[asr] no known download URL for whisper model "${file}" (known: ${Object.keys(WHISPER_MODEL_URLS).join(", ")})`,
    );
  }
  const dir = whisperDir();
  mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, file);
  if (existsSync(dest)) return dest;
  const tmp = `${dest}.partial`;
  const res = await fetch(url);
  if (!res.ok || !res.body) {
    throw new Error(
      `[asr] failed to download whisper model from ${url}: HTTP ${res.status} ${res.statusText}`,
    );
  }
  const writeStream: Writable = createWriteStream(tmp);
  // `res.body` is a web ReadableStream; in Node 18+ it is async-iterable,
  // so `Readable.from` adapts it without a cast (matches downloader.ts).
  await pipeline(Readable.from(res.body), writeStream);
  await fs.rename(tmp, dest);
  return dest;
}

/**
 * Build the default whisper.cpp decoder: writes the PCM window to a temp
 * WAV, runs the whisper.cpp binary, parses the `[ts --> ts]  text` lines.
 * Resolves binary + model at construction and throws `AsrUnavailableError`
 * when either is missing — that is the explicit "ASR unavailable" failure,
 * surfaced before any frames are fed.
 *
 * `Bun.spawn` is used because production runs under Bun (Electrobun /
 * Capacitor shells); calling this from plain Node throws.
 */
export function makeWhisperCppDecoder(opts: {
  binaryPath?: string;
  modelPath?: string;
  language: string;
}): WhisperDecoder {
  const binary = resolveWhisperBinary(opts.binaryPath);
  if (!binary) {
    throw new AsrUnavailableError(
      "[asr] no whisper.cpp binary found — install `whisper-node` (it bundles whisper.cpp), set ELIZA_WHISPER_BIN to a whisper-cli/main binary, or stage one under <local-inference-root>/whisper/",
    );
  }
  const model = resolveWhisperModelPath(opts.modelPath);
  if (!model) {
    throw new AsrUnavailableError(
      `[asr] no whisper GGUF model found — set ELIZA_WHISPER_MODEL, or run downloadWhisperModel() to stage ${WHISPER_DEFAULT_MODEL_FILE} under <local-inference-root>/whisper/`,
    );
  }
  return async (pcm16k: Float32Array): Promise<string> => {
    const bun = (globalThis as { Bun?: { spawn?: unknown } }).Bun;
    if (!bun || typeof bun.spawn !== "function") {
      throw new Error(
        "[asr] the whisper.cpp interim decoder requires the Bun runtime (Bun.spawn) — production voice runs under Bun via Electrobun/Capacitor",
      );
    }
    const tmpPath = path.join(
      os.tmpdir(),
      `eliza-asr-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.wav`,
    );
    await fs.writeFile(
      tmpPath,
      encodeMonoPcm16WavBytes(pcm16k, ASR_SAMPLE_RATE),
    );
    try {
      const spawn = bun.spawn as (
        cmd: string[],
        opts: Record<string, unknown>,
      ) => { stdout: ReadableStream; exited: Promise<number> };
      const proc = spawn(
        [binary, "-m", model, "-f", tmpPath, "-l", opts.language, "-nt", "-np"],
        { stdout: "pipe", stderr: "pipe", cwd: path.dirname(binary) },
      );
      const [stdout] = await Promise.all([
        new Response(proc.stdout).text(),
        proc.exited,
      ]);
      return parseWhisperStdout(stdout);
    } finally {
      await fs.rm(tmpPath, { force: true });
    }
  };
}

/**
 * Parse whisper.cpp stdout. With `-nt` (no timestamps) each transcript
 * line is bare text; without it, lines are `[HH:MM:SS.mmm --> ...]  text`.
 * Handles both so the caller does not depend on the binary's flag set.
 */
export function parseWhisperStdout(stdout: string): string {
  const parts: string[] = [];
  const tsLine = /^\s*\[[\d:.\s]+-->[\d:.\s]+\]\s*(.*)$/;
  for (const raw of stdout.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (!line.trim()) continue;
    const m = line.match(tsLine);
    const text = (m ? m[1] : line).trim();
    // Skip whisper.cpp's banner / progress / system lines.
    if (
      /^whisper_|^system_info|^main:|^output_|^\s*\[/.test(text) ||
      text.startsWith("whisper.cpp")
    ) {
      continue;
    }
    if (text) parts.push(text);
  }
  return parts.join(" ").replace(/\s+/g, " ").trim();
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
   * Whether a bundled ASR model directory is present. The fused path is chosen
   * when this is true and an FFI context exists. If the library advertises
   * streaming ASR, use that; otherwise use the implemented batch ASR fallback.
   * Whisper-interim ignores it — it has its own model.
   */
  asrBundlePresent?: boolean;
  /** VAD event stream to gate decoding (W1). */
  vad?: VadEventSource;
  /** Optional attribution metadata stamped onto emitted transcript updates. */
  metadata?: TranscriptMetadataDefaults;
  /** Convenience shorthand for `metadata.source`. */
  source?: VoiceInputSource;
  /** Whisper.cpp interim options (binary/model overrides, decoder injection for tests). */
  whisper?: WhisperCppOptions;
  /**
   * Force a specific backend. `"fused"` throws if no fused FFI ASR path is
   * available; `"whisper"` skips the fused path entirely; `"auto"` (the
   * default) tries fused streaming → fused batch → whisper → throw.
   */
  prefer?: "auto" | "fused" | "whisper";
}

/**
 * Resolve the ASR adapter chain: fused streaming ASR → fused batch ASR →
 * whisper.cpp interim → `AsrUnavailableError`. No silent fallback to an empty
 * transcript — if nothing is available the caller gets a hard, actionable
 * failure (AGENTS.md §3 + §9).
 */
export function createStreamingTranscriber(
  opts: CreateStreamingTranscriberOptions = {},
): StreamingTranscriber {
  const prefer = opts.prefer ?? "auto";

  const tryFused = (): StreamingTranscriber | null => {
    if (!opts.ffi || !opts.getContext) return null;
    if (!opts.asrBundlePresent) return null;
    const common = {
      ffi: opts.ffi,
      getContext: opts.getContext,
      vad: opts.vad,
      metadata: opts.metadata,
      source: opts.source,
    };
    return ffiSupportsStreamingAsr(opts.ffi)
      ? new FfiStreamingTranscriber(common)
      : new FfiBatchTranscriber(common);
  };

  if (prefer === "fused") {
    const fused = tryFused();
    if (fused) return fused;
    throw new AsrUnavailableError(
      "[asr] fused ASR was requested but is not available (no libelizainference handle, context provider, or bundled ASR model)",
    );
  }

  if (prefer === "auto") {
    const fused = tryFused();
    if (fused) return fused;
  }

  // Whisper interim. Constructing it resolves the binary + model and
  // throws `AsrUnavailableError` if either is missing — surface that.
  return new WhisperCppStreamingTranscriber({
    ...opts.whisper,
    vad: opts.vad,
    metadata: opts.whisper?.metadata ?? opts.metadata,
    source: opts.whisper?.source ?? opts.source,
  });
}
