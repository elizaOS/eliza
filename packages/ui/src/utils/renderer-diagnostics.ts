/**
 * Single renderer diagnostic boundary for background failures. It emits
 * structured logs and an in-window event with a correlation ID so support
 * captures can connect user-visible errors to their originating operation.
 */

import { logger } from "@elizaos/logger";

export const RENDERER_DIAGNOSTIC_EVENT = "eliza:renderer-diagnostic";

export type RendererDiagnosticSeverity = "info" | "warning" | "error";

export interface RendererDiagnosticInput {
  scope: string;
  error: unknown;
  severity?: RendererDiagnosticSeverity;
  context?: Readonly<Record<string, unknown>>;
  correlationId?: string;
}

export interface RendererDiagnostic {
  scope: string;
  message: string;
  severity: RendererDiagnosticSeverity;
  correlationId: string;
  cause?: unknown;
  context?: Readonly<Record<string, unknown>>;
}

let diagnosticSequence = 0;

function nextCorrelationId(): string {
  const randomUuid = globalThis.crypto?.randomUUID?.();
  if (randomUuid) return randomUuid;
  diagnosticSequence += 1;
  return `renderer-${Date.now().toString(36)}-${diagnosticSequence.toString(36)}`;
}

export function createRendererDiagnostic(
  input: RendererDiagnosticInput,
): RendererDiagnostic {
  const error = input.error;
  const message =
    error instanceof Error ? error.message : String(error ?? "Unknown error");
  const cause = error instanceof Error ? error.cause : undefined;
  return {
    scope: input.scope,
    message,
    severity: input.severity ?? "error",
    correlationId: input.correlationId ?? nextCorrelationId(),
    ...(cause !== undefined ? { cause } : {}),
    ...(input.context ? { context: input.context } : {}),
  };
}

export function reportRendererDiagnostic(
  input: RendererDiagnosticInput,
): RendererDiagnostic {
  const diagnostic = createRendererDiagnostic(input);
  const logContext = { diagnostic, error: input.error };
  if (diagnostic.severity === "error") {
    logger.error(logContext, `[RendererDiagnostic] ${diagnostic.scope}`);
  } else if (diagnostic.severity === "warning") {
    logger.warn(logContext, `[RendererDiagnostic] ${diagnostic.scope}`);
  } else {
    logger.info(logContext, `[RendererDiagnostic] ${diagnostic.scope}`);
  }

  if (typeof window !== "undefined") {
    try {
      window.dispatchEvent(
        new CustomEvent(RENDERER_DIAGNOSTIC_EVENT, { detail: diagnostic }),
      );
    } catch (eventError) {
      // error-policy:J7 diagnostics must not break the originating UI path;
      // the structured log above remains the primary observation boundary.
      logger.warn(
        { eventError, correlationId: diagnostic.correlationId },
        "[RendererDiagnostic] event dispatch failed",
      );
    }
  }
  return diagnostic;
}
