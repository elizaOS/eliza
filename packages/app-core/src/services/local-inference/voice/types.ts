export interface TextToken {
  index: number;
  text: string;
  /**
   * Text-model vocabulary token id, when the producer knows it. ASR
   * (fused Qwen3-ASR) and the text backbone share the Qwen2 BPE 151 936
   * vocab + merges (AGENTS.md §1), so an ASR-emitted token id is the same
   * id the text model would assign — a downstream in-process handoff can
   * inject `id` directly into the text KV cache without detokenize →
   * retokenize. Absent for producers that only have surface text (the
   * whisper.cpp interim adapter — a different tokenizer; the word-chunk
   * approximation in `splitTranscriptToTokens`).
   */
  id?: number;
}

export interface AcceptedToken extends TextToken {
  acceptedAt: number;
}

export interface RejectedTokenRange {
  fromIndex: number;
  toIndex: number;
}

export interface Phrase {
  id: number;
  text: string;
  fromIndex: number;
  toIndex: number;
  terminator: "punctuation" | "max-cap" | "phoneme-stream";
}

export interface AudioChunk {
  phraseId: number;
  fromIndex: number;
  toIndex: number;
  pcm: Float32Array;
  sampleRate: number;
}

export interface SpeakerPreset {
  voiceId: string;
  embedding: Float32Array;
  bytes: Uint8Array;
}

export interface AudioSink {
  write(pcm: Float32Array, sampleRate: number): void;
  drain(): void;
  bufferedSamples(): number;
}

export interface OmniVoiceBackend {
  synthesize(args: {
    phrase: Phrase;
    preset: SpeakerPreset;
    cancelSignal: { cancelled: boolean };
    onKernelTick?: () => void;
  }): Promise<AudioChunk>;
}

/**
 * One PCM segment delivered by a streaming OmniVoice runtime. This is the
 * scheduler-facing TypeScript contract for the future native streaming ABI:
 * the current v1/batch ABI remains valid, and backends that implement this
 * seam can additionally surface first-audio before a full phrase finishes.
 */
export interface TtsPcmChunk {
  pcm: Float32Array;
  sampleRate: number;
  isFinal: boolean;
}

export interface StreamingTtsBackend {
  synthesizeStream(args: {
    phrase: Phrase;
    preset: SpeakerPreset;
    cancelSignal: { cancelled: boolean };
    onChunk: (chunk: TtsPcmChunk) => boolean | undefined;
    onKernelTick?: () => void;
  }): Promise<{ cancelled: boolean }>;
}

/** Opaque native handle for a streaming ASR session in the v2 ABI shape. */
export type StreamingAsrHandle = bigint;

/**
 * TS-only v2 streaming ABI contract. Implementations can satisfy this beside
 * the existing synchronous v1 methods; callers should test the support flags
 * rather than probe-and-catch. Native bindings may carry context handles on
 * top of this shape; the scheduler-facing stream semantics stay the same.
 */
export interface VoiceStreamingAbiV2 {
  ttsStreamSupported(): boolean;
  ttsSynthesizeStream(args: {
    text: string;
    speakerPresetId: string | null;
    onChunk: (chunk: {
      pcm: Float32Array;
      isFinal: boolean;
    }) => boolean | undefined;
  }): { cancelled: boolean };
  cancelTts(): void;
  asrStreamSupported(): boolean;
  asrStreamOpen(args: { sampleRateHz: number }): StreamingAsrHandle;
  asrStreamFeed(args: { stream: StreamingAsrHandle; pcm: Float32Array }): void;
  asrStreamPartial(args: {
    stream: StreamingAsrHandle;
    maxTextBytes?: number;
    maxTokens?: number;
  }): { partial: string; tokens?: number[] };
  asrStreamFinish(args: {
    stream: StreamingAsrHandle;
    maxTextBytes?: number;
    maxTokens?: number;
  }): { partial: string; tokens?: number[] };
  asrStreamClose(stream: StreamingAsrHandle): void;
}

export interface TranscriptionAudio {
  pcm: Float32Array;
  sampleRate: number;
}

export type VoiceInputKind =
  | "local_mic"
  | "discord"
  | "telegram"
  | "signal"
  | "whatsapp"
  | "phone"
  | "browser"
  | "file"
  | "unknown";

/**
 * Where speech audio entered the voice loop. Keep this structural so local
 * mic, Discord, phone, and future connector captures can share the same
 * turn-taking and attribution path without branching on prompt text.
 */
export interface VoiceInputSource {
  kind: VoiceInputKind;
  /** Connector account, device, guild/channel, call, or upload id. */
  sourceId?: string;
  roomId?: string;
  conversationId?: string;
  messageId?: string;
  deviceId?: string;
  connectorAccountId?: string;
  channelId?: string;
  guildId?: string;
  callId?: string;
  participantId?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Speaker attribution for diarized speech. `imprintClusterId` is evidence,
 * not identity: callers that want to attach this to a LifeOps person must
 * submit a normal `EntityStore.observeIdentity` observation with this
 * cluster/observation id in its evidence list. Do not use voice imprints as
 * a parallel identity graph or as authorization for voice synthesis.
 */
export interface VoiceSpeaker {
  id: string;
  label?: string;
  displayName?: string;
  source?: VoiceInputSource;
  imprintClusterId?: string;
  imprintObservationId?: string;
  entityId?: string;
  confidence?: number;
  isLocalUser?: boolean;
  metadata?: Record<string, unknown>;
}

/** One diarized span within a transcript snapshot or finalized voice turn. */
export interface VoiceSegment {
  id?: string;
  text: string;
  startMs: number;
  endMs: number;
  speaker?: VoiceSpeaker;
  speakerId?: string;
  source?: VoiceInputSource;
  confidence?: number;
  tokens?: number[];
  metadata?: Record<string, unknown>;
}

export interface VoiceDiarizationMetadata {
  provider: "local" | "connector" | "cloud" | "unknown";
  model?: string;
  version?: string;
  confidence?: number;
  metadata?: Record<string, unknown>;
}

export interface VoiceTurnMetadata {
  turnId?: string;
  source?: VoiceInputSource;
  primarySpeaker?: VoiceSpeaker;
  segments?: VoiceSegment[];
  startedAtMs?: number;
  endedAtMs?: number;
  diarization?: VoiceDiarizationMetadata;
  metadata?: Record<string, unknown>;
}

/* -------------------------------------------------------------------- *
 * Streaming ASR — frame-fed transcription with incremental partials.
 *
 * Owned jointly by the transcriber adapters (`voice/transcriber.ts`), the
 * VAD gating + barge-in word-confirm (`voice/vad.ts`, `voice/barge-in.ts`),
 * the turn controller / speculative-on-pause path, and the overlapped
 * `VoicePipeline` (`voice/pipeline.ts`). The `StreamingTranscriber` below
 * is the single ASR contract; the two adapters (fused Qwen3-ASR via
 * libelizainference, interim whisper.cpp) implement it in
 * `voice/transcriber.ts`. It consumes the canonical `PcmFrame` (defined
 * below in the audio front-end section) off a `MicSource` and is gated by
 * the `VadEvent` stream. The `VoicePipeline` drives the same contract as a
 * batch (feed the whole utterance buffer, `flush()`, split the final
 * transcript into contiguous text tokens) — there is no separate batch ASR
 * interface.
 * -------------------------------------------------------------------- */

/** A running or final transcript snapshot from a `StreamingTranscriber`. */
export interface TranscriptUpdate {
  /** The full running transcript (not a delta) at this point. */
  partial: string;
  /** True for the snapshot emitted by `flush()` / on `speech-end`. */
  isFinal: boolean;
  /** Channel/device/call metadata for attribution and storage. */
  source?: VoiceInputSource;
  /** Best speaker attribution for single-speaker snapshots. */
  speaker?: VoiceSpeaker;
  /** Diarized spans for multi-speaker snapshots, when available. */
  segments?: VoiceSegment[];
  /** Turn-level metadata carried through to generation and storage. */
  turn?: VoiceTurnMetadata;
  /**
   * Text-model token ids for `partial`, when the backend can supply them
   * cheaply (fused Qwen3-ASR shares the text vocabulary). Absent for the
   * whisper.cpp interim adapter (different tokenizer — re-tokenization is
   * the LLM stage's job there).
   */
  tokens?: number[];
}

/** Events a `StreamingTranscriber` emits while consuming PCM frames. */
export type TranscriberEvent =
  | { kind: "partial"; update: TranscriptUpdate }
  | { kind: "final"; update: TranscriptUpdate }
  /**
   * Fired the first instant ≥1 real word is recognized in the current
   * speech segment. Wired to W1's barge-in word-confirm gate
   * (`onWordsDetected`) so the agent hard-stops TTS + aborts in-flight
   * LLM/drafter generation only on real speech, not a blip.
   */
  | { kind: "words"; words: string[] };

export type TranscriberEventListener = (event: TranscriberEvent) => void;

/**
 * Live transcription. `feed()` is called per PCM frame off a `MicSource`.
 * The adapter runs windowed decode passes internally and emits `partial`
 * events as the running transcript grows; `flush()` force-finalizes (call
 * it when the VAD reports `speech-end`). Implementations gate on the VAD
 * event stream — they only decode while the VAD is in `speech-active`.
 *
 * No silent degrade: a transcriber whose backend is unavailable throws on
 * construction (or on first `feed`), it does not quietly produce empty
 * transcripts.
 */
export interface StreamingTranscriber {
  /** Feed one PCM frame. Frames received while VAD is not active are buffered/ignored per the VAD-gating policy. */
  feed(frame: PcmFrame): void;
  /**
   * Force-finalize: drain any buffered audio, run a final decode pass,
   * emit the `final` event, and resolve with the final transcript. Safe
   * to call when no audio is buffered (resolves with an empty final).
   * After `flush()` the transcriber is reset and ready for the next
   * speech segment.
   */
  flush(): Promise<TranscriptUpdate>;
  /** Subscribe to transcriber events. Returns an unsubscribe fn. */
  on(listener: TranscriberEventListener): () => void;
  /** Release any held native resources (FFI stream handle, temp files). Idempotent. */
  dispose(): void;
}

export interface PhraseChunkerConfig {
  /**
   * Hard word cap before a phrase is force-flushed even without a
   * `, . ! ? ; :` boundary. Defaults to 30 (the brief's A6 "first 30 words").
   */
  maxTokensPerPhrase?: number;
  /**
   * Characters that close a phrase. Default `, . ! ? ; :` — punctuation
   * boundaries let the first clause reach TTS without waiting for a
   * sentence-final mark.
   */
  sentenceTerminators?: ReadonlySet<string>;
  /**
   * Where the chunker emits a phrase boundary.
   *   'punctuation'    — default. Wait for `, . ! ? ; :` or the max-token cap.
   *   'phoneme-stream' — additionally emit a sub-phrase chunk every
   *                      `phonemesPerChunk` phonemes. Cuts first-audio
   *                      latency by handing partial phrases to TTS at
   *                      phoneme boundaries.
   */
  chunkOn?: "punctuation" | "phoneme-stream";
  /** Phonemes per chunk in `phoneme-stream` mode. Default 8. */
  phonemesPerChunk?: number;
}

export interface VerifierStreamEvent {
  kind: "accept" | "reject";
  tokens: TextToken[];
  /**
   * Optional per-event metadata. Today only the very first `accept` of a
   * streaming completion carries `firstTokenMs` (L5 — time from the fetch
   * being issued to the first SSE chunk arriving). Other consumers MAY
   * ignore this field; producers MUST omit it on non-first events.
   */
  meta?: {
    /** Milliseconds from request issue (`performance.now()`) to first chunk. */
    firstTokenMs?: number;
  };
}

// ---------------------------------------------------------------------------
// Audio front-end contract (mic capture · VAD · barge-in).
//
// Shared by W1 (this module), W2 (`StreamingTranscriber`), and W9 (the voice
// turn controller / scheduler). Two-tier design:
//
//   1. The cheap always-on RMS energy gate is the *fast* path. It only
//      decides "is there acoustic activity right now". A rising edge wakes
//      the response pipeline (KV-prefill, drafter preload, first-filler
//      pre-generation) speculatively.
//   2. The Silero int8 ONNX VAD is the *authoritative* speech/no-speech
//      signal. It gates ASR (skip silent frames) and drives turn-taking.
//
// Both run on every mic frame. The RMS gate never substitutes for Silero —
// if the ONNX runtime is unavailable that is a hard "VAD unavailable" error,
// never a silent downgrade (AGENTS.md §3).
// ---------------------------------------------------------------------------

/** A fixed-size block of mono PCM samples in [-1, 1] at a known sample rate. */
export interface PcmFrame {
  pcm: Float32Array;
  sampleRate: number;
  /**
   * Monotonic timestamp (ms, `performance.now()` domain) of the *first*
   * sample in this frame. Used to age VAD events and barge-in latency.
   */
  timestampMs: number;
}

/**
 * Event emitted by `VadDetector` on the authoritative (Silero) timeline.
 *
 *   - `speech-start`  — speech onset (a run of speech frames crossed the
 *                       onset threshold). Carries the probability of the
 *                       triggering frame.
 *   - `speech-active` — a periodic heartbeat while speech is ongoing. The
 *                       barge-in controller uses this to pause TTS.
 *   - `speech-pause`  — speech has been quiet for `pauseStartedMs..now`
 *                       but not long enough to count as end-of-utterance.
 *                       The turn controller uses this to kick a speculative
 *                       response off the partial transcript.
 *   - `speech-end`    — end of utterance (silence held past the hangover
 *                       window). Carries the total speech duration.
 *   - `blip`          — a short burst of energy that the Silero VAD rejected
 *                       (or that was too short to be speech). The barge-in
 *                       controller treats this as "resume TTS".
 */
export type VadEvent =
  | { type: "speech-start"; timestampMs: number; probability: number }
  | {
      type: "speech-active";
      timestampMs: number;
      probability: number;
      speechDurationMs: number;
    }
  | { type: "speech-pause"; timestampMs: number; pauseDurationMs: number }
  | { type: "speech-end"; timestampMs: number; speechDurationMs: number }
  | { type: "blip"; timestampMs: number; durationMs: number; peakRms: number };

/** Cheap RMS energy gate event — the fast pre-warm path. Distinct timeline
 *  from `VadEvent`; this fires with sub-frame latency and never blocks on a
 *  model forward pass. */
export type EnergyGateEvent =
  | { type: "energy-rise"; timestampMs: number; rms: number }
  | { type: "energy-fall"; timestampMs: number; quietMs: number };

export type VadEventListener = (event: VadEvent) => void;
export type EnergyGateListener = (event: EnergyGateEvent) => void;

/**
 * Subscribable VAD event stream. `VadDetector` (`voice/vad.ts`) is the
 * concrete implementation; the streaming transcriber and the barge-in
 * controller take this structural view so they don't pull in the optional
 * `onnxruntime-node` surface.
 */
export interface VadEventSource {
  onVadEvent(listener: VadEventListener): () => void;
}

/**
 * Source of mic PCM. The desktop/Electrobun impl in `mic-source.ts` is the
 * first concrete implementation; Discord / Telegram / mobile connectors
 * implement the same interface so the rest of the voice loop is source-
 * agnostic. A `MicSource` produces fixed-size mono frames at a fixed sample
 * rate and tees them to any number of consumers (the VAD, the ring buffer
 * the ASR reads from, instrumentation taps).
 */
export interface MicSource {
  /** Nominal sample rate of every emitted frame (Hz). */
  readonly sampleRate: number;
  /** Samples per emitted frame. */
  readonly frameSamples: number;
  /** True once `start()` has resolved and frames are flowing. */
  readonly running: boolean;
  /** Begin capture. Resolves when the underlying device is producing audio.
   *  Throws (never silently no-ops) when no mic backend is available. */
  start(): Promise<void>;
  /** Stop capture and release the device. Idempotent. */
  stop(): Promise<void>;
  /** Subscribe to PCM frames. Returns an unsubscribe function. */
  onFrame(listener: (frame: PcmFrame) => void): () => void;
  /** Subscribe to fatal capture errors (device lost, process died). The
   *  source is no longer `running` after one of these. */
  onError(listener: (error: Error) => void): () => void;
}

/**
 * Cancellation token threaded from the barge-in controller down through the
 * voice scheduler (TTS) *and* the engine layer (in-flight LLM / DFlash
 * drafter generation). `cancelled` is a plain boolean so the synthesis loop
 * and the SSE-consuming generate loop can both poll it cheaply at a kernel
 * boundary; `reason` records *why* for diagnostics; `signal` is the standard
 * `AbortSignal` the engine's HTTP/stream layer aborts on.
 *
 * (W1 owns the controller; W9 threads `signal` into `dispatcher.generate`.)
 */
export interface BargeInCancelToken {
  cancelled: boolean;
  reason: "barge-in-words" | "manual" | null;
  readonly signal: AbortSignal;
}

/** Signal emitted by `BargeInController` to the scheduler / engine. */
export type BargeInSignal =
  | { type: "pause-tts"; timestampMs: number }
  | { type: "resume-tts"; timestampMs: number }
  | { type: "hard-stop"; timestampMs: number; token: BargeInCancelToken };

export type BargeInSignalListener = (signal: BargeInSignal) => void;

/**
 * Contract the ASR layer (W2's `StreamingTranscriber`) calls into the
 * barge-in controller with. When the transcriber has parsed at least one
 * real word from the user's barge-in audio, it calls `onWordsDetected` with
 * the running word count; the controller promotes a `pause-tts` into a
 * `hard-stop`. This is the *authoritative* blip-vs-words gate — the energy-
 * duration heuristic is only a fast provisional guess until ASR confirms.
 */
export interface WordsDetectedSink {
  onWordsDetected(args: {
    /** Number of parsed words observed so far in this barge-in segment. */
    wordCount: number;
    /** Best partial transcript so far (may be empty). */
    partialText: string;
    timestampMs: number;
  }): void;
}

export interface SchedulerConfig {
  chunkerConfig: PhraseChunkerConfig;
  preset: SpeakerPreset;
  ringBufferCapacity: number;
  sampleRate: number;
  /**
   * Max concurrent TTS dispatches. When this many phrases are in flight,
   * `accept()` awaits the oldest before dispatching the next, propagating
   * backpressure upstream to the verifier loop. Default 4 — small enough
   * to bound memory under runaway producers without serialising the
   * common case (text gen leads TTS by a phrase or two).
   */
  maxInFlightPhrases?: number;
}

export interface VoiceSchedulerPhraseTelemetry {
  id: number;
  text: string;
  fromIndex: number;
  toIndex: number;
  terminator: Phrase["terminator"];
  tokenCount: number;
  textBytes: number;
}

export type VoiceAudioSource = "cache" | "synthesis";

export type VoiceTtsCancelReason =
  | "barge-in"
  | "rollback"
  | "pending-tts"
  | "synthesis-cancelled";

export type VoiceSchedulerTelemetryEvent =
  | {
      type: "phrase-dispatch";
      atMs: number;
      phrase: VoiceSchedulerPhraseTelemetry;
      inFlightPhrases: number;
    }
  | {
      type: "phrase-cache-hit" | "phrase-cache-miss";
      atMs: number;
      phrase: VoiceSchedulerPhraseTelemetry;
    }
  | {
      type: "tts-start";
      atMs: number;
      phrase: VoiceSchedulerPhraseTelemetry;
      inFlightPhrases: number;
    }
  | {
      type: "tts-first-audio";
      atMs: number;
      phrase: VoiceSchedulerPhraseTelemetry;
      source: VoiceAudioSource;
      samples: number;
      sampleRate: number;
    }
  | {
      type: "audio-committed";
      atMs: number;
      phrase: VoiceSchedulerPhraseTelemetry;
      source: VoiceAudioSource;
      samples: number;
      sampleRate: number;
      flushedSamples: number;
      paused: boolean;
      ringBufferSamples: number;
      sinkBufferedSamples: number;
    }
  | {
      type: "tts-cancel";
      atMs: number;
      phrase: VoiceSchedulerPhraseTelemetry;
      reason: VoiceTtsCancelReason;
    }
  | {
      type: "rollback";
      atMs: number;
      phraseId: number;
      range: RejectedTokenRange;
      reason: "rejected-tokens";
    }
  | {
      type: "barge-in";
      atMs: number;
      ringBufferSamplesDrained: number;
      sinkBufferedSamplesDrained: number;
      inFlightPhrasesCancelled: number;
      wasPaused: boolean;
    };

export type VoiceSchedulerTelemetryListener = (
  event: VoiceSchedulerTelemetryEvent,
) => void;
