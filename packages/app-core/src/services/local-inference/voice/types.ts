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
