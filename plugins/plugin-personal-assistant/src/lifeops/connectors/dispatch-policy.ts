/**
 * Runner-side dispatch fallback policy.
 *
 * Pure function. The runner calls {@link decideDispatchPolicy} with each
 * `DispatchResult` from a connector or channel `send` and applies the returned
 * decision against the active `ScheduledTask` escalation ladder.
 *
 * Decision matrix:
 * - `ok: true`                           → `complete`
 * - `userActionable: true` failure       → `surface_degraded` (advance ladder)
 *                                          and surface via the
 *                                          connector-degradation provider.
 * - `retryAfterMinutes` set              → `retry` (do NOT advance ladder).
 * - other failure                        → `advance` (mark current step failed,
 *                                          advance to next step).
 * - last step failed                     → `fail` (state.status = "failed",
 *                                          pipeline.onFail fires).
 */

import type { DispatchResult } from "./contract.js";

/**
 * Decision the runner should apply after a single dispatch attempt.
 *
 * - `complete` — dispatch succeeded; the step is done. The runner records
 *   `messageId` on the task state log if present.
 * - `retry` — reschedule the same step after `retryAfterMinutes`. The ladder
 *   index is NOT advanced. Surface as `retrying` in the state log.
 * - `advance` — the current step is permanently failed. Advance the ladder to
 *   the next step. If no further step exists the runner emits `fail`.
 * - `surface_degraded` — same as `advance`, plus the failure should be
 *   surfaced through the connector-degradation provider (which gates
 *   visibility in subsequent providers; the runner consumes the flag).
 * - `fail` — terminal: every step has failed (or the only step failed without
 *   a retry hint). Runner sets `state.status = "failed"` and fires
 *   `pipeline.onFail`.
 */
export type DispatchPolicyDecision =
  | { kind: "complete"; messageId?: string }
  | {
      kind: "retry";
      retryAfterMinutes: number;
      reason: DispatchFailureReason;
    }
  | {
      kind: "advance";
      reason: DispatchFailureReason;
      message?: string;
    }
  | {
      kind: "surface_degraded";
      reason: DispatchFailureReason;
      message?: string;
    }
  | {
      kind: "fail";
      reason: DispatchFailureReason;
      message?: string;
    };

export type DispatchFailureReason =
  | "disconnected"
  | "rate_limited"
  | "auth_expired"
  | "unknown_recipient"
  | "transport_error";

export interface DispatchPolicyContext {
  /**
   * Zero-based index of the current escalation step that produced this result.
   */
  currentStepIndex: number;

  /**
   * Total number of steps in the active ladder. When
   * `currentStepIndex >= totalSteps - 1` the runner has no further step to
   * advance to and a failure becomes terminal.
   */
  totalSteps: number;

  /**
   * Default backoff applied when a connector reports `rate_limited` without
   * setting `retryAfterMinutes`. Defaults to 5 minutes.
   */
  defaultRetryAfterMinutes?: number;
}

const DEFAULT_RETRY_AFTER_MINUTES = 5;

/**
 * Map a {@link DispatchResult} from a connector or channel `send` into the
 * policy decision the runner should apply.
 */
type DispatchFailure = Extract<DispatchResult, { ok: false }>;

export function decideDispatchPolicy(
  result: DispatchResult,
  context: DispatchPolicyContext,
): DispatchPolicyDecision {
  if (result.ok === true) {
    return { kind: "complete", messageId: result.messageId };
  }

  const failure: DispatchFailure = result;
  const reason = failure.reason;
  const message = failure.message;
  const isLastStep = context.currentStepIndex >= context.totalSteps - 1;

  // Retry-with-backoff dominates: rate-limited or any failure that explicitly
  // sets retryAfterMinutes is treated as a transient failure on the same step.
  if (
    typeof failure.retryAfterMinutes === "number" &&
    failure.retryAfterMinutes > 0
  ) {
    return {
      kind: "retry",
      retryAfterMinutes: failure.retryAfterMinutes,
      reason,
    };
  }
  if (reason === "rate_limited") {
    return {
      kind: "retry",
      retryAfterMinutes:
        context.defaultRetryAfterMinutes ?? DEFAULT_RETRY_AFTER_MINUTES,
      reason,
    };
  }

  // Permanent failure on the last available step → terminal.
  if (isLastStep) {
    return { kind: "fail", reason, message };
  }

  // User-actionable failure (e.g. auth_expired) — advance, but flag for the
  // connector-degradation provider so the user is told what to fix.
  if (failure.userActionable) {
    return { kind: "surface_degraded", reason, message };
  }

  // Generic permanent failure on a non-final step → advance to next step.
  return { kind: "advance", reason, message };
}
