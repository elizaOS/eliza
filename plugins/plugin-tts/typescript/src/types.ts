/**
 * TTS system types
 */

export type TtsProvider =
  | "elevenlabs"
  | "openai"
  | "edge"
  | "simple-voice"
  | "auto";
export type TtsAutoMode = "off" | "always" | "inbound" | "tagged";
export type TtsApplyKind = "tool" | "block" | "final";

export interface TtsConfig {
  provider: TtsProvider;
  auto: TtsAutoMode;
  maxLength: number;
  summarize: boolean;
  voice?: string;
  model?: string;
  speed?: number;
}

export interface TtsDirective {
  provider?: TtsProvider;
  voice?: string;
  model?: string;
  speed?: number;
  text?: string; // [[tts:text]]...[[/tts:text]] extracted content
}

export interface TtsRequest {
  text: string;
  provider?: TtsProvider;
  voice?: string;
  model?: string;
  speed?: number;
  format?: "mp3" | "opus" | "wav";
}

export interface TtsResult {
  audio: Buffer;
  format: string;
  duration?: number;
  provider: TtsProvider;
}

export interface TtsSessionConfig {
  auto?: TtsAutoMode;
  provider?: TtsProvider;
  voice?: string;
  maxLength?: number;
  summarize?: boolean;
}

export const DEFAULT_TTS_CONFIG: TtsConfig = {
  provider: "auto",
  auto: "off",
  maxLength: 1500,
  summarize: true,
};

// Provider priority for auto-selection
export const TTS_PROVIDER_PRIORITY: TtsProvider[] = [
  "elevenlabs",
  "openai",
  "edge",
  "simple-voice",
];

// API key environment variable names for each provider
export const TTS_PROVIDER_API_KEYS: Record<TtsProvider, string[]> = {
  elevenlabs: ["ELEVENLABS_API_KEY", "XI_API_KEY"],
  openai: ["OPENAI_API_KEY"],
  edge: [], // No API key required
  "simple-voice": [], // No API key required
  auto: [], // Not applicable
};
