/**
 * Public types for plugin-omnivoice. Mirrors the C ABI in
 * packages/inference/omnivoice.cpp/src/omnivoice.h with TS-friendly names.
 */

import type { Emotion } from "./emotion";

export type OmnivoiceLang = "" | "en" | "zh" | "English" | "Chinese" | string;

/** Voice-design attribute keywords resolved against the bundled VoiceDesign vocabulary. */
export interface OmnivoiceVoiceDesign {
  gender?: "female" | "male";
  age?: "child" | "teen" | "young" | "adult" | "elderly";
  pitch?: "low" | "moderate" | "high";
  style?: string;
  volume?: "soft" | "moderate" | "loud";
  emotion?: Emotion;
}

export interface OmnivoiceMaskGitConfig {
  numStep?: number;
  guidanceScale?: number;
  tShift?: number;
  layerPenaltyFactor?: number;
  positionTemperature?: number;
  classTemperature?: number;
  seed?: bigint | number;
}

export interface OmnivoiceVoiceReference {
  /** Raw WAV samples at 24 kHz mono. */
  audio24k?: Float32Array;
  /** Transcript of the reference audio. */
  text?: string;
}

export interface OmnivoiceSynthesizeOptions {
  text: string;
  lang?: OmnivoiceLang;
  /** Pre-built instruct string (overrides design when set). */
  instruct?: string;
  /** Structured voice design — combined into instruct when instruct is unset. */
  design?: OmnivoiceVoiceDesign;
  /** Reference audio for voice cloning. Mutually exclusive with design. */
  reference?: OmnivoiceVoiceReference;
  /** Single-shot frame count override. 0 = auto. */
  frameOverride?: number;
  /** Chunk duration in seconds. <= 0 disables chunking. */
  chunkDurationSec?: number;
  /** Chunk threshold — text longer than this gets chunked. */
  chunkThresholdSec?: number;
  denoise?: boolean;
  preprocessPrompt?: boolean;
  maskgit?: OmnivoiceMaskGitConfig;
  /** Use the singing model GGUF instead of the speech model. */
  singing?: boolean;
}

export interface OmnivoiceSynthesisResult {
  /** Mono PCM at sampleRate. */
  samples: Float32Array;
  sampleRate: number;
  channels: number;
}

export interface OmnivoiceContextOptions {
  modelPath: string;
  codecPath: string;
  useFa?: boolean;
  clampFp16?: boolean;
}
