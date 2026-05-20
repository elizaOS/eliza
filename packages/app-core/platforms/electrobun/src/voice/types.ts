import type { JsonValue } from "@elizaos/plugin-remote-manifest";
import type {
  VoiceLatencyBudget,
  VoiceLatencyBudgetResult,
} from "./voice-latency-budget";

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

export type VoiceComponentStatus = (typeof VOICE_COMPONENT_STATUSES)[number];

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
  asrPartialToRuntimePrepareMs?: number;
  asrFinalToRuntimeMs?: number;
  asrFinalToRuntimeCommitMs?: number;
  runtimeToFirstTokenMs?: number;
  firstTokenToTtsRequestMs?: number;
  ttsRequestToFirstAudioMs?: number;
  firstTokenToTtsFirstAudioMs?: number;
  ttsFirstAudioToPlaybackMs?: number;
  totalToFirstTokenMs?: number;
  totalToFirstAudioMs?: number;
  totalToPlaybackMs?: number;
  budgetResults?: VoiceLatencyBudgetResult[];
  raw?: JsonValue;
};

export type VoicePartialRuntimeStreamingMode =
  | "disabled"
  | "prepare-only"
  | "draft-api"
  | "unsupported";

export type VoicePipelineSnapshot = {
  id: VoicePipelineId;
  status: VoicePipelineStatus;
  activeTurnId?: VoiceTurnId;
  components: VoiceComponentSnapshot[];
  currentTurn?: VoiceTurn;
  recentTurns: VoiceTurn[];
  latencySummary?: VoiceLatencySummary;
  latencyBudget?: VoiceLatencyBudget;
  latencyBudgetResults?: VoiceLatencyBudgetResult[];
  partialRuntimeStreamingSupported: boolean;
  partialRuntimeStreamingEnabled: boolean;
  partialRuntimeStreamingMode: VoicePartialRuntimeStreamingMode;
  ttsStreamingSupported: boolean;
  playbackAckSupported: boolean;
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
  asrProvider?: string;
  ttsProvider?: string;
  vadProvider?: string;
  voiceId?: string;
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

export type VoiceRuntimeStatus = {
  mode: VoiceTestMode;
  listening: boolean;
  asrPartialSupport: boolean;
  ttsStreamingSupport: boolean;
  playbackSupport: boolean;
  playbackAckSupport: boolean;
  runtimeDraftSupport?: boolean;
  vadSupport: boolean;
  turnSupport: boolean;
  error?: string;
  raw?: JsonValue;
};

export type VoiceLiveStartParams = VoiceStartParams & {
  mode: "local-runtime" | "live-audio";
};

export type VoiceVadEvent = {
  active: boolean;
  score?: number;
  timestamp?: string;
  metadata?: Record<string, JsonValue>;
};

export type VoiceTurnEvent = {
  status: "started" | "ended" | "cancelled" | "error";
  timestamp?: string;
  reason?: string;
  metadata?: Record<string, JsonValue>;
};

export type VoiceAsrPartialEvent = {
  text: string;
  timestamp?: string;
  synthetic?: boolean;
  metadata?: Record<string, JsonValue>;
};

export type VoiceAsrFinalEvent = {
  text: string;
  timestamp?: string;
  metadata?: Record<string, JsonValue>;
};

export type VoiceTtsChunkEvent = {
  audioBase64: string;
  mimeType: string;
  byteLength: number;
  timestamp?: string;
  metadata?: Record<string, JsonValue>;
};

export type VoicePlaybackEvent = {
  started: boolean;
  timestamp?: string;
  metadata?: Record<string, JsonValue>;
};

export type VoiceRuntimeErrorEvent = {
  code?: string;
  message: string;
  timestamp?: string;
  metadata?: Record<string, JsonValue>;
};

export type VoiceTranscribeAudioParams = {
  audioBase64: string;
  mimeType?: string;
  trace?: boolean;
  metadata?: Record<string, JsonValue>;
};

export type VoiceSynthesizeSpeechParams = {
  text: string;
  voiceId?: string;
  trace?: boolean;
  metadata?: Record<string, JsonValue>;
};

export type VoiceSynthesisResult = {
  audioBase64: string;
  mimeType: string;
  byteLength: number;
  provider?: string;
  voiceId?: string;
  raw?: JsonValue;
};

export type VoicePlayAudioParams = {
  audioBase64: string;
  mimeType: string;
  trace?: boolean;
  metadata?: Record<string, JsonValue>;
};

export type VoiceRuntimeHandoffParams = {
  text: string;
  trace?: boolean;
  metadata?: Record<string, JsonValue>;
};

export type VoiceRuntimeHandoffResult = {
  firstTokenText?: string;
  responseText?: string;
  conversationId?: string;
  messageId?: string;
  streamId?: string;
  raw?: JsonValue;
};
