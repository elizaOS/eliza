/**
 * WS8 — Trajectory event emission for Android actions.
 *
 * The WS7 `use-computer-agent` action emits `computeruse.agent.step`
 * structured-log entries for every Brain→dispatch step. We re-use the same
 * event name on Android so the eliza-1 trajectory logger sees a uniform
 * shape across platforms — the only delta is a `platform: "android"` tag
 * the logger can use for per-platform breakdowns.
 *
 * Two flavors of event are surfaced from the Android surface:
 *
 *   - `computeruse.agent.step`     — emitted by the agent loop (already in
 *                                    use-computer-agent.ts). On Android we
 *                                    add `platform: "android"` to the
 *                                    payload via this helper.
 *   - `computeruse.android.action` — emitted for direct
 *                                    `dispatchGesture` / `performGlobalAction`
 *                                    invocations not going through the agent
 *                                    loop (e.g. when the planner picks a
 *                                    lower-level action explicitly).
 *
 * We do not depend on `@elizaos/plugin-trajectory-logger` here — like the
 * desktop side, we publish via `logger.info({ evt, ... })` and rely on the
 * log-capture pipeline.
 */

import { logger } from "@elizaos/core";

export type AndroidActionKind =
  | "tap"
  | "swipe"
  | "back"
  | "home"
  | "recents"
  | "notifications"
  | "capture"
  | "screenshot";

export interface AndroidTrajectoryActionEvent {
  kind: AndroidActionKind;
  success: boolean;
  /** Bridge error code (only on failure). */
  errorCode?: string;
  /** Free-form error message; trimmed for log hygiene. */
  errorMessage?: string;
  /** Display-local pixel coords for tap/swipe (optional). */
  x?: number;
  y?: number;
  x2?: number;
  y2?: number;
  durationMs?: number;
  /** Stable AX/OCR id the action targeted, when known. */
  ref?: string;
  /** Free-form rationale from the planner. */
  rationale?: string;
}

export interface AndroidTrajectoryStepEvent {
  step: number;
  goal: string;
  actionKind: string;
  displayId: number;
  rois: number;
  success: boolean;
  error?: string;
  rationale: string;
}

const MAX_ERROR_MSG = 256;

/**
 * Emit a `computeruse.android.action` log entry. Returns the payload so
 * callers can also forward it elsewhere (e.g. in-memory replay buffer).
 */
export function emitAndroidAction(
  event: AndroidTrajectoryActionEvent,
): AndroidTrajectoryActionEvent {
  const trimmed: AndroidTrajectoryActionEvent = { ...event };
  if (trimmed.errorMessage) {
    trimmed.errorMessage = trimmed.errorMessage.slice(0, MAX_ERROR_MSG);
  }
  logger.info(
    {
      evt: "computeruse.android.action",
      platform: "android" as const,
      ...trimmed,
    },
    `[computeruse/android] ${trimmed.kind}${trimmed.success ? "" : ` failed (${trimmed.errorCode ?? "?"})`}`,
  );
  return trimmed;
}

/**
 * Emit a `computeruse.agent.step` log entry tagged with `platform:"android"`.
 * The shape mirrors what the desktop loop emits in `use-computer-agent.ts`
 * so the trajectory logger can union the two streams.
 */
export function emitAndroidAgentStep(
  event: AndroidTrajectoryStepEvent,
): AndroidTrajectoryStepEvent {
  logger.info(
    {
      evt: "computeruse.agent.step",
      platform: "android" as const,
      step: event.step,
      goal: event.goal,
      actionKind: event.actionKind,
      displayId: event.displayId,
      rois: event.rois,
      success: event.success,
      error: event.error,
      rationale: event.rationale,
    },
    `[computeruse/agent/android] step ${event.step}: ${event.actionKind}`,
  );
  return event;
}
