import type { JsonValue } from "@elizaos/electrobun-carrots";
import type { TraceService } from "../trace/trace-service";
import type { TraceEventKind, TraceSession } from "../trace/types";
import type { VoiceLatencyMark, VoiceTurn } from "./types";

export type VoiceTraceStage =
  | "vad"
  | "turn-started"
  | "asr-partial"
  | "asr-final"
  | "runtime-started"
  | "model-first-token"
  | "tts-started"
  | "tts-first-audio"
  | "playback-started"
  | "pipeline-error";

const TRACE_KIND_BY_STAGE: Readonly<Record<VoiceTraceStage, TraceEventKind>> = {
  vad: "voice.vad",
  "turn-started": "voice.turn.started",
  "asr-partial": "voice.asr.partial",
  "asr-final": "voice.asr.final",
  "runtime-started": "model.request.started",
  "model-first-token": "model.first_token",
  "tts-started": "voice.tts.started",
  "tts-first-audio": "voice.tts.first_audio",
  "playback-started": "voice.playback.started",
  "pipeline-error": "voice.pipeline.error",
};

export function voiceTraceAutoOpen(
  env: Record<string, string | undefined>,
): boolean {
  const normalized = env.ELIZA_VOICE_TRACE_AUTO_OPEN?.trim().toLowerCase();
  return (
    normalized === "1" ||
    normalized === "true" ||
    normalized === "yes" ||
    normalized === "on"
  );
}

export async function startVoiceTraceSession(params: {
  traceService: TraceService;
  title: string;
  turnId: string;
  pipelineId: string;
  openView: boolean;
  metadata?: Record<string, JsonValue>;
}): Promise<TraceSession> {
  return params.traceService.startSession({
    title: params.title,
    source: "voice",
    runId: params.turnId,
    metadata: {
      pipelineId: params.pipelineId,
      turnId: params.turnId,
      ...(params.metadata ?? {}),
    },
    openView: params.openView,
  });
}

export async function recordVoiceTraceStage(params: {
  traceService: TraceService | null;
  turn: VoiceTurn;
  stage: VoiceTraceStage;
  title: string;
  text?: string;
  mark?: VoiceLatencyMark;
  payload?: JsonValue;
}): Promise<void> {
  if (!params.traceService || !params.turn.traceSessionId) return;
  await params.traceService.recordEvent({
    sessionId: params.turn.traceSessionId,
    kind: TRACE_KIND_BY_STAGE[params.stage],
    title: params.title,
    text: params.text,
    source: "voice",
    runId: params.turn.id,
    payload: params.payload,
    timing: params.mark
      ? {
          startedAt: params.mark.timestamp,
          durationMs: params.mark.durationMs ?? params.mark.offsetMs,
        }
      : undefined,
  });
}
