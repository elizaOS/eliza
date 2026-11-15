/** Bounded entry diagnostics; never changes admission or records request content. */

import {
  ELIZA_TRACE_ID_HEADER,
  resolveElizaTraceId,
} from "@elizaos/cloud-shared/lib/observability/http-telemetry";
import { logger } from "@elizaos/cloud-shared/lib/utils/logger";
import { isInferenceTraceId } from "@elizaos/core/protocol";

const ROUTES: Readonly<Record<string, string>> = {
  "/api/v1/chat/completions": "chat",
  "/api/v1/voice/stt": "stt",
  "/api/v1/voice/tts": "tts",
};
const OUTCOMES = ["entered", "returned", "threw", "allowed", "denied"] as const;
const PHASES = [
  "fetch_enter",
  "dispatch_enter",
  "shell_import",
  "route_import",
  "shell_create",
  "app_wait",
  "app_ready",
  "ingress_enter",
  "ingress_decision",
  "route_enter",
] as const;
type Phase = (typeof PHASES)[number];

/** Exact staging identity only; production, missing and malformed identities stay off. */
export function isInferenceEntryTimingEnabled(
  environment: unknown,
  path: string,
): boolean {
  return environment === "staging" && Object.hasOwn(ROUTES, path);
}

/** Preserve the original request unless staging diagnostics need a canonical trace. */
export function prepareInferenceEntryRequest(
  request: Request,
  environment: unknown,
): Request {
  if (environment !== "staging") return request;
  const path = new URL(request.url).pathname;
  if (!isInferenceEntryTimingEnabled(environment, path)) return request;
  const traceId = resolveElizaTraceId(request.headers);
  if (request.headers.get(ELIZA_TRACE_ID_HEADER) === traceId) return request;
  const headers = new Headers(request.headers);
  headers.set(ELIZA_TRACE_ID_HEADER, traceId);
  return new Request(request, { headers });
}

export function recordInferenceEntryPhase(input: {
  environment: unknown;
  traceId: unknown;
  path: string;
  phase: Phase;
  durationMs: number;
  outcome: "entered" | "returned" | "threw" | "allowed" | "denied";
  appPromise?: "created" | "existing";
  ingress?: "decision" | "failure" | "timeout" | "absent";
}) {
  try {
    if (!isInferenceEntryTimingEnabled(input.environment, input.path)) return;
    const route = Object.hasOwn(ROUTES, input.path)
      ? ROUTES[input.path]
      : undefined;
    const durationMs = Math.round(input.durationMs * 10) / 10;
    if (
      !route ||
      !PHASES.includes(input.phase) ||
      !OUTCOMES.includes(input.outcome) ||
      !Number.isFinite(input.durationMs) ||
      input.durationMs < 0 ||
      !Number.isFinite(durationMs)
    )
      return;
    logger.audit("[InferenceEntry] phase timing", {
      schema: "inference_entry_phase_v1",
      traceId: isInferenceTraceId(input.traceId)
        ? input.traceId
        : "unavailable",
      route,
      phase: input.phase,
      durationMs,
      outcome: input.outcome,
      ...(["created", "existing"].includes(input.appPromise ?? "")
        ? { appPromise: input.appPromise }
        : {}),
      ...(["decision", "failure", "timeout", "absent"].includes(
        input.ingress ?? "",
      )
        ? { ingress: input.ingress }
        : {}),
    });
  } catch {
    // Diagnostic failures must not affect the operation or its original error.
  }
}

export async function timeInferenceEntryPhase<T>(
  environment: unknown,
  traceId: unknown,
  path: string,
  phase: Phase,
  run: () => Promise<T>,
): Promise<T> {
  if (!isInferenceEntryTimingEnabled(environment, path)) return run();
  const startedAt = performance.now();
  let outcome: "returned" | "threw" = "returned";
  try {
    return await run();
  } catch (error) {
    outcome = "threw";
    throw error;
  } finally {
    recordInferenceEntryPhase({
      environment,
      traceId,
      path,
      phase,
      durationMs: performance.now() - startedAt,
      outcome,
    });
  }
}
