/**
 * Shared response-header helpers for cloud voice tracing.
 *
 * The PWA shared-runtime voice path sends a per-turn trace id to the v1 voice
 * routes. These helpers keep trace echo and Server-Timing formatting identical
 * across STT and TTS without coupling either route to the other's provider
 * branches.
 */

export const VOICE_TRACE_HEADER = "X-Eliza-Voice-Trace-Id";

export interface VoiceTimingComponent {
  name: "admission" | "provider" | "transcribe" | "synth" | "cache" | "error";
  durationMs: number;
}

export function readVoiceTraceId(request: Request): string | null {
  const traceId = request.headers.get(VOICE_TRACE_HEADER)?.trim();
  return traceId || null;
}

export function elapsedMs(startMs: number): number {
  return Math.max(0, Date.now() - startMs);
}

export function voiceTraceHeaders(
  traceId: string | null,
  timings: ReadonlyArray<VoiceTimingComponent>,
  extra?: HeadersInit,
): Headers {
  const headers = new Headers(extra);
  if (traceId) headers.set(VOICE_TRACE_HEADER, traceId);
  const serverTiming = timings
    .map(
      ({ name, durationMs }) =>
        `${name};dur=${Math.max(0, Math.round(durationMs))}`,
    )
    .join(", ");
  if (serverTiming) headers.set("Server-Timing", serverTiming);
  return headers;
}

export function voiceJsonResponse(
  body: unknown,
  init: {
    status?: number;
    traceId: string | null;
    timings: ReadonlyArray<VoiceTimingComponent>;
  },
): Response {
  return Response.json(body, {
    status: init.status,
    headers: voiceTraceHeaders(init.traceId, init.timings),
  });
}
