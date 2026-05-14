/**
 * Public types for the Kokoro-82M TTS backend (Apache-2.0, hexgrad/Kokoro-82M
 * upstream; ONNX export at onnx-community/Kokoro-82M-v1.0-ONNX).
 *
 * Kokoro is a small (~82M-param) StyleTTS-2 derivative that ships with a set
 * of "voice packs" — pre-baked 256-dim style vectors (one .bin per voice).
 * The runtime keeps the ONNX session warm and swaps the style tensor per
 * synthesis call, so adding voices is a cheap (~512KB) extra download.
 */

/** Canonical voice-pack id. Convention: `<lang>_<name>` (af_bella, am_michael). */
export type KokoroVoiceId = string;

/** One bundled voice pack — small fp32 style tensor on disk. */
export interface KokoroVoicePack {
  /** `af_bella`, `af_sarah`, `am_michael`, ... */
  id: KokoroVoiceId;
  /** Human-readable name shown in UI. */
  displayName: string;
  /** Two-letter language tag (`a` = American English, `b` = British English, etc. per Kokoro convention). */
  lang: string;
  /** Filename inside the voices/ directory, relative to the Kokoro model root. */
  file: string;
  /** Style-vector dim (256 for v1.0). */
  dim: number;
  /** Genre/voice tags for picker UIs. */
  tags?: ReadonlyArray<string>;
}

/** Where the runtime expects to find Kokoro on disk. */
export interface KokoroModelLayout {
  /** Directory under `~/.eliza/local-inference/models/kokoro/`. */
  root: string;
  /** ONNX file — usually `kokoro-v1.0.onnx` (or quantised variant). */
  modelFile: string;
  /** Directory containing the per-voice style tensors. */
  voicesDir: string;
  /** Model output sample rate (Kokoro v1.0 = 24000). */
  sampleRate: number;
}

/** Construction-time configuration for `KokoroTtsBackend`. */
export interface KokoroBackendOptions {
  /** Resolved on-disk layout. Required — the backend never guesses paths. */
  layout: KokoroModelLayout;
  /**
   * Voice id to use when the caller's `SpeakerPreset.voiceId` is not in the
   * voice-pack registry. The named voice MUST be present in `layout.voicesDir`.
   */
  defaultVoiceId: KokoroVoiceId;
  /**
   * Optional phonemizer override. Defaults to the bundled lazy phonemizer,
   * which uses `phonemize` if installed and falls back to a deterministic
   * grapheme-to-phoneme adapter otherwise (documented tradeoff in README).
   */
  phonemizer?: KokoroPhonemizer;
  /**
   * Max samples emitted in a single streaming chunk. Defaults to a quarter-
   * second at 24kHz (6000) so the scheduler ring buffer sees a continuous
   * trickle and TTFB stays close to the first inference completion.
   */
  streamingChunkSamples?: number;
}

/** A pure (or async-pure) text → phoneme-id sequence converter. */
export interface KokoroPhonemizer {
  /** Phonemize a single utterance into a sequence of integer ids. */
  phonemize(text: string, lang: string): Promise<KokoroPhonemeSequence>;
  /** Human-facing id (`"phonemize"`, `"espeak-ng"`, `"fallback-g2p"`, ...). */
  readonly id: string;
}

export interface KokoroPhonemeSequence {
  /** Token ids fed into the ONNX `input_ids` tensor. */
  ids: Int32Array;
  /** Original phoneme string, for debugging and tests. */
  phonemes: string;
}

/** Raised when the on-disk model layout is missing or malformed. */
export class KokoroModelMissingError extends Error {
  readonly code = "kokoro-model-missing" as const;
  constructor(message: string) {
    super(message);
    this.name = "KokoroModelMissingError";
  }
}

/** Raised when phonemization cannot proceed (no phonemizer + non-ASCII text). */
export class KokoroPhonemizerError extends Error {
  readonly code = "kokoro-phonemizer-error" as const;
  constructor(message: string) {
    super(message);
    this.name = "KokoroPhonemizerError";
  }
}
