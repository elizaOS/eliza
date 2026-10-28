/** Fixed-field model transport diagnostics. Never reads request/response content or raw URLs. */
import { logger } from "@elizaos/core";
import { readAllowedServerTiming } from "./server-timing";
const METRICS = [
  "entry_dispatch",
  "inference_module_init",
  "cloud_worker",
  "upstream_headers",
  "gateway_auth",
  "gateway_middle",
  "gateway_reserve",
  "gateway_setup",
  "gateway_preforward",
  "auth_extract",
  "auth_resolve",
  "auth_cache_available",
  "auth_cache_read",
  "auth_cache_fetch",
  "auth_cache_validate",
  "auth_cache_policy",
  "auth_identity",
  "auth_moderation",
  "auth_cache_write",
] as const;
const TRACE =
  /^(?:[a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i;
export type ModelHttpObservation = {
  event: "cloud_model_http";
  diagnosticId: string;
  route: "responses" | "chat/completions" | "chat/completions:stream";
  attempt: number;
  phase: "headers" | "body";
  status?: number;
  durationMs: number;
  queueWaitMs?: number;
  upstreamTraceId?: string;
  ownedTraceId?: string;
  correlated?: boolean;
  admissionCacheRead?:
    | "not_run"
    | "hit"
    | "rejected"
    | "miss"
    | "invalid"
    | "unavailable"
    | "error";
  admissionResult?:
    | "authorized_cache"
    | "authorized_origin"
    | "warming"
    | "suspended"
    | "slow_path"
    | "rejected"
    | "error";
  serverTimingMs?: Partial<Record<(typeof METRICS)[number], number>>;
  outcome: "returned" | "failed" | "completed" | "aborted";
};
export function createModelHttpTiming(
  route: string,
  ownedTraceId?: string,
  sink: (event: ModelHttpObservation) => void = (event) =>
    logger.warn(event, "[ELIZAOS_CLOUD] model HTTP timing"),
) {
  const enabled = [
    "responses",
    "chat/completions",
    "chat/completions:stream",
  ].includes(route);
  const diagnosticId = crypto.randomUUID();
  let attempt = 0;
  const emit = (
    row: Omit<ModelHttpObservation, "event" | "diagnosticId" | "route">,
  ) => {
    if (!enabled) return;
    try {
      sink({
        event: "cloud_model_http",
        diagnosticId,
        route: route as ModelHttpObservation["route"],
        ...(ownedTraceId && TRACE.test(ownedTraceId) ? { ownedTraceId } : {}),
        ...row,
      });
    } catch {
      /* Telemetry cannot change inference. */
    }
  };
  return {
    async request(run: () => Promise<Response>, queueWaitMs?: number) {
      attempt++;
      const at = performance.now(),
        number = attempt;
      let response: Response;
      try {
        response = await run();
      } catch (error) {
        emit({
          attempt: number,
          phase: "headers",
          durationMs: Math.round(performance.now() - at),
          outcome: "failed",
        });
        throw error;
      }
      let admissionCacheRead: ModelHttpObservation["admissionCacheRead"],
        admissionResult: ModelHttpObservation["admissionResult"];
      let upstreamTraceId: string | undefined,
        serverTimingMs: ModelHttpObservation["serverTimingMs"];
      try {
        const value = response.headers.get("X-Eliza-Trace-Id");
        upstreamTraceId = value && TRACE.test(value) ? value : undefined;
        const cache = response.headers.get("X-Eliza-Auth-Trace");
        if (cache && cache.length <= 1024 && !/[\r\n]/.test(cache)) {
          const fields = cache.split(";").map((p) => p.split("="));
          if (
            fields.filter(([k]) => k === "v").length === 1 &&
            fields.some(
              ([k, v, ...rest]) => k === "v" && v === "1" && rest.length === 0,
            )
          ) {
            const read = fields.filter(([k]) => k === "read");
            const result = fields.filter(([k]) => k === "result");
            if (
              read.length === 1 &&
              read[0].length === 2 &&
              [
                "not_run",
                "hit",
                "rejected",
                "miss",
                "invalid",
                "unavailable",
                "error",
              ].includes(read[0][1])
            )
              admissionCacheRead =
                read[0][1] as ModelHttpObservation["admissionCacheRead"];
            if (
              result.length === 1 &&
              result[0].length === 2 &&
              [
                "authorized_cache",
                "authorized_origin",
                "warming",
                "suspended",
                "slow_path",
                "rejected",
                "error",
              ].includes(result[0][1])
            )
              admissionResult =
                result[0][1] as ModelHttpObservation["admissionResult"];
          }
        }
        serverTimingMs = readAllowedServerTiming(
          response.headers.get("Server-Timing"),
          METRICS,
        );
      } catch {
        /* Missing headers are not zero. */
      }
      emit({
        attempt: number,
        phase: "headers",
        status: response.status,
        durationMs: Math.round(performance.now() - at),
        ...(queueWaitMs !== undefined &&
        Number.isFinite(queueWaitMs) &&
        queueWaitMs >= 0
          ? { queueWaitMs: Math.round(queueWaitMs) }
          : {}),
        ...(upstreamTraceId
          ? { upstreamTraceId, correlated: upstreamTraceId === ownedTraceId }
          : {}),
        ...(serverTimingMs ? { serverTimingMs } : {}),
        ...(admissionCacheRead ? { admissionCacheRead } : {}),
        ...(admissionResult ? { admissionResult } : {}),
        outcome: "returned",
      });
      const bodyAt = performance.now();
      let finished = false;
      return {
        response,
        bodyDone(outcome: "completed" | "failed" | "aborted") {
          if (finished) return;
          finished = true;
          emit({
            attempt: number,
            phase: "body",
            status: response.status,
            durationMs: Math.round(performance.now() - bodyAt),
            ...(upstreamTraceId ? { upstreamTraceId } : {}),
            outcome,
          });
        },
      };
    },
  };
}
