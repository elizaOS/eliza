/**
 * Replays the days of quint/NextMealDinnerWindow.qnt through the production
 * schedule inspection (LifeOpsService.recordScreenTimeEvent +
 * LifeOpsService.inspectSchedule) on a PGlite-backed runtime.
 *
 * An Oura sleep reading says the owner woke at 07:00 UTC. The owner uses the
 * phone all day and puts it down for breakfast (08:00 to 08:35), maybe for
 * lunch (12:15 to 12:50) and maybe for dinner (18:15 to 18:50). The schedule
 * is inspected every hour from 09:00 to 23:00 and reports the next meal.
 * A lunch that was skipped is not the next meal once the dinner window
 * (17:00 to 22:00) has opened.
 */

import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { createRealTestRuntime } from "../../../packages/app/test/helpers/real-runtime.ts";
import { LifeOpsRepository } from "../src/lifeops/repository.js";
import { LifeOpsService } from "../src/lifeops/service.js";

type MealLabel = "breakfast" | "lunch" | "dinner";

/** One hourly inspection of the model and the next meal it reports. */
interface ModelStep {
  /** Hour of 2026-11-16 (UTC) at which the schedule is inspected. */
  hour: number;
  /** The next meal reported, or null when none is due. */
  shown: MealLabel | null;
}

/** One day: which meals the owner ate, and every inspection in order. */
interface ModelCase {
  lunch: boolean;
  dinner: boolean;
  steps: ModelStep[];
}

const DAY_MS = Date.parse("2026-11-16T00:00:00.000Z");
const iso = (minutes: number) =>
  new Date(DAY_MS + minutes * 60_000).toISOString();
const MEAL_WINDOW_HOURS: Record<MealLabel, number> = {
  breakfast: 4,
  lunch: 2,
  dinner: 3,
};

const DAYS = [
  ["lunch eaten, dinner eaten", true, true],
  ["lunch eaten, dinner skipped", true, false],
  ["lunch skipped, dinner eaten", false, true],
  ["lunch skipped, dinner skipped", false, false],
] as const;

/** The next meal the model reports at each hour from 09:00 to 23:00. */
function expectedDay(lunch: boolean, dinner: boolean): ModelCase {
  const shown = (hour: number): MealLabel | null => {
    if (hour < 11) return null;
    if (hour < 17) return lunch && hour >= 13 ? null : "lunch";
    if (hour < 19) return "dinner";
    return dinner ? null : "dinner";
  };
  const steps = [];
  for (let hour = 9; hour <= 23; hour += 1) {
    steps.push({ hour, shown: shown(hour) });
  }
  return { lunch, dinner, steps };
}

const casesFile = process.env.ELIZA_NEXT_MEAL_MODEL_CASES;
const cases: ModelCase[] = casesFile
  ? JSON.parse(readFileSync(casesFile, "utf8"))
  : DAYS.map(([, lunch, dinner]) => expectedDay(lunch, dinner));

/** A fresh agent with the evening before and the Oura reading of the night. */
async function morning(name: string) {
  const testRuntime = await createRealTestRuntime({ characterName: name });
  await LifeOpsRepository.bootstrapSchema(testRuntime.runtime);
  const service = new LifeOpsService(testRuntime.runtime);
  await service.recordScreenTimeEvent({
    source: "app",
    identifier: "com.test.evening",
    displayName: "Evening",
    startAt: "2026-11-15T18:00:00.000Z",
    endAt: "2026-11-15T22:30:00.000Z",
    durationSeconds: 4.5 * 60 * 60,
    metadata: {},
  });
  await service.captureActivitySignal({
    source: "mobile_health",
    platform: "mobile_app",
    state: "idle",
    observedAt: "2026-11-16T07:05:00.000Z",
    idleState: null,
    idleTimeSeconds: null,
    onBattery: null,
    health: {
      source: "oura",
      permissions: { sleep: true, biometrics: false },
      sleep: {
        available: true,
        isSleeping: false,
        asleepAt: "2026-11-15T23:00:00.000Z",
        awakeAt: "2026-11-16T07:00:00.000Z",
        durationMinutes: 480,
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
  return { service, cleanup: testRuntime.cleanup };
}

/**
 * The phone sessions of the hour that ends at `hour`:00. Breakfast, lunch and
 * dinner each leave a 35-minute gap between two sessions.
 */
function sessionsUntil(
  hour: number,
  lunch: boolean,
  dinner: boolean,
): Array<[number, number]> {
  const end = hour * 60;
  if (hour === 9) {
    return [
      [7 * 60, 8 * 60],
      [8 * 60 + 35, end],
    ];
  }
  if (hour === 13 && lunch) {
    return [
      [12 * 60, 12 * 60 + 15],
      [12 * 60 + 50, end],
    ];
  }
  if (hour === 19 && dinner) {
    return [
      [18 * 60, 18 * 60 + 15],
      [18 * 60 + 50, end],
    ];
  }
  return [[end - 60, end]];
}

/** Records the hour's phone use and inspects the schedule at its end. */
async function inspectAt(
  service: LifeOpsService,
  hour: number,
  lunch: boolean,
  dinner: boolean,
) {
  for (const [start, end] of sessionsUntil(hour, lunch, dinner)) {
    await service.recordScreenTimeEvent({
      source: "app",
      identifier: `com.test.session-${start}`,
      displayName: `Session ${start}`,
      startAt: iso(start),
      endAt: iso(end),
      durationSeconds: (end - start) * 60,
      metadata: {},
    });
  }
  const { insight } = await service.inspectSchedule({
    timezone: "UTC",
    now: new Date(iso(hour * 60)),
  });
  return {
    hour,
    meals: insight.meals.map((meal) => meal.label),
    nextMealLabel: insight.nextMealLabel,
    nextMealWindowStartAt: insight.nextMealWindowStartAt,
    nextMealWindowEndAt: insight.nextMealWindowEndAt,
  };
}

/** The meals detected by `hour`:00 and the next meal the model reports. */
function expectedRead(item: ModelCase, step: ModelStep) {
  const meals: MealLabel[] = ["breakfast"];
  if (item.lunch && step.hour >= 13) meals.push("lunch");
  if (item.dinner && step.hour >= 19) meals.push("dinner");
  const now = step.hour * 60;
  return {
    hour: step.hour,
    meals,
    nextMealLabel: step.shown,
    nextMealWindowStartAt: step.shown === null ? null : iso(now),
    nextMealWindowEndAt:
      step.shown === null
        ? null
        : iso(now + MEAL_WINDOW_HOURS[step.shown] * 60),
  };
}

async function replay(item: ModelCase, name: string) {
  const { service, cleanup } = await morning(name);
  try {
    const seen = [];
    for (const step of item.steps) {
      seen.push(await inspectAt(service, step.hour, item.lunch, item.dinner));
    }
    expect(seen).toEqual(item.steps.map((step) => expectedRead(item, step)));
  } finally {
    await cleanup();
  }
}

it("next meal is dinner once a skipped lunch meets the dinner window", async () => {
  const { service, cleanup } = await morning("lifeops-next-meal-dinner");
  try {
    for (let hour = 9; hour < 19; hour += 1) {
      await inspectAt(service, hour, false, false);
    }
    // Breakfast only, and the owner is still on the phone at 19:00.
    expect(await inspectAt(service, 19, false, false)).toEqual({
      hour: 19,
      meals: ["breakfast"],
      nextMealLabel: "dinner",
      nextMealWindowStartAt: "2026-11-16T19:00:00.000Z",
      nextMealWindowEndAt: "2026-11-16T22:00:00.000Z",
    });
  } finally {
    await cleanup();
  }
}, 120_000);

it.each(
  DAYS.map(([name, lunch, dinner]) => ({
    name,
    group: cases.filter(
      (item) => item.lunch === lunch && item.dinner === dinner,
    ),
  })),
)(
  "next meal model replays $name",
  async ({ name, group }) => {
    expect(group.length).toBeGreaterThan(0);
    for (const [index, item] of group.entries()) {
      await replay(item, `lifeops-next-meal-${name}-${index}`);
    }
  },
  600_000,
);
