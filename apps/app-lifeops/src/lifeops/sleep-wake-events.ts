import type { LifeOpsEventKind } from "@elizaos/shared/contracts/lifeops";
import type { LifeOpsScheduleMergedStateRecord } from "./repository.js";

export interface LifeOpsDerivedEvent {
  id: string;
  kind: Exclude<LifeOpsEventKind, "calendar.event.ended">;
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
      phase: args.current.phase,
      wakeAt: args.current.wakeAt,
      bedtimeTargetAt: args.current.relativeTime.bedtimeTargetAt,
      minutesUntilBedtimeTarget:
        args.current.relativeTime.minutesUntilBedtimeTarget,
    },
  };
}

export function deriveSleepWakeEvents(args: {
  previous: LifeOpsScheduleMergedStateRecord | null;
  current: LifeOpsScheduleMergedStateRecord;
  now: Date;
}): LifeOpsDerivedEvent[] {
  const events: LifeOpsDerivedEvent[] = [];
  const currentAsleep = args.current.awakeProbability.pAsleep;
  const currentAwake = args.current.awakeProbability.pAwake;

  if (currentAwake >= 0.65 && args.current.wakeAt) {
    events.push(
      buildEvent({
        kind: "lifeops.wake.detected",
        occurredAt: args.current.wakeAt,
        confidence: currentAwake,
        current: args.current,
        previous: args.previous,
      }),
    );
  }
  if (currentAwake >= 0.8 && args.current.wakeAt) {
    events.push(
      buildEvent({
        kind: "lifeops.wake.confirmed",
        occurredAt: args.current.wakeAt,
        confidence: currentAwake,
        current: args.current,
        previous: args.previous,
      }),
    );
  }
  if (currentAsleep >= 0.65 && args.current.currentSleepStartedAt) {
    events.push(
      buildEvent({
        kind: "lifeops.sleep.started",
        occurredAt: args.current.currentSleepStartedAt,
        confidence: currentAsleep,
        current: args.current,
        previous: args.previous,
      }),
    );
  }
  if (args.current.lastSleepEndedAt) {
    events.push(
      buildEvent({
        kind: "lifeops.sleep.completed",
        occurredAt: args.current.lastSleepEndedAt,
        confidence: args.current.sleepConfidence,
        current: args.current,
        previous: args.previous,
      }),
    );
  }
  const previousMinutesUntilBedtime =
    args.previous?.relativeTime.minutesUntilBedtimeTarget ?? null;
  const currentMinutesUntilBedtime =
    args.current.relativeTime.minutesUntilBedtimeTarget;
  if (
    currentAwake >= 0.65 &&
    currentMinutesUntilBedtime !== null &&
    currentMinutesUntilBedtime >= 0 &&
    currentMinutesUntilBedtime <= 30 &&
    (previousMinutesUntilBedtime === null || previousMinutesUntilBedtime > -120)
  ) {
    const occurredAtMs = parseIsoMs(args.current.relativeTime.bedtimeTargetAt);
    events.push(
      buildEvent({
        kind: "lifeops.bedtime.imminent",
        occurredAt:
          occurredAtMs !== null
            ? new Date(occurredAtMs).toISOString()
            : args.now.toISOString(),
        confidence: args.current.relativeTime.confidence,
        current: args.current,
        previous: args.previous,
      }),
    );
  }
  return events;
}
