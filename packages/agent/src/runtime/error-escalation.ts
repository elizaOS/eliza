/**
 * Raises repeated systemic runtime failures to the owner (#12263 / parent #12182).
 *
 * Subscribes to {@link EventType.ERROR_REPORTED} and, when the same error
 * `code` crosses a threshold within a sliding window (default 3 in 10 minutes),
 * calls {@link EscalationService.startEscalation} — reusing its existing owner
 * channels, retries, coalescing, and prompt injection. It never escalates
 * per-error: only a repeated, code-stable failure trips the threshold, and the
 * per-code window resets after each trip so it can't spam. Escalation-path
 * failures are logged only — they never re-enter `runtime.reportError`, which
 * would form a feedback loop.
 */

import type { ErrorReportedPayload, IAgentRuntime } from "@elizaos/core";
import { EventType, logger } from "@elizaos/core";
import { EscalationService } from "../services/escalation.ts";

const DEFAULT_THRESHOLD = 3;
const DEFAULT_WINDOW_MINUTES = 10;

/**
 * Sliding-window per-`code` failure counter. Pure and clock-injectable so the
 * threshold + reset behavior is testable with controlled timestamps.
 */
export class ErrorEscalationTracker {
  private readonly timestampsByCode = new Map<string, number[]>();

  constructor(
    private readonly threshold: number = DEFAULT_THRESHOLD,
    private readonly windowMs: number = DEFAULT_WINDOW_MINUTES * 60 * 1000,
  ) {}

  /**
   * Record one failure for `code` at `now` (epoch-ms). Returns the current
   * in-window count and whether the threshold was crossed. On a crossing the
   * window for that code is cleared so the next escalation requires a fresh
   * run of failures (prevents per-error spam).
   */
  record(
    code: string,
    now: number,
  ): { count: number; shouldEscalate: boolean } {
    const cutoff = now - this.windowMs;
    const prior = this.timestampsByCode.get(code);
    const kept = prior ? prior.filter((ts) => ts > cutoff) : [];
    kept.push(now);

    if (kept.length >= this.threshold) {
      this.timestampsByCode.delete(code);
      return { count: kept.length, shouldEscalate: true };
    }
    this.timestampsByCode.set(code, kept);
    return { count: kept.length, shouldEscalate: false };
  }
}

function resolveThreshold(runtime: IAgentRuntime): number {
  const raw = runtime.getSetting?.("ERROR_ESCALATION_THRESHOLD");
  const parsed = raw ? Number(raw) : Number.NaN;
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : DEFAULT_THRESHOLD;
}

function resolveWindowMs(runtime: IAgentRuntime): number {
  const raw = runtime.getSetting?.("ERROR_ESCALATION_WINDOW_MINUTES");
  const parsed = raw ? Number(raw) : Number.NaN;
  const minutes =
    Number.isFinite(parsed) && parsed >= 1 ? parsed : DEFAULT_WINDOW_MINUTES;
  return minutes * 60 * 1000;
}

/**
 * Build the ERROR_REPORTED handler that drives the tracker and, on a threshold
 * crossing, starts an owner escalation. Exported for direct testing; register
 * it via {@link registerErrorEscalation}.
 */
export function createErrorReportedEscalationHandler(
  runtime: IAgentRuntime,
  tracker: ErrorEscalationTracker,
  windowMinutes: number,
): (payload: ErrorReportedPayload) => Promise<void> {
  return async (payload: ErrorReportedPayload): Promise<void> => {
    const { count, shouldEscalate } = tracker.record(payload.code, Date.now());
    if (!shouldEscalate) return;

    const reason = `Systemic failure ${payload.code} reported ${count} times within ${windowMinutes}m`;
    const context = payload.context
      ? ` ${JSON.stringify(payload.context)}`
      : "";
    const text = `Repeated runtime failure "${payload.code}" from [${payload.scope}]: ${payload.message}${context}`;

    try {
      await EscalationService.startEscalation(runtime, reason, text);
      logger.warn(
        { src: "agent", code: payload.code, count },
        `[ErrorEscalation] Escalated systemic failure ${payload.code}`,
      );
    } catch (err) {
      // error-policy:J7 diagnostics-must-not-kill-the-loop — an escalation
      // failure is logged only; re-entering reportError here would form a
      // failure feedback loop.
      logger.error(
        { src: "agent", code: payload.code, err },
        `[ErrorEscalation] Failed to start escalation for ${payload.code}`,
      );
    }
  };
}

/**
 * Wire the repeat-failure → owner-escalation path onto a runtime. Idempotent
 * per runtime is the caller's responsibility (call once from plugin init).
 */
export function registerErrorEscalation(runtime: IAgentRuntime): void {
  const threshold = resolveThreshold(runtime);
  const windowMs = resolveWindowMs(runtime);
  const windowMinutes = Math.round(windowMs / 60000);
  const tracker = new ErrorEscalationTracker(threshold, windowMs);
  runtime.registerEvent(
    EventType.ERROR_REPORTED,
    createErrorReportedEscalationHandler(runtime, tracker, windowMinutes),
  );
  logger.debug(
    { src: "agent", threshold, windowMinutes },
    "[ErrorEscalation] Registered repeat-failure escalation",
  );
}
