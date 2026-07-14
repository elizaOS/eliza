/**
 * HTTP trace-correlation and Server-Timing helpers shared by Cloud Worker routes.
 *
 * Cloudflare's native trace id is not propagated to external origins, so the
 * application-level id below correlates callers with the Cloud gateway. Deeper
 * provider and dedicated-agent propagation is tracked separately.
 */

import { ElizaError } from "@elizaos/core";
import type { InferenceAuthTelemetry } from "../services/inference-auth-context";

export const ELIZA_TRACE_ID_HEADER = "X-Eliza-Trace-Id";
export const ELIZA_PREFORWARD_HEADER = "X-Eliza-Preforward-Ms";
export const ELIZA_TELEMETRY_HEADER = "X-Eliza-Telemetry";
export const ELIZA_AUTH_TRACE_HEADER = "X-Eliza-Auth-Trace";

const OPAQUE_TRACE_ID =
  /^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;
const W3C_TRACEPARENT_V00 = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;
const ZERO_TRACE_ID = "0".repeat(32);
const ZERO_PARENT_ID = "0".repeat(16);

export interface ServerTimingMetric {
  name: string;
  durationMs: number;
  description?: string;
}

export interface GatewayPreforwardTiming {
  readonly totalMs: number;
  readonly authMs: number;
  readonly middleMs: number;
  readonly reserveMs: number;
  readonly setupMs: number;
}

/** Hooks placed at the gateway's direct-fetch or AI SDK handoff boundary. */
export interface GatewayHandoffTelemetry {
  capture(): void;
  emit(): void;
}

/** Resolve an opaque correlation id without retaining caller-chosen text. */
export function resolveElizaTraceId(headers: Headers): string {
  const supplied = headers.get(ELIZA_TRACE_ID_HEADER)?.trim();
  if (supplied && OPAQUE_TRACE_ID.test(supplied) && supplied.toLowerCase() !== ZERO_TRACE_ID) {
    return supplied.toLowerCase();
  }

  const traceparent = headers.get("traceparent")?.trim();
  const match = traceparent?.match(W3C_TRACEPARENT_V00);
  if (match && match[1] !== ZERO_TRACE_ID && match[2] !== ZERO_PARENT_ID) {
    return match[1];
  }
  return crypto.randomUUID();
}

function sanitizeToken(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 64) || "unknown";
}

function finiteDuration(value: number, field: string): number {
  const rounded = Math.round(value * 100) / 100;
  if (!Number.isFinite(value) || value < 0 || !Number.isFinite(rounded)) {
    throw new ElizaError("HTTP telemetry duration is invalid", {
      code: "HTTP_TELEMETRY_INVALID_DURATION",
      severity: "fatal",
      context: { field, value: String(value) },
    });
  }
  return rounded;
}

/** Normalize once so structured logs and both response formats agree exactly. */
export function snapshotGatewayPreforwardTiming(
  timing: GatewayPreforwardTiming,
): GatewayPreforwardTiming {
  return Object.freeze({
    totalMs: finiteDuration(timing.totalMs, "totalMs"),
    authMs: finiteDuration(timing.authMs, "authMs"),
    middleMs: finiteDuration(timing.middleMs, "middleMs"),
    reserveMs: finiteDuration(timing.reserveMs, "reserveMs"),
    setupMs: finiteDuration(timing.setupMs, "setupMs"),
  });
}

/**
 * Snapshot immediately before gateway control passes to fetch or the AI SDK.
 * `finally` preserves telemetry when that synchronous invocation throws.
 */
export function invokeAtGatewayHandoff<T>(
  telemetry: GatewayHandoffTelemetry | undefined,
  operation: () => T,
): T {
  telemetry?.capture();
  try {
    return operation();
  } finally {
    telemetry?.emit();
  }
}

/** Bind telemetry without moving argument/config construction past the boundary. */
export function bindGatewayHandoffTelemetry<TInput, TOutput>(
  telemetry: GatewayHandoffTelemetry | undefined,
  operation: (input: TInput) => TOutput,
): (input: TInput) => TOutput {
  return (input) => invokeAtGatewayHandoff(telemetry, () => operation(input));
}

/** Append metrics while preserving Server-Timing values set by inner hops. */
export function appendServerTiming(headers: Headers, metrics: readonly ServerTimingMetric[]): void {
  const encoded = metrics.map((metric) => {
    const name = sanitizeToken(metric.name);
    const duration = finiteDuration(metric.durationMs, `Server-Timing:${name}`);
    const description = metric.description ? `;desc="${sanitizeToken(metric.description)}"` : "";
    return `${name};dur=${duration}${description}`;
  });
  if (encoded.length === 0) return;

  const existing = headers.get("Server-Timing");
  headers.set(
    "Server-Timing",
    existing ? `${existing}, ${encoded.join(", ")}` : encoded.join(", "),
  );
}

/** Add browser-readable correlation headers to a mutable response. */
export function setHttpTelemetryHeaders(
  headers: Headers,
  traceId: string,
  metrics: readonly ServerTimingMetric[] = [],
  timingAllowOrigin?: string,
): void {
  headers.set(ELIZA_TRACE_ID_HEADER, traceId);
  if (timingAllowOrigin) {
    headers.set("Timing-Allow-Origin", timingAllowOrigin);
  }
  appendServerTiming(headers, metrics);
}

/** Emit the same frozen gateway boundary in legacy and standard formats. */
export function setGatewayPreforwardTelemetryHeaders(
  headers: Headers,
  traceId: string,
  timing: GatewayPreforwardTiming,
): void {
  const snapshot = snapshotGatewayPreforwardTiming(timing);
  headers.set(
    ELIZA_PREFORWARD_HEADER,
    `total=${snapshot.totalMs};auth=${snapshot.authMs};mid=${snapshot.middleMs};reserve=${snapshot.reserveMs};setup=${snapshot.setupMs}`,
  );
  setHttpTelemetryHeaders(headers, traceId, [
    { name: "gateway_auth", durationMs: snapshot.authMs },
    { name: "gateway_middle", durationMs: snapshot.middleMs },
    { name: "gateway_reserve", durationMs: snapshot.reserveMs },
    { name: "gateway_setup", durationMs: snapshot.setupMs },
    { name: "gateway_preforward", durationMs: snapshot.totalMs },
  ]);
}

/** Re-wrap a provider response without buffering its body or mutating immutable headers. */
export function withGatewayPreforwardTelemetry(
  response: Response,
  traceId: string,
  timing: GatewayPreforwardTiming,
): Response {
  const headers = new Headers(response.headers);
  setGatewayPreforwardTelemetryHeaders(headers, traceId, timing);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function inferenceAuthTimingMetrics(telemetry: InferenceAuthTelemetry): ServerTimingMetric[] {
  const metrics: ServerTimingMetric[] = [
    { name: "auth_extract", durationMs: telemetry.timings.extractMs },
    { name: "auth_resolve", durationMs: telemetry.timings.totalMs },
  ];
  const optional = [
    ["auth_cache_available", telemetry.timings.cacheAvailabilityMs],
    ["auth_cache_read", telemetry.timings.cacheReadMs],
    ["auth_key_lookup", telemetry.timings.keyLookupMs],
    ["auth_user_org", telemetry.timings.userOrgLookupMs],
    ["auth_moderation", telemetry.timings.moderationMs],
    ["auth_cache_write", telemetry.timings.cacheWriteMs],
  ] as const;
  for (const [name, durationMs] of optional) {
    if (durationMs !== null) metrics.push({ name, durationMs });
  }
  return metrics;
}

/** Add one bounded auth decision record plus its correlated sub-hop timings. */
export function withInferenceAuthTelemetry(
  response: Response,
  traceId: string,
  telemetry: InferenceAuthTelemetry,
): Response {
  const headers = new Headers(response.headers);
  headers.set(
    ELIZA_AUTH_TRACE_HEADER,
    [
      "v=1",
      `credential=${telemetry.authSource}`,
      `probe=${telemetry.controlledProbe}`,
      `available=${telemetry.cacheAvailability}`,
      `backend=${telemetry.cacheBackend}`,
      `read=${telemetry.cacheRead}`,
      `authoritative=${telemetry.authoritative}`,
      `write=${telemetry.cacheWrite}`,
      `result=${telemetry.result}`,
    ].join(";"),
  );
  setHttpTelemetryHeaders(headers, traceId, inferenceAuthTimingMetrics(telemetry));
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * Copy only non-sensitive telemetry headers while one compatibility route
 * transforms a response body into another wire format.
 */
export function copyHttpTelemetryHeaders(from: Headers, to: Headers): void {
  for (const name of [
    ELIZA_TRACE_ID_HEADER,
    ELIZA_PREFORWARD_HEADER,
    ELIZA_AUTH_TRACE_HEADER,
    "Server-Timing",
    "Timing-Allow-Origin",
    "X-Eliza-Inference-Path",
  ]) {
    const value = from.get(name);
    if (value) to.set(name, value);
  }
}
