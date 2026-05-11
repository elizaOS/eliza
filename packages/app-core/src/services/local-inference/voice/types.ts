export interface TextToken {
  index: number;
  text: string;
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

export interface TranscriptionAudio {
  pcm: Float32Array;
  sampleRate: number;
}

export interface OmniVoiceTranscriber {
  transcribe(args: TranscriptionAudio): Promise<string>;
}

/* -------------------------------------------------------------------- *
 * Streaming ASR — frame-fed transcription with incremental partials.
 *
 * Owned jointly by W2 (transcriber adapters), W1 (VAD gating + barge-in
 * word-confirm), and W9 (turn controller / speculative-on-pause). The
 * `StreamingTranscriber` below is the meeting-point contract; the two
 * adapters (fused Qwen3-ASR via libelizainference, interim whisper.cpp)
 * implement it in `voice/transcriber.ts`.
 *
 * NOTE on the older `pipeline.ts::AsrTokenStreamer` (was `StreamingTranscriber`):
 * that one models a *batch-buffer → token iterator* (W9's pipeline scaffold).
 * This one models a *live PCM-frame feed → partial-transcript events*. They
 * are different layers; W9 reconciles which the turn controller consumes.
 * -------------------------------------------------------------------- */

/** A single mono fp32 PCM frame as produced by a `MicSource`. */
export interface PcmFrame {
  pcm: Float32Array;
  sampleRate: number;
}

/** A running or final transcript snapshot from a `StreamingTranscriber`. */
export interface TranscriptUpdate {
  /** The full running transcript (not a delta) at this point. */
  partial: string;
  /** True for the snapshot emitted by `flush()` / on `speech-end`. */
  isFinal: boolean;
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

/* -------------------------------------------------------------------- *
 * VAD / mic contract — placeholders until W1 lands the real definitions
 * (W1 owns `voice/vad.ts` + `voice/mic-source.ts` and the canonical
 * `VadEvent` / `MicSource` types). The transcriber consumes `VadEvent`
 * to gate decode passes; W1 should replace these with the real shapes
 * (the field names here are the agreed minimum). Marked deliberately
 * narrow so a reconcile is mechanical.
 * -------------------------------------------------------------------- */

/** Speech-activity events from the VAD. Minimum shape — W1 may extend. */
export type VadEvent =
  | { kind: "speech-start"; at: number }
  | { kind: "speech-active"; at: number }
  | { kind: "speech-pause"; at: number; pauseMs: number }
  | { kind: "speech-end"; at: number }
  | { kind: "blip"; at: number };

/** Subscribable VAD event stream. W1 owns the concrete implementation. */
export interface VadEventSource {
  on(listener: (event: VadEvent) => void): () => void;
}

/**
 * Barge-in word-confirm gate. W1's barge-in classifier calls
 * `onWordsDetected` from the transcriber's `words` event so the hard-stop
 * (cancel TTS + abort LLM/drafter) only fires on real speech.
 */
export interface WordConfirmGate {
  onWordsDetected(words: string[]): void;
}

export interface PhraseChunkerConfig {
  maxTokensPerPhrase: number;
  sentenceTerminators?: ReadonlySet<string>;
  /**
   * Where the chunker emits a phrase boundary.
   *   'punctuation'    — default. Wait for sentence-final punctuation or
   *                      the max-token cap.
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
