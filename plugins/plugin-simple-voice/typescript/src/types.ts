import type { Service } from "@elizaos/core";

export interface SamTTSOptions {
  speed: number;
  pitch: number;
  throat: number;
  mouth: number;
}

export const DEFAULT_SAM_OPTIONS: SamTTSOptions = {
  speed: 72,
  pitch: 64,
  throat: 128,
  mouth: 128,
};

export const SAMServiceType = {
  SAM_TTS: "SAM_TTS" as const,
};

export interface HardwareBridgeService extends Service {
  sendAudioData(audioBuffer: Uint8Array): Promise<void>;
}

export const SPEECH_TRIGGERS = [
  "say aloud",
  "speak",
  "read aloud",
  "say out loud",
  "voice",
  "speak this",
  "say this",
  "read this",
  "announce",
  "proclaim",
  "tell everyone",
  "speak up",
  "use your voice",
  "talk to me",
  "higher voice",
  "lower voice",
  "change voice",
  "robotic voice",
  "retro voice",
] as const;

export const VOCALIZATION_PATTERNS = [
  "can you say",
  "please say",
  "i want to hear",
  "let me hear",
] as const;
