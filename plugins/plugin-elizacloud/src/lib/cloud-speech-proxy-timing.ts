import {readAllowedServerTiming} from "../utils/server-timing";
/** Privacy-bounded host-hop timing; only known numeric metrics and opaque correlation IDs. */
const SERVER_TIMING_METRICS = [
  "entry_dispatch",
  "inference_module_init",
  "cloud_worker",
  "auth",
  "admission",
  "moderation",
  "audio_cache",
  "pricing",
  "billing_admission",
  "dispatch_marker",
  "settlement",
  "usage_store",
  "audio_cache_capture",
  "audio_cache_store",
  "response_setup",
  "response_ready",
  "synthesis",
  "transcription",
] as const;
type SpeechServerTimingMetric = (typeof SERVER_TIMING_METRICS)[number];
export type SpeechProxyObservation = {
  kind: "stt" | "tts";
  proxyRequestId: string;
  candidate: number;
  attempt?: number;
  phase: "upstream_headers" | "retry_decision" | "body_drain";
  durationMs?: number;
  status?: number;
  bytes?: number;
  upstreamTraceId?: string;
  upstreamCfRay?: string;
  upstreamServerTimingMs?: Partial<Record<SpeechServerTimingMetric, number>>;
  code?: string;
  type?: string;
  reason?: string;
  retryWaitSeconds?: number | null;
  outcome?: "returned" | "threw";
};
export type SpeechProxyTimingSink = (observation: SpeechProxyObservation) => void;
export function emitSpeechProxyTiming(
  sink: SpeechProxyTimingSink,
  observation: SpeechProxyObservation
) {
  try {
    sink(observation);
  } catch {
    /* Diagnostics cannot change retry, audio or cancellation outcomes. */
  }
}
export function speechUpstreamTraceId(response: Response): string | undefined {
  const value = response.headers.get("X-Eliza-Trace-Id");
  return value &&
    /^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.test(value)
    ? value
    : undefined;
}

export async function timeSpeechProxyFetch(
  run: () => Promise<Response>,
  scope: Pick<SpeechProxyObservation, "kind" | "proxyRequestId" | "candidate" | "attempt">,
  sink: SpeechProxyTimingSink
): Promise<Response> {
  const started = Date.now();
  try {
    const response = await run();
    const cfRay = response.headers.get("CF-Ray");
    const serverTiming = readAllowedServerTiming(response.headers.get("Server-Timing"), SERVER_TIMING_METRICS);
    emitSpeechProxyTiming(sink, {
      ...scope,
      phase: "upstream_headers",
      status: response.status,
      durationMs: Math.max(0, Date.now() - started),
      upstreamTraceId: speechUpstreamTraceId(response),
      ...(cfRay && /^[a-f0-9]{16}(?:-[a-z]{3})?$/i.test(cfRay) ? { upstreamCfRay: cfRay } : {}),
      ...(serverTiming ? { upstreamServerTimingMs: serverTiming } : {}),
      outcome: "returned",
    });
    return response;
  } catch (error) {
    emitSpeechProxyTiming(sink, {
      ...scope,
      phase: "upstream_headers",
      durationMs: Math.max(0, Date.now() - started),
      outcome: "threw",
    });
    throw error;
  }
}
