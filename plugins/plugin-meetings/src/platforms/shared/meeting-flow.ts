/**
 * Shared meeting flow — drives one `PlatformStrategies` object through the full
 * bot lifecycle, with no per-platform branching. Faithful port of Vexa's
 * runMeetingFlow (services/vexa-bot/core/src/platforms/shared/meetingFlow.ts),
 * adapted to elizaOS's typed contract:
 *
 *   join → (waitForAdmission ∥ prepare) → active
 *        → race(startRecording, removalMonitor, abort-signal graceful leave)
 *        → leave → MeetingEndReason
 *
 * Expected outcomes are returned as `MeetingEndReason` — the flow throws only
 * for unexpected failures (the adapter maps those to "error"). During the
 * active race the flow passes the strategies a session whose signal is linked
 * to BOTH the user abort and an internal controller, so when any racer resolves
 * the others are aborted and stop polling.
 */

import type { Page } from "playwright-core";
import { logger } from "@elizaos/core";
import type { MeetingEndReason } from "@elizaos/shared";
import type { MeetingBotSession } from "../../types.js";
import type { PlatformStrategies } from "./strategy.js";

/** Post-admission false-positive re-verification delay (Vexa waits ~1s). */
const ADMISSION_SETTLE_MS = 1_000;

/**
 * Wrap a session so racers observe a signal that fires on the user abort OR the
 * internal flow-complete abort. Returned `session` shares everything else with
 * the original.
 */
function linkedSession(session: MeetingBotSession, controller: AbortController): MeetingBotSession {
  if (session.signal.aborted) controller.abort();
  else session.signal.addEventListener("abort", () => controller.abort(), { once: true });
  return new Proxy(session, {
    get(target, prop, receiver) {
      if (prop === "signal") return controller.signal;
      return Reflect.get(target, prop, receiver);
    },
  });
}

/** Resolve when `signal` aborts (graceful-stop racer). */
function abortReason(signal: AbortSignal): Promise<MeetingEndReason> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve("requested_stop");
      return;
    }
    signal.addEventListener("abort", () => resolve("requested_stop"), { once: true });
  });
}

export interface RunMeetingFlowArgs {
  page: Page;
  session: MeetingBotSession;
  strategies: PlatformStrategies;
  /** Waiting-room admission timeout (ms). */
  waitingRoomTimeoutMs: number;
}

export async function runMeetingFlow(args: RunMeetingFlowArgs): Promise<MeetingEndReason> {
  const { page, session, strategies, waitingRoomTimeoutMs } = args;

  // ── Join ──────────────────────────────────────────────────────────────────
  session.reportStatus("joining");
  try {
    await strategies.join(page, session);
  } catch (err) {
    logger.error(
      { error: err instanceof Error ? err.message : String(err) },
      "[MeetingFlow] join failed",
    );
    return "join_failed";
  }

  if (session.signal.aborted) {
    await strategies.leave(page);
    return "requested_stop";
  }

  // ── Admission ∥ prepare ─────────────────────────────────────────────────────
  session.reportStatus("awaiting_admission");
  const [admission] = await Promise.all([
    strategies.waitForAdmission(page, session, waitingRoomTimeoutMs),
    strategies.prepare(page, session),
  ]);

  if (admission === "rejected") {
    logger.info("[MeetingFlow] admission rejected by host");
    return "admission_rejected";
  }
  if (admission === "timeout") {
    logger.info("[MeetingFlow] admission timed out");
    await strategies.leave(page);
    return "admission_timeout";
  }

  // Give the state machine a beat, then re-verify we are actually in the call
  // (guards against a false-positive admission signal).
  await new Promise((r) => setTimeout(r, ADMISSION_SETTLE_MS));
  if (!(await strategies.checkAdmissionSilent(page))) {
    logger.warn("[MeetingFlow] admission false positive — not in meeting after settle");
    await strategies.leave(page);
    return "join_failed";
  }

  if (session.signal.aborted) {
    await strategies.leave(page);
    return "requested_stop";
  }

  // ── Active: race recording vs removal vs abort ──────────────────────────────
  session.reportStatus("active");
  const raceController = new AbortController();
  const raced = linkedSession(session, raceController);

  let reason: MeetingEndReason;
  try {
    reason = await Promise.race([
      strategies.startRecording(page, raced),
      strategies.startRemovalMonitor(page, raced),
      abortReason(raced.signal),
    ]);
  } catch (err) {
    raceController.abort();
    logger.error(
      { error: err instanceof Error ? err.message : String(err) },
      "[MeetingFlow] unexpected failure during active phase",
    );
    await strategies.leave(page);
    throw err instanceof Error ? err : new Error(String(err));
  }

  // Stop the losing racers, then leave.
  raceController.abort();
  session.reportStatus("leaving");
  await strategies.leave(page);
  logger.info({ reason }, "[MeetingFlow] meeting ended");
  return reason;
}
