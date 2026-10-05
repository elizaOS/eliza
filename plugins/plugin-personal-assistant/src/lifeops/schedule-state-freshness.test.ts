import { expect, it } from "vitest";
import {
  mergeScheduleObservations,
  recordsFromSyncRequest,
  scheduleObservationSyncInput,
} from "./schedule-state";

const now = new Date("2026-09-29T14:00:00Z");
function observation(
  state: "sleeping" | "waking" | "awake",
  at: string,
  device = "one",
) {
  return recordsFromSyncRequest({
    agentId: "qa",
    origin: "local_inference",
    request: {
      deviceId: device,
      deviceKind: "mac",
      timezone: "UTC",
      observedAt: at,
      observations: [
        {
          circadianState: state,
          stateConfidence: 0.98,
          windowStartAt: at,
          windowEndAt: null,
          snapshot: {
            circadianState: state,
            currentSleepStartedAt: state === "sleeping" ? at : null,
            lastSleepEndedAt: state !== "sleeping" ? at : null,
          },
        },
      ],
    },
  });
}
const merge = (observations: ReturnType<typeof observation>) =>
  mergeScheduleObservations({
    agentId: "qa",
    scope: "local",
    timezone: "UTC",
    now,
    observations,
  });
it("expires old open-ended sleep without resurrecting it over a current wake", () => {
  const rows = [
    ...observation("sleeping", "2026-09-27T09:00:00Z"),
    ...observation("waking", "2026-09-29T13:30:00Z"),
  ];
  const before = JSON.stringify(rows);
  expect(merge(rows)).toMatchObject({
    circadianState: "waking",
    currentSleepStartedAt: null,
  });
  expect(JSON.stringify(rows)).toBe(before);
});
it("uses the same device's newer state, while retaining fresh sleep from another device", () => {
  const sleep = observation("sleeping", "2026-09-29T13:00:00Z");
  const wake = observation("awake", "2026-09-29T13:30:00Z");
  expect(merge([...sleep, ...wake])).toMatchObject({
    circadianState: "awake",
    currentSleepStartedAt: null,
  });
  expect(
    merge([...sleep, ...observation("awake", "2026-09-29T13:30:00Z", "two")])
      ?.circadianState,
  ).toBe("sleeping");
});
it("preserves a fresh authoritative sleep and does not globally favor waking", () => {
  expect(
    merge([
      ...observation("awake", "2026-09-29T13:00:00Z"),
      ...observation("sleeping", "2026-09-29T13:30:00Z"),
    ])?.circadianState,
  ).toBe("sleeping");
  expect(
    merge(observation("sleeping", "2026-09-29T13:30:00Z"))?.sleepStatus,
  ).toBe("sleeping_now");
});
it("does not let same-time wake or later meal projection override a fresh sleep decision", () => {
  const sleep = observation("sleeping", "2026-09-29T13:30:00Z");
  const sameTimeWake = observation("awake", "2026-09-29T13:30:00Z");
  expect(merge([...sleep, ...sameTimeWake])?.circadianState).toBe("sleeping");
  const meal = observation("awake", "2026-09-29T13:45:00Z").map((row) => ({
    ...row,
    mealLabel: "lunch" as const,
  }));
  expect(merge([...sleep, ...meal])?.circadianState).toBe("sleeping");
});
it("expires stale open-ended sleep without requiring a replacement signal", () => {
  expect(merge(observation("sleeping", "2026-09-27T09:00:00Z"))).toBeNull();
});

it("retains sleep authority across devices even at equal timestamps", () => {
  expect(
    merge([
      ...observation("sleeping", "2026-09-29T13:30:00Z", "manual-device"),
      ...observation("awake", "2026-09-29T13:30:00Z", "other-device"),
    ])?.circadianState,
  ).toBe("sleeping");
});

it("does not resurrect superseded sleep when the newer waking observation expires", () => {
  const rows = [
    ...observation("sleeping", "2026-09-29T08:00:00Z"),
    ...observation("waking", "2026-09-29T11:00:00Z"),
  ];
  const before = structuredClone(rows);
  expect(merge(rows)).toMatchObject({
    circadianState: "unclear",
    currentSleepStartedAt: null,
    stateConfidence: 0,
  });
  expect(rows).toEqual(before);
  expect(
    merge([...rows, ...observation("awake", "2026-09-29T13:00:00Z", "two")]),
  ).toMatchObject({ circadianState: "awake", currentSleepStartedAt: null });
});

it("keeps fresh unknown decisions and future signals from resurrecting or suppressing current sleep", () => {
  const sleep = observation("sleeping", "2026-09-29T13:00:00Z");
  const unknown = observation("awake", "2026-09-29T13:30:00Z").map((row) => ({
    ...row,
    circadianState: "unclear" as const,
    uncertaintyReason: "contradictory_signals" as const,
  }));
  expect(merge([...sleep, ...unknown])).toMatchObject({
    circadianState: "unclear",
    currentSleepStartedAt: null,
    uncertaintyReason: "contradictory_signals",
  });
  expect(
    merge([...sleep, ...observation("awake", "2026-09-29T15:00:00Z")])
      ?.circadianState,
  ).toBe("sleeping");
});

/**
 * The Cloud path: a device replays its stored local rows through
 * `scheduleObservationSyncInput` in one batch sent at `now`, and the Cloud
 * agent ingests them as `device_sync` rows and merges them.
 */
function syncToCloud(rows: ReturnType<typeof observation>) {
  return recordsFromSyncRequest({
    agentId: "qa",
    origin: "device_sync",
    request: {
      deviceId: "one",
      deviceKind: "mac",
      timezone: "UTC",
      observedAt: now.toISOString(),
      observations: rows.map(scheduleObservationSyncInput),
    },
  });
}
const mergeCloud = (observations: ReturnType<typeof observation>) =>
  mergeScheduleObservations({
    agentId: "qa",
    scope: "cloud",
    timezone: "UTC",
    now,
    observations,
  });
/** A stored local state row whose insight also forecasts the next meal. */
function withMealForecast(rows: ReturnType<typeof observation>) {
  return rows.map((row) => ({
    ...row,
    mealLabel: null,
    metadata: {
      ...row.metadata,
      snapshot: {
        ...(row.metadata.snapshot as Record<string, unknown>),
        nextMealLabel: "breakfast",
      },
    },
  }));
}

it("a synced batch keeps each row's own time, so replayed sleep does not beat the newer wake", () => {
  const local = [
    ...observation("sleeping", "2026-09-29T07:00:00Z"),
    ...observation("waking", "2026-09-29T13:30:00Z"),
  ];
  expect(merge(local)?.circadianState).toBe("waking");
  const cloud = syncToCloud(local);
  expect(cloud.map((row) => Date.parse(row.observedAt))).toEqual([
    Date.parse("2026-09-29T07:00:00Z"),
    Date.parse("2026-09-29T13:30:00Z"),
  ]);
  expect(mergeCloud(cloud)).toMatchObject({
    circadianState: "waking",
    currentSleepStartedAt: null,
  });
});

it("a synced state row does not adopt its snapshot's meal forecast as its own label", () => {
  const local = [
    ...observation("sleeping", "2026-09-29T07:00:00Z"),
    ...withMealForecast(observation("waking", "2026-09-29T13:30:00Z")),
  ];
  expect(merge(local)?.circadianState).toBe("waking");
  const cloud = syncToCloud(local);
  expect(cloud.map((row) => row.mealLabel)).toEqual([null, null]);
  expect(mergeCloud(cloud)).toMatchObject({
    circadianState: "waking",
    currentSleepStartedAt: null,
  });
});

it("an explicit meal row keeps its label through sync", () => {
  const meal = observation("awake", "2026-09-29T12:00:00Z").map((row) => ({
    ...row,
    mealLabel: "lunch" as const,
  }));
  expect(syncToCloud(meal).map((row) => row.mealLabel)).toEqual(["lunch"]);
});

it("a row time after the batch send time falls back to the send time", () => {
  const [record] = recordsFromSyncRequest({
    agentId: "qa",
    origin: "device_sync",
    request: {
      deviceId: "one",
      deviceKind: "mac",
      timezone: "UTC",
      observedAt: now.toISOString(),
      observations: [
        {
          observedAt: "2026-09-29T15:00:00Z",
          circadianState: "awake",
          stateConfidence: 0.9,
          windowStartAt: "2026-09-29T13:30:00Z",
        },
      ],
    },
  });
  expect(Date.parse(record?.observedAt ?? "")).toBe(now.getTime());
});
