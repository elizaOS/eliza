import { logger } from "@elizaos/core";

export type IntegrationBoundary = "cloud" | "wallet" | "marketplace" | "mcp";
export type IntegrationOutcome = "success" | "failure";

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

interface IntegrationLogger {
  info: (message: string) => void;
  warn: (message: string) => void;
}

interface IntegrationSpanMeta {
  boundary: IntegrationBoundary;
  operation: string;
  timeoutMs?: number;
}

interface IntegrationSpanSuccessArgs {
  statusCode?: number;
}

interface IntegrationSpanFailureArgs {
  statusCode?: number;
  error?: unknown;
  errorKind?: string;
}

interface CreateSpanOptions {
  now?: () => number;
  sink?: IntegrationLogger;
}

export interface IntegrationTelemetrySpan {
  success: (args?: IntegrationSpanSuccessArgs) => void;
  failure: (args?: IntegrationSpanFailureArgs) => void;
}

const EVENT_PREFIX = "[integration]";

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
  if (typeof error === "string") return sanitizeToken(error);
  return undefined;
}

function sanitizeToken(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const token = value.toLowerCase().replace(/[^a-z0-9_-]/g, "_");
  const normalized = token.replace(/_+/g, "_").replace(/^_+|_+$/g, "");
  return normalized ? normalized.slice(0, 64) : undefined;
}

function emitEvent(
  sink: IntegrationLogger,
  event: IntegrationObservabilityEvent,
): void {
  const line = `${EVENT_PREFIX} ${JSON.stringify(event)}`;
  if (event.outcome === "success") {
    sink.info(line);
    return;
  }
  sink.warn(line);
}

export function createIntegrationTelemetrySpan(
  meta: IntegrationSpanMeta,
  options: CreateSpanOptions = {},
): IntegrationTelemetrySpan {
  const now = options.now ?? Date.now;
  const sink = options.sink ?? logger;
  const startedAt = now();
  let settled = false;

  const finalize = (
    outcome: IntegrationOutcome,
    args?: IntegrationSpanSuccessArgs | IntegrationSpanFailureArgs,
  ): void => {
    if (settled) return;
    settled = true;

    const durationMs = Math.max(0, now() - startedAt);
    const event: IntegrationObservabilityEvent = {
      schema: "integration_boundary_v1",
      boundary: meta.boundary,
      operation: meta.operation,
      outcome,
      durationMs,
    };

    if (typeof meta.timeoutMs === "number") {
      event.timeoutMs = meta.timeoutMs;
    }
    if (typeof args?.statusCode === "number") {
      event.statusCode = args.statusCode;
    }

    if (outcome === "failure") {
      const failureArgs = args as IntegrationSpanFailureArgs | undefined;
      event.errorKind =
        sanitizeToken(failureArgs?.errorKind) ??
        inferErrorKind(failureArgs?.error);
    }

    emitEvent(sink, event);
  };

  return {
    success: (args) => finalize("success", args),
    failure: (args) => finalize("failure", args),
  };
}
