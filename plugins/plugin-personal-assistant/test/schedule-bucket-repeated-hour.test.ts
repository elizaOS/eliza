/**
 * Replays the device syncs of quint/ScheduleBucketRepeatedHour.qnt through the
 * production schedule sync (LifeOpsService.ingestScheduleObservations, the
 * handler of POST /api/lifeops/schedule/observations) on a PGlite-backed
 * runtime, and reads the device's stored rows back from the repository.
 *
 * The night is 2026-11-01 in America/New_York: at 06:00 UTC local clocks fall
 * back from 02:00 EDT to 01:00 EST, so 01:00 to 02:00 local happens twice.
 * Each sync sends one sleeping row that starts at the sync and lasts 15
 * minutes. The route floors the window start and the snapshot's sleep start
 * to the 30-minute bucket, rounds the window end up and rounds the snapshot's
 * last-active time to the nearest bucket.
 */

import { readFileSync } from "node:fs";
import type { AgentRuntime } from "@elizaos/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRealTestRuntime } from "../../../packages/app/test/helpers/real-runtime.ts";
import { LifeOpsRepository } from "../src/lifeops/repository.js";
import { LifeOpsService } from "../src/lifeops/service.js";

/** One stored row, every time in minutes after 05:00 UTC. */
interface ModelRow {
  start: number;
  end: number;
  sleepStart: number;
  lastActive: number;
  observed: number;
}

/** One sync of the model and the device's stored rows after it. */
interface ModelSync {
  /** Minutes after 05:00 UTC. */
  at: number;
  rows: ModelRow[];
}

/** One device's syncs, in order. */
interface ModelCase {
  syncs: ModelSync[];
}

const TIMEZONE = "America/New_York";
const ROW_MINUTES = 15;
const BASE_MS = Date.parse("2026-11-01T05:00:00.000Z");
const iso = (minutes: number) =>
  new Date(BASE_MS + minutes * 60_000).toISOString();
const minutes = (value: unknown) =>
  typeof value === "string" ? (Date.parse(value) - BASE_MS) / 60_000 : null;

// The first sync lands at 01:30, 01:45 or 01:50 EDT.
const FIRST_SYNCS = [
  ["at 01:30 EDT", 30],
  ["at 01:45 EDT", 45],
  ["at 01:50 EDT", 50],
] as const;

const row = (
  start: number,
  end: number,
  lastActive: number,
  observed: number,
): ModelRow => ({ start, end, sleepStart: start, lastActive, observed });

const DEFAULT_CASES: ModelCase[] = [
  {
    syncs: [
      { at: 30, rows: [row(30, 60, 30, 30)] },
      { at: 40, rows: [row(30, 60, 30, 40)] },
      // 01:00 EST, the first minute of the repeated hour.
      { at: 60, rows: [row(30, 60, 30, 40), row(60, 90, 60, 60)] },
      // 01:15 EST, a rounding tie.
      { at: 75, rows: [row(30, 60, 30, 40), row(60, 90, 90, 75)] },
    ],
  },
  {
    syncs: [
      // 01:45 EDT: the next boundary is 01:00 EST, not 02:00 EST.
      { at: 45, rows: [row(30, 60, 60, 45)] },
      { at: 65, rows: [row(30, 60, 60, 45), row(60, 90, 60, 65)] },
    ],
  },
  {
    syncs: [
      { at: 50, rows: [row(30, 90, 60, 50)] },
      { at: 70, rows: [row(30, 90, 60, 50), row(60, 90, 60, 70)] },
      {
        at: 90,
        rows: [row(30, 90, 60, 50), row(60, 90, 60, 70), row(90, 120, 90, 90)],
      },
      // 01:40 EST, in the repeated hour.
      {
        at: 100,
        rows: [row(30, 90, 60, 50), row(60, 90, 60, 70), row(90, 120, 90, 100)],
      },
    ],
  },
];

const casesFile = process.env.ELIZA_SCHEDULE_BUCKET_MODEL_CASES;
const cases: ModelCase[] = casesFile
  ? JSON.parse(readFileSync(casesFile, "utf8"))
  : DEFAULT_CASES;

let runtime: AgentRuntime;
let service: LifeOpsService;
let cleanup: (() => Promise<void>) | undefined;

beforeAll(async () => {
  ({ runtime, cleanup } = await createRealTestRuntime({
    characterName: "lifeops-schedule-bucket-repeated-hour-agent",
  }));
  await LifeOpsRepository.bootstrapSchema(runtime);
  service = new LifeOpsService(runtime);
}, 120_000);

afterAll(async () => {
  await cleanup?.();
});

/** Sends one sleeping row that starts at `at` from `deviceId`. */
function sync(deviceId: string, at: number) {
  return service.ingestScheduleObservations({
    deviceId,
    deviceKind: "iphone",
    timezone: TIMEZONE,
    observedAt: iso(at),
    observations: [
      {
        observedAt: iso(at),
        circadianState: "sleeping",
        stateConfidence: 0.9,
        windowStartAt: iso(at),
        windowEndAt: iso(at + ROW_MINUTES),
        snapshot: {
          circadianState: "sleeping",
          currentSleepStartedAt: iso(at),
          lastActiveAt: iso(at),
        },
      },
    ],
  });
}

/** The device's stored rows, ordered by start. */
async function storedRows(deviceId: string): Promise<ModelRow[]> {
  const rows = await service.repository.listScheduleObservations(
    runtime.agentId,
    iso(-24 * 60),
    { deviceId },
  );
  return rows
    .map((stored) => {
      const snapshot = (stored.metadata.snapshot ?? {}) as Record<
        string,
        unknown
      >;
      return {
        start: minutes(stored.windowStartAt),
        end: minutes(stored.windowEndAt),
        sleepStart: minutes(snapshot.currentSleepStartedAt),
        lastActive: minutes(snapshot.lastActiveAt),
        observed: minutes(stored.observedAt),
      } as ModelRow;
    })
    .sort((left, right) => left.start - right.start);
}

/** Replays one device's syncs; each case reads only its own device's rows. */
async function replay(item: ModelCase, deviceId: string) {
  const seen: ModelSync[] = [];
  for (const step of item.syncs) {
    await sync(deviceId, step.at);
    seen.push({ at: step.at, rows: await storedRows(deviceId) });
  }
  return seen;
}

describe("schedule bucket repeated hour", () => {
  it("returns the sleep start of a row in the repeated hour", async () => {
    // 06:40 UTC is 01:40 EST, the second time the clock reads 01:40.
    const result = await sync("repeated-hour-merged", 100);
    expect(result.mergedState.currentSleepStartedAt).toBe(iso(90));
    expect(await storedRows("repeated-hour-merged")).toEqual([
      row(90, 120, 90, 100),
    ]);
  }, 120_000);

  it.each(FIRST_SYNCS)(
    "model replays first sync %s",
    async (_name, first) => {
      const group = cases.filter((item) => item.syncs[0]?.at === first);
      expect(group.length).toBeGreaterThan(0);
      for (const item of group) {
        const deviceId = `repeated-hour-${item.syncs.map((step) => step.at).join("-")}`;
        expect(
          { case: item, seen: await replay(item, deviceId) },
          JSON.stringify(item),
        ).toEqual({ case: item, seen: item.syncs });
      }
    },
    600_000,
  );
});
