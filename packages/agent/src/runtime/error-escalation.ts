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
import {
  ElizaError,
  EventType,
  logger,
  QUIET_ERROR_CODES,
} from "@elizaos/core";
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

export function resolveThreshold(runtime: IAgentRuntime): number {
  const raw = runtime.getSetting?.("ERROR_ESCALATION_THRESHOLD");
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return DEFAULT_THRESHOLD;
  }

  const value = String(raw).trim();
  const parsed = Number(value);
  if (!/^[0-9]+$/.test(value) || !Number.isSafeInteger(parsed) || parsed < 1) {
    throw new ElizaError(
      `Invalid ERROR_ESCALATION_THRESHOLD value ${JSON.stringify(raw)}: expected a decimal integer >= 1`,
      {
        code: "ERROR_ESCALATION_CONFIG_INVALID",
        context: {
          setting: "ERROR_ESCALATION_THRESHOLD",
          configured: raw,
          requirement: "decimal integer >= 1",
        },
        severity: "fatal",
      },
    );
  }
  return parsed;
}

export function resolveWindowMs(runtime: IAgentRuntime): number {
  const raw = runtime.getSetting?.("ERROR_ESCALATION_WINDOW_MINUTES");
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return DEFAULT_WINDOW_MINUTES * 60 * 1000;
  }

  const value = String(raw).trim();
  const parsed = Number(value);
  if (
    !/^(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)$/.test(value) ||
    !Number.isFinite(parsed) ||
    parsed <= 0
  ) {
    throw new ElizaError(
      `Invalid ERROR_ESCALATION_WINDOW_MINUTES value ${JSON.stringify(raw)}: expected positive plain-decimal minutes`,
      {
        code: "ERROR_ESCALATION_CONFIG_INVALID",
        context: {
          setting: "ERROR_ESCALATION_WINDOW_MINUTES",
          configured: raw,
          requirement: "positive plain-decimal minutes",
        },
        severity: "fatal",
      },
    );
  }

  const ms = parsed * 60_000;
  if (!Number.isFinite(ms) || !Number.isSafeInteger(ms)) {
    throw new ElizaError(
      `Invalid ERROR_ESCALATION_WINDOW_MINUTES value ${JSON.stringify(raw)}: value overflows a safe millisecond window`,
      {
        code: "ERROR_ESCALATION_CONFIG_INVALID",
        context: {
          setting: "ERROR_ESCALATION_WINDOW_MINUTES",
          configured: raw,
          requirement: "positive plain-decimal minutes",
        },
        severity: "fatal",
      },
    );
  }
  return ms;
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
    if (payload.context?.diagnosticOnly === true) return;
    // Internal scheduler/plumbing codes are self-healing or operator-facing and
    // must never be escalated into the owner's chat (#SHADOW-ACCOUNT-DEBUG). The
    // orphaned-task loop tripped this threshold repeatedly, narrating the same
    // TASK_WORKER_MISSING failure into Shadow's chat. Still counted? No: skip
    // before record() so a quiet-code storm can't even accumulate toward a trip.
    if (QUIET_ERROR_CODES.has(payload.code)) return;
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
  const windowMinutes = windowMs / 60_000;
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
