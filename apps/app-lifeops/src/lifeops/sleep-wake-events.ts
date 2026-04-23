import type {
  LifeOpsCircadianState,
  LifeOpsEventKind,
} from "@elizaos/shared/contracts/lifeops";
import type { LifeOpsScheduleMergedStateRecord } from "./repository.js";

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
  payload: Record<string, unknown>;
}

function parseIsoMs(value: string | null | undefined): number | null {
  if (typeof value !== "string" || value.trim().length === 0) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
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

    // Cold-boot case: if there's no previous state at all and we land in
    // awake with a recent wakeAt, treat it as a wake.confirmed for
    // downstream automations (audit will record the cold-boot path).
    if (
      previousState === null &&
      currentState === "awake" &&
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
    previousMinutesUntilBedtime === null ||
    previousMinutesUntilBedtime > 30;
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
