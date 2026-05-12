import type {
  LifeOpsCircadianState,
  LifeOpsEventKind,
  LifeOpsRegularityClass,
  LifeOpsScheduleInsight,
  LifeOpsScheduleSleepStatus,
  LifeOpsUnclearReason,
} from "../contracts/health.js";
import { parseIsoMs } from "../util/time-util.js";

/**
 * Structural shape of `LifeOpsScheduleMergedState` (declared in
 * `app-lifeops/src/lifeops/schedule-sync-contracts.ts`) restricted to the
 * fields this module reads. Defined locally to keep plugin-health independent
 * of app-lifeops' schedule-sync repository layer; app-lifeops feeds compatible
 * objects in via the call-site.
 */
export interface LifeOpsScheduleMergedStateRecord
  extends LifeOpsScheduleInsight {
  id: string;
  agentId: string;
}

/**
 * Typed payload for every circadian-state event emitted from the scheduler
 * tick. Every field is derived from the merged state record, and must not
 * contain `unknown` / `any` (per repo rule).
 */
interface LifeOpsDerivedEventPayload {
  currentStateId: string;
  previousStateId: string | null;
  sleepStatus: LifeOpsScheduleSleepStatus;
  circadianState: LifeOpsCircadianState;
  stateConfidence: number;
  uncertaintyReason: LifeOpsUnclearReason | null;
  regularityClass: LifeOpsRegularityClass;
  wakeAt: string | null;
  bedtimeTargetAt: string | null;
  minutesUntilBedtimeTarget: number | null;
}

export interface LifeOpsDerivedEvent {
  id: string;
  kind: Exclude<
    LifeOpsEventKind,
    | "calendar.event.ended"
    | "gmail.message.received"
    | "gmail.thread.needs_response"
  >;
  occurredAt: string;
  confidence: number;
  payload: LifeOpsDerivedEventPayload;
}

function buildEvent(args: {
  kind: LifeOpsDerivedEvent["kind"];
  occurredAt: string;
  confidence: number;
  current: LifeOpsScheduleMergedStateRecord;
  previous: LifeOpsScheduleMergedStateRecord | null;
}): LifeOpsDerivedEvent {
  return {
    id: `${args.kind}:${args.current.agentId}:${args.occurredAt}`,
    kind: args.kind,
    occurredAt: args.occurredAt,
    confidence: args.confidence,
    payload: {
      currentStateId: args.current.id,
      previousStateId: args.previous?.id ?? null,
      sleepStatus: args.current.sleepStatus,
      circadianState: args.current.circadianState,
      stateConfidence: args.current.stateConfidence,
      uncertaintyReason: args.current.uncertaintyReason,
      regularityClass: args.current.regularity.regularityClass,
      wakeAt: args.current.wakeAt,
      bedtimeTargetAt: args.current.relativeTime.bedtimeTargetAt,
      minutesUntilBedtimeTarget:
        args.current.relativeTime.minutesUntilBedtimeTarget,
    },
  };
}

function isAsleepState(state: LifeOpsCircadianState): boolean {
  return state === "sleeping" || state === "napping";
}

function isAwakeState(state: LifeOpsCircadianState): boolean {
  return state === "awake" || state === "waking";
}

/**
 * Edge-triggered circadian event derivation per `sleep-wake-spec.md`:
 * - Events fire only on state transitions, never on stable ticks.
 * - `wake.observed` fires on sleeping/napping -> waking transitions.
 * - `wake.confirmed` fires on waking -> awake transitions (paired with sleep.ended).
 * - `sleep.onset_candidate` fires on awake/winding_down -> (onset) transitions
 *   when the state machine starts the SLEEP_ONSET_WINDOW. For this interim
 *   adapter we fire it alongside sleep.detected since the scorer rewrite
 *   (scorer_rewrite todo) is where the dedicated onset candidate state lives.
 * - `sleep.detected` fires on any -> sleeping transition.
 * - `nap.detected` fires on any -> napping transition.
 * - `bedtime.imminent` fires once when minutesUntilBedtimeTarget crosses
 *   from >30 to <=30 with a future target.
 * - `regularity.changed` fires on regularityClass transitions.
 */
export function deriveSleepWakeEvents(args: {
  previous: LifeOpsScheduleMergedStateRecord | null;
  current: LifeOpsScheduleMergedStateRecord;
  now: Date;
}): LifeOpsDerivedEvent[] {
  const events: LifeOpsDerivedEvent[] = [];
  const current = args.current;
  const previous = args.previous;
  const currentState = current.circadianState;
  const previousState = previous?.circadianState ?? null;
  const stateChanged = previousState !== currentState;

  if (stateChanged) {
    // sleep.onset_candidate + sleep.detected on any -> sleeping edge
    if (currentState === "sleeping" && current.currentSleepStartedAt) {
      events.push(
        buildEvent({
          kind: "lifeops.sleep.onset_candidate",
          occurredAt: current.currentSleepStartedAt,
          confidence: current.sleepConfidence,
          current,
          previous,
        }),
      );
      events.push(
        buildEvent({
          kind: "lifeops.sleep.detected",
          occurredAt: current.currentSleepStartedAt,
          confidence: current.sleepConfidence,
          current,
          previous,
        }),
      );
    }

    // nap.detected on any -> napping edge
    if (currentState === "napping" && current.currentSleepStartedAt) {
      events.push(
        buildEvent({
          kind: "lifeops.nap.detected",
          occurredAt: current.currentSleepStartedAt,
          confidence: current.sleepConfidence,
          current,
          previous,
        }),
      );
    }

    // wake.observed on (sleeping|napping) -> waking edge
    if (
      currentState === "waking" &&
      previousState !== null &&
      isAsleepState(previousState) &&
      current.wakeAt
    ) {
      events.push(
        buildEvent({
          kind: "lifeops.wake.observed",
          occurredAt: current.wakeAt,
          confidence: current.awakeProbability.pAwake,
          current,
          previous,
        }),
      );
    }

    // wake.confirmed + sleep.ended on waking -> awake edge
    if (
      currentState === "awake" &&
      previousState === "waking" &&
      current.wakeAt
    ) {
      events.push(
        buildEvent({
          kind: "lifeops.wake.confirmed",
          occurredAt: current.wakeAt,
          confidence: current.awakeProbability.pAwake,
          current,
          previous,
        }),
      );
      if (current.lastSleepEndedAt) {
        events.push(
          buildEvent({
            kind: "lifeops.sleep.ended",
            occurredAt: current.lastSleepEndedAt,
            confidence: current.sleepConfidence,
            current,
            previous,
          }),
        );
      }
    }

    // Note: cold-boot (no previous state) does not synthesize any circadian
    // event. The first tick landed in its scored state because the
    // stability-window gate bypassed when priorState was null; the next
    // real transition will emit the appropriate edge-triggered event.
  }

  // bedtime.imminent — edge-triggered when minutesUntilBedtimeTarget crosses
  // into the [0, 30] window from above.
  const previousMinutesUntilBedtime =
    previous?.relativeTime.minutesUntilBedtimeTarget ?? null;
  const currentMinutesUntilBedtime =
    current.relativeTime.minutesUntilBedtimeTarget;
  const nowInBedtimeWindow =
    currentMinutesUntilBedtime !== null &&
    currentMinutesUntilBedtime >= 0 &&
    currentMinutesUntilBedtime <= 30;
  const wasOutsideWindow =
    previousMinutesUntilBedtime === null || previousMinutesUntilBedtime > 30;
  if (nowInBedtimeWindow && wasOutsideWindow && isAwakeState(currentState)) {
    const occurredAtMs = parseIsoMs(current.relativeTime.bedtimeTargetAt);
    events.push(
      buildEvent({
        kind: "lifeops.bedtime.imminent",
        occurredAt:
          occurredAtMs !== null
            ? new Date(occurredAtMs).toISOString()
            : args.now.toISOString(),
        confidence: current.relativeTime.confidence,
        current,
        previous,
      }),
    );
  }

  // regularity.changed — edge-triggered on regularityClass transitions.
  const previousClass = previous?.regularity.regularityClass ?? null;
  const currentClass = current.regularity.regularityClass;
  if (previousClass !== null && previousClass !== currentClass) {
    events.push(
      buildEvent({
        kind: "lifeops.regularity.changed",
        occurredAt: current.inferredAt,
        confidence: current.stateConfidence,
        current,
        previous,
      }),
    );
  }

  return events;
}
