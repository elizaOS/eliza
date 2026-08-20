/**
 * Turn-to-gateway trace correlation for elizaOS Cloud text calls (#16079).
 *
 * The Cloud gateway accepts a bounded `X-Eliza-Trace-Id` request header,
 * validates it, keys its structured preforward/auth events to it, and echoes
 * it (plus a frozen `X-Eliza-Preforward-Ms` decomposition and Server-Timing)
 * on the response. Without a caller-supplied id the gateway mints its own,
 * leaving the agent-side turn and the gateway's events unjoinable. These
 * helpers close that gap: outbound requests carry the active inference turn's
 * trace id, and the echoed gateway telemetry is folded back into the same
 * turn as a `cloud.gateway-preforward` span, so one id follows the turn from
 * the runtime through the gateway's own logs.
 *
 * All helpers are no-ops when no turn timer is active, matching the
 * inference-timing contract that instrumentation is safe on every code path.
 * Response headers are treated as untrusted input: an id or timing header
 * that fails strict validation is dropped, never coerced into fake data.
 */

import { getInferenceTimer, recordInferenceSpan } from "@elizaos/core";

/** Request/response correlation header understood by the Cloud gateway. */
export const ELIZA_TRACE_ID_HEADER = "X-Eliza-Trace-Id";
/** Frozen gateway pre-forward decomposition echoed on gateway responses. */
export const ELIZA_PREFORWARD_HEADER = "X-Eliza-Preforward-Ms";

/** Ids the gateway's bounded validator accepts back verbatim. */
const GATEWAY_TRACE_ID = /^[0-9a-f]{32}$/;
/** Ids the gateway may echo: the caller's 32-hex id or a gateway-minted UUID. */
const ECHOED_TRACE_ID =
  /^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

/**
 * Attach the active turn's trace id to an outbound header record. Mutates and
 * returns `headers`; a call outside a timed turn leaves them unchanged.
 */
export function withInferenceTraceHeader(
  headers: Record<string, string>
): Record<string, string> {
  const timer = getInferenceTimer();
  if (timer && GATEWAY_TRACE_ID.test(timer.traceId)) {
    headers[ELIZA_TRACE_ID_HEADER] = timer.traceId;
  }
  return headers;
}

/** Frozen pre-forward decomposition parsed from the gateway response. */
export interface GatewayPreforwardBreakdown {
  totalMs: number;
  authMs: number;
  midMs: number;
  reserveMs: number;
  setupMs: number;
}

const PREFORWARD_FIELDS = ["total", "auth", "mid", "reserve", "setup"] as const;
const MAX_PREFORWARD_MS = 3_600_000;

/**
 * Strictly parse `X-Eliza-Preforward-Ms`
 * (`total=<ms>;auth=<ms>;mid=<ms>;reserve=<ms>;setup=<ms>`). Any missing,
 * duplicate, non-finite, negative, or absurd (> 1h) field invalidates the
 * whole header — a partial decomposition would misattribute time.
 */
export function parseGatewayPreforwardHeader(
  value: string | null
): GatewayPreforwardBreakdown | null {
  if (!value || value.length > 256) return null;
  const fields = new Map<string, number>();
  for (const part of value.split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0) return null;
    const name = part.slice(0, eq).trim();
    const parsed = Number(part.slice(eq + 1).trim());
    if (
      !(PREFORWARD_FIELDS as readonly string[]).includes(name) ||
      fields.has(name) ||
      !Number.isFinite(parsed) ||
      parsed < 0 ||
      parsed > MAX_PREFORWARD_MS
    ) {
      return null;
    }
    fields.set(name, parsed);
  }
  if (fields.size !== PREFORWARD_FIELDS.length) return null;
  return {
    totalMs: fields.get("total") as number,
    authMs: fields.get("auth") as number,
    midMs: fields.get("mid") as number,
    reserveMs: fields.get("reserve") as number,
    setupMs: fields.get("setup") as number,
  };
}

/**
 * Fold the gateway's echoed telemetry into the active turn as a
 * `cloud.gateway-preforward` span whose meta records the decomposition and
 * whether the gateway adopted the turn's own trace id (`correlated`). Missing
 * or invalid telemetry records nothing — absence stays visible as absence.
 */
export function recordGatewayResponseTelemetry(
  response: Pick<Response, "headers">,
  route: string
): void {
  const timer = getInferenceTimer();
  if (!timer) return;
  const breakdown = parseGatewayPreforwardHeader(
    response.headers.get(ELIZA_PREFORWARD_HEADER)
  );
  if (!breakdown) return;
  const echoed = response.headers.get(ELIZA_TRACE_ID_HEADER)?.trim().toLowerCase();
  const gatewayTraceId = echoed && ECHOED_TRACE_ID.test(echoed) ? echoed : undefined;
  recordInferenceSpan("cloud.gateway-preforward", breakdown.totalMs, {
    route,
    authMs: breakdown.authMs,
    midMs: breakdown.midMs,
    reserveMs: breakdown.reserveMs,
    setupMs: breakdown.setupMs,
    correlated: gatewayTraceId === timer.traceId,
    ...(gatewayTraceId ? { gatewayTraceId } : {}),
  });
}
