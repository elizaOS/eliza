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
 * desktop side, we validate complete free-form text at the shared boundary,
 * publish via `logger.info({ evt, ... })`, and rely on the log-capture pipeline.
 */

import { logger } from "@elizaos/core";
import {
  assertComputerUseTrajectoryText,
  buildComputerUseAgentStepTrajectoryPayload,
  type ComputerUseAgentStepTrajectoryPayload,
} from "../trajectory-text.js";

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
  /** Complete free-form error message. */
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

export type AndroidTrajectoryStepEvent = ComputerUseAgentStepTrajectoryPayload;

/**
 * Emit a `computeruse.android.action` log entry. Returns the payload so
 * callers can also forward it elsewhere (e.g. in-memory replay buffer).
 */
export function emitAndroidAction(
  event: AndroidTrajectoryActionEvent,
): AndroidTrajectoryActionEvent {
  const payload: AndroidTrajectoryActionEvent = { ...event };
  assertComputerUseTrajectoryText("errorCode", payload.errorCode);
  assertComputerUseTrajectoryText("errorMessage", payload.errorMessage);
  assertComputerUseTrajectoryText("ref", payload.ref);
  assertComputerUseTrajectoryText("rationale", payload.rationale);
  logger.info(
    {
      evt: "computeruse.android.action",
      platform: "android" as const,
      ...payload,
    },
    `[computeruse/android] ${payload.kind}${payload.success ? "" : ` failed (${payload.errorCode ?? "?"})`}`,
  );
  return payload;
}

/**
 * Emit a `computeruse.agent.step` log entry tagged with `platform:"android"`.
 * The shape mirrors what the desktop loop emits in `use-computer-agent.ts`
 * so the trajectory logger can union the two streams.
 */
export function emitAndroidAgentStep(
  event: AndroidTrajectoryStepEvent,
): AndroidTrajectoryStepEvent {
  const payload = buildComputerUseAgentStepTrajectoryPayload(event);
  logger.info(
    {
      evt: "computeruse.agent.step",
      platform: "android" as const,
      ...payload,
    },
    `[computeruse/agent/android] step ${payload.step}: ${payload.actionKind}`,
  );
  return payload;
}
