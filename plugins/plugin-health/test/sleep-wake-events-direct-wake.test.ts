import { expect, it } from "vitest";
import { deriveSleepWakeEvents } from "../src/sleep/sleep-wake-events.js";

const now = new Date("2026-10-19T09:15:00.000Z");

function state(
  circadianState: string,
  extra: Record<string, unknown> = {},
): never {
  return {
    id: `state-${circadianState}`,
    agentId: "agent-1",
    circadianState,
    stateConfidence: 0.9,
    uncertaintyReason: null,
    sleepConfidence: 0.93,
    currentSleepStartedAt: null,
    wakeAt: null,
    lastSleepEndedAt: null,
    awakeProbability: { pAwake: 0.9, pAsleep: 0.05, pUnknown: 0.05 },
    regularity: { regularityClass: "regular" },
    relativeTime: {
      minutesUntilBedtimeTarget: null,
      bedtimeTargetAt: null,
      confidence: 0.5,
    },
    inferredAt: now.toISOString(),
    ...extra,
  } as never;
}

const awakeAfterLateWake = state("awake", {
  wakeAt: "2026-10-19T07:00:00.000Z",
  lastSleepEndedAt: "2026-10-19T07:00:00.000Z",
});

it("observes, confirms and ends the sleep on a direct sleeping -> awake change", () => {
  // A wake reported late skips "waking", which needs a recent wake.
  const events = deriveSleepWakeEvents({
    previous: state("sleeping", {
      currentSleepStartedAt: "2026-10-18T23:00:00.000Z",
    }),
    current: awakeAfterLateWake,
    now,
  });

  expect(events.map((event) => event.kind)).toEqual([
    "lifeops.wake.observed",
    "lifeops.wake.confirmed",
    "lifeops.sleep.ended",
  ]);
});

it("keeps waking -> awake as confirm and end only", () => {
  const events = deriveSleepWakeEvents({
    previous: state("waking", { wakeAt: "2026-10-19T07:00:00.000Z" }),
    current: awakeAfterLateWake,
    now,
  });

  expect(events.map((event) => event.kind)).toEqual([
    "lifeops.wake.confirmed",
    "lifeops.sleep.ended",
  ]);
});
