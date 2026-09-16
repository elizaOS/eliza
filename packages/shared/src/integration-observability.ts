/**
 * Canonical integration-boundary telemetry schema and settle-once span.
 *
 * Hosts share event construction and sanitization while an injected severity
 * policy may classify expected failures without forking the wire contract.
 */
import { logger } from "@elizaos/core";

export type IntegrationBoundary =
  | "cloud"
  | "wallet"
  | "marketplace"
  | "mcp"
  | "lifeops"
  | "browser-bridge";
export type IntegrationOutcome = "success" | "failure";
export type IntegrationSeverity = "info" | "warn";

export interface IntegrationObservabilityEvent {
  schema: "integration_boundary_v1";
  boundary: IntegrationBoundary;
  operation: string;
  outcome: IntegrationOutcome;
  durationMs: number;
  timeoutMs?: number;
  statusCode?: number;
  errorKind?: string;
}

export interface IntegrationLogger {
  info: (message: string) => void;
  warn: (message: string) => void;
}

export interface IntegrationSpanMeta {
  boundary: IntegrationBoundary;
  operation: string;
  timeoutMs?: number;
}

export interface IntegrationSpanSuccessArgs {
  statusCode?: number;
}

export interface IntegrationSpanFailureArgs {
  statusCode?: number;
  error?: unknown;
  errorKind?: string;
}

export type IntegrationSeverityPolicy = (
  event: IntegrationObservabilityEvent,
) => IntegrationSeverity;

export interface CreateIntegrationSpanOptions {
  now?: () => number;
  sink?: IntegrationLogger;
  severityForEvent?: IntegrationSeverityPolicy;
}

export interface IntegrationTelemetrySpan {
  success: (args?: IntegrationSpanSuccessArgs) => void;
  failure: (args?: IntegrationSpanFailureArgs) => void;
}

const EVENT_PREFIX = "[integration]";

function sanitizeToken(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const lower = value.toLowerCase();
  let normalized = "";
  let pendingUnderscore = false;
  for (let index = 0; index < lower.length; index++) {
    const code = lower.charCodeAt(index);
    const isAllowed =
      (code >= 48 && code <= 57) || (code >= 97 && code <= 122) || code === 45;
    if (!isAllowed) {
      if (normalized.length > 0) pendingUnderscore = true;
      continue;
    }
    if (pendingUnderscore) {
      normalized += "_";
      if (normalized.length === 64) break;
      pendingUnderscore = false;
    }
    normalized += lower[index];
    if (normalized.length === 64) break;
  }
  return normalized || undefined;
}

function inferErrorKind(error: unknown): string | undefined {
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    if (
      error.name === "AbortError" ||
      error.name === "TimeoutError" ||
      message.includes("timeout") ||
      message.includes("timed out")
    ) {
      return "timeout";
    }
    return sanitizeToken(error.name);
  }
  return typeof error === "string" ? sanitizeToken(error) : undefined;
}

/** Default host-neutral classification for known expected fallback paths. */
export const defaultIntegrationSeverityPolicy: IntegrationSeverityPolicy = (
  event,
) => {
  if (event.outcome === "success") return "info";
  if (
    (event.boundary === "lifeops" &&
      (event.errorKind === "runtime_unavailable" ||
        event.errorKind === "lifeops_storage_unavailable" ||
        event.errorKind === "lifeops_auth_invalid")) ||
    (event.boundary === "marketplace" && event.errorKind === "timeout")
  ) {
    return "info";
  }
  return "warn";
};

export function createIntegrationTelemetrySpan(
  meta: IntegrationSpanMeta,
  options: CreateIntegrationSpanOptions = {},
): IntegrationTelemetrySpan {
  const now = options.now ?? Date.now;
  const sink = options.sink ?? logger;
  const severityForEvent =
    options.severityForEvent ?? defaultIntegrationSeverityPolicy;
  const startedAt = now();
  let settled = false;

  const finalize = (
    outcome: IntegrationOutcome,
    args?: IntegrationSpanSuccessArgs | IntegrationSpanFailureArgs,
  ): void => {
    if (settled) return;
    settled = true;
    const event: IntegrationObservabilityEvent = {
      schema: "integration_boundary_v1",
      boundary: meta.boundary,
      operation: meta.operation,
      outcome,
      durationMs: Math.max(0, now() - startedAt),
    };
    if (typeof meta.timeoutMs === "number") event.timeoutMs = meta.timeoutMs;
    if (typeof args?.statusCode === "number")
      event.statusCode = args.statusCode;
    if (outcome === "failure") {
      const failure = args as IntegrationSpanFailureArgs | undefined;
      event.errorKind =
        sanitizeToken(failure?.errorKind) ?? inferErrorKind(failure?.error);
    }
    const line = `${EVENT_PREFIX} ${JSON.stringify(event)}`;
    sink[severityForEvent(event)](line);
  };

  return {
    success: (args) => finalize("success", args),
    failure: (args) => finalize("failure", args),
  };
}
