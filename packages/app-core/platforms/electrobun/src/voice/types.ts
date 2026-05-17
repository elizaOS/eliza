import type { JsonValue } from "@elizaos/electrobun-carrots";

export type VoicePipelineId = string;
export type VoiceTurnId = string;

export const VOICE_PIPELINE_STATUSES = [
  "idle",
  "listening",
  "detecting",
  "transcribing",
  "thinking",
  "speaking",
  "interrupted",
  "error",
] as const;

export type VoicePipelineStatus = (typeof VOICE_PIPELINE_STATUSES)[number];

export const VOICE_STAGES = [
  "input",
  "vad",
  "turn",
  "asr",
  "runtime",
  "model",
  "tool",
  "tts",
  "playback",
] as const;

export type VoiceStage = (typeof VOICE_STAGES)[number];

export const VOICE_COMPONENT_STATUSES = [
  "unknown",
  "missing",
  "available",
  "loading",
  "ready",
  "error",
] as const;

export type VoiceComponentStatus =
  (typeof VOICE_COMPONENT_STATUSES)[number];

export type VoiceComponentRole =
  | "vad"
  | "turn-detection"
  | "asr"
  | "tts"
  | "voice"
  | "emotion"
  | "playback"
  | "unknown";

export type VoiceComponentSnapshot = {
  id: string;
  name: string;
  role: VoiceComponentRole;
  provider?: string;
  status: VoiceComponentStatus;
  modelId?: string;
  path?: string;
  error?: string;
  raw?: JsonValue;
};

export type VoiceLatencyMark = {
  stage: VoiceStage;
  name: string;
  timestamp: string;
  offsetMs?: number;
  durationMs?: number;
  metadata?: Record<string, JsonValue>;
};

export const VOICE_TURN_STATUSES = [
  "started",
  "asr_partial",
  "asr_final",
  "runtime_started",
  "model_first_token",
  "tool_started",
  "tool_completed",
  "tts_started",
  "tts_first_audio",
  "playback_started",
  "completed",
  "interrupted",
  "error",
] as const;

export type VoiceTurnStatus = (typeof VOICE_TURN_STATUSES)[number];

export type VoiceTurn = {
  id: VoiceTurnId;
  pipelineId: VoicePipelineId;
  traceSessionId?: string;
  status: VoiceTurnStatus;
  transcriptPartial?: string;
  transcriptFinal?: string;
  responseText?: string;
  error?: string;
  marks: VoiceLatencyMark[];
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  metadata?: Record<string, JsonValue>;
};

export type VoiceLatencySummary = {
  inputToVadMs?: number;
  vadToAsrPartialMs?: number;
  asrFinalToRuntimeMs?: number;
  runtimeToFirstTokenMs?: number;
  firstTokenToTtsFirstAudioMs?: number;
  ttsFirstAudioToPlaybackMs?: number;
  totalToFirstAudioMs?: number;
  totalToPlaybackMs?: number;
  raw?: JsonValue;
};

export type VoicePipelineSnapshot = {
  id: VoicePipelineId;
  status: VoicePipelineStatus;
  activeTurnId?: VoiceTurnId;
  components: VoiceComponentSnapshot[];
  currentTurn?: VoiceTurn;
  recentTurns: VoiceTurn[];
  latencySummary?: VoiceLatencySummary;
  error?: string;
  updatedAt: string;
};

export const VOICE_TEST_MODES = [
  "mock",
  "text-only",
  "local-runtime",
  "live-audio",
] as const;

export type VoiceTestMode = (typeof VOICE_TEST_MODES)[number];

export type VoiceStartParams = {
  mode?: VoiceTestMode;
  trace?: boolean;
  autoOpenTraceView?: boolean;
  metadata?: Record<string, JsonValue>;
};

export type VoiceStopParams = {
  reason?: string;
};

export type VoiceInjectTranscriptParams = {
  text: string;
  final?: boolean;
  trace?: boolean;
};

export type VoiceSpeakParams = {
  text: string;
  voiceId?: string;
  trace?: boolean;
};

export type VoiceInterruptParams = {
  reason?: string;
};
