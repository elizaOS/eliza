/**
 * Replays the nights of quint/OpenNightDayKey.qnt through the production
 * schedule inspection (LifeOpsService.captureActivitySignal +
 * LifeOpsService.inspectSchedule) on a PGlite-backed runtime.
 *
 * An Oura ring reports a sleep in progress while the owner sleeps and the
 * finished sleep once the owner wakes. The schedule is inspected once before
 * the sleep, every hour while it lasts and once after the wake. A sleep in
 * progress reads as a nap for its first four hours, but the effective day key
 * must not change while the owner sleeps: an overnight sleep keeps the day
 * that was open when it started until the wake.
 */

import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { createRealTestRuntime } from "../../../packages/app/test/helpers/real-runtime.ts";
import { LifeOpsRepository } from "../src/lifeops/repository.js";
import { LifeOpsService } from "../src/lifeops/service.js";

/** One inspection of the model and the day key it shows. */
interface ModelStep {
  /** Minutes after 12:00 UTC on 2026-11-15. */
  at: number;
  /** 0 for 2026-11-15, 1 for 2026-11-16. */
  day: number;
}

/** One night: the earlier sleep, tonight's sleep and its inspections. */
interface ModelCase {
  /** An Oura reading of the night before (23:00 to 07:00) is stored. */
  prior: boolean;
  /** Minutes after 12:00 UTC on 2026-11-15. */
  onset: number;
  length: number;
  steps: ModelStep[];
}

const BASE_MS = Date.parse("2026-11-15T12:00:00.000Z");
const DAYS = ["2026-11-15", "2026-11-16"];
const iso = (minutes: number) =>
  new Date(BASE_MS + minutes * 60_000).toISOString();

const ONSETS = [
  ["14:00", 120],
  ["21:00", 540],
  ["23:00", 660],
  ["00:30", 750],
  ["02:00", 840],
] as const;

/** The inspection times of a night: before, every hour asleep, after. */
function inspectionTimes(onset: number, length: number): number[] {
  const times = [onset - 30];
  for (let at = onset + 30; at < onset + length; at += 60) times.push(at);
  times.push(onset + length + 25);
  return times;
}

// Without the generated cases, the nights develop got wrong after an earlier
// overnight sleep, each with its expected day keys.
const DEFAULT_CASES: ModelCase[] = [
  {
    prior: true,
    onset: 540,
    length: 480,
    steps: inspectionTimes(540, 480).map((at, index, all) => ({
      at,
      day: index === all.length - 1 ? 1 : 0,
    })),
  },
  {
    prior: true,
    onset: 660,
    length: 120,
    steps: inspectionTimes(660, 120).map((at) => ({ at, day: 0 })),
  },
  {
    prior: true,
    onset: 750,
    length: 480,
    steps: inspectionTimes(750, 480).map((at, index, all) => ({
      at,
      day: index === all.length - 1 ? 1 : 0,
    })),
  },
  {
    prior: true,
    onset: 840,
    length: 480,
    steps: inspectionTimes(840, 480).map((at, index, all) => ({
      at,
      day: index === all.length - 1 ? 1 : 0,
    })),
  },
];

const casesFile = process.env.ELIZA_OPEN_NIGHT_DAY_KEY_MODEL_CASES;
const cases: ModelCase[] = casesFile
  ? JSON.parse(readFileSync(casesFile, "utf8"))
  : DEFAULT_CASES;

/** Stores one Oura reading through the production capture path. */
async function reading(
  service: LifeOpsService,
  args: {
    observedAt: number;
    state: "active" | "idle" | "sleeping";
    isSleeping: boolean;
    asleepAt: number;
    awakeAt: number | null;
  },
) {
  await service.captureActivitySignal({
    source: "mobile_health",
    platform: "mobile_app",
    state: args.state,
    observedAt: iso(args.observedAt),
    idleState: null,
    idleTimeSeconds: null,
    onBattery: null,
    health: {
      source: "oura",
      permissions: { sleep: true, biometrics: false },
      sleep: {
        available: true,
        isSleeping: args.isSleeping,
        asleepAt: iso(args.asleepAt),
        awakeAt: args.awakeAt === null ? null : iso(args.awakeAt),
        durationMinutes:
          args.awakeAt === null ? null : args.awakeAt - args.asleepAt,
        stage: null,
      },
      biometrics: {
        sampleAt: null,
        heartRateBpm: null,
        restingHeartRateBpm: null,
        heartRateVariabilityMs: null,
        respiratoryRate: null,
        bloodOxygenPercent: null,
      },
      warnings: [],
    },
    metadata: {},
  });
}

/**
 * Replays one night on a fresh agent and returns the effective day key of
 * every inspection.
 */
async function replayNight(
  name: string,
  prior: boolean,
  onset: number,
  length: number,
  times: number[],
) {
  const testRuntime = await createRealTestRuntime({ characterName: name });
  try {
    await LifeOpsRepository.bootstrapSchema(testRuntime.runtime);
    const service = new LifeOpsService(testRuntime.runtime);
    if (prior) {
      // The night before: 23:00 to 07:00, read at 07:05 on 2026-11-15.
      await reading(service, {
        observedAt: -295,
        state: "idle",
        isSleeping: false,
        asleepAt: -780,
        awakeAt: -300,
      });
    }
    const wake = onset + length;
    const seen = [];
    for (const at of times) {
      if (at > wake) {
        // The ring reports the finished sleep 5 minutes after the wake.
        await reading(service, {
          observedAt: wake + 5,
          state: "active",
          isSleeping: false,
          asleepAt: onset,
          awakeAt: wake,
        });
      } else if (at > onset) {
        // The ring reports the sleep in progress 5 minutes before each read.
        await reading(service, {
          observedAt: at - 5,
          state: "sleeping",
          isSleeping: true,
          asleepAt: onset,
          awakeAt: null,
        });
      }
      const inspection = await service.inspectSchedule({
        timezone: "UTC",
        now: new Date(iso(at)),
      });
      seen.push({ at, day: inspection.insight.effectiveDayKey });
    }
    return seen;
  } finally {
    await testRuntime.cleanup();
  }
}

it("the day stays open through one overnight sleep", async () => {
  // Asleep 23:00 to 07:00 after an earlier night that ended 07:00 on 11-15.
  const times = inspectionTimes(660, 480);
  const seen = await replayNight(
    "lifeops-open-night-day-key",
    true,
    660,
    480,
    times,
  );
  expect(seen).toEqual(
    times.map((at, index) => ({
      at,
      day: index === times.length - 1 ? "2026-11-16" : "2026-11-15",
    })),
  );
}, 120_000);

it.each(
  [true, false].flatMap((prior) =>
    ONSETS.map(([clock, onset]) => ({
      name: `${prior ? "after a night" : "first night"}, sleep ${clock}`,
      group: cases.filter(
        (item) => item.prior === prior && item.onset === onset,
      ),
    })),
  ),
)(
  "open night model replays $name",
  async ({ name, group }) => {
    // Without generated cases only the nights develop got wrong run.
    if (!casesFile && group.length === 0) return;
    expect(group.length).toBeGreaterThan(0);
    for (const [index, item] of group.entries()) {
      const seen = await replayNight(
        `lifeops-open-night-${name}-${index}`,
        item.prior,
        item.onset,
        item.length,
        item.steps.map((step) => step.at),
      );
      expect({ length: item.length, seen }).toEqual({
        length: item.length,
        seen: item.steps.map((step) => ({ at: step.at, day: DAYS[step.day] })),
      });
    }
  },
  600_000,
);
