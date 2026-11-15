/**
 * Replays the screen-time sessions of quint/FirstActiveSpanningWake.qnt
 * through the production schedule inspection (LifeOpsService.recordScreenTimeEvent
 * + LifeOpsService.inspectSchedule) on a PGlite-backed runtime.
 *
 * An Oura sleep reading says the owner slept from 23:00 to 07:00 UTC. The
 * owner then uses the phone in sessions through the morning, and the schedule
 * is inspected after each session. The first active moment after the wake is
 * the wake itself while a session spans it, otherwise the start of the first
 * session that begins at or after the wake.
 */

import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { createRealTestRuntime } from "../../../packages/app/test/helpers/real-runtime.ts";
import { LifeOpsRepository } from "../src/lifeops/repository.js";
import { LifeOpsService } from "../src/lifeops/service.js";

/** One session of the model and the first active moment shown after it. */
interface ModelStep {
  /** Minutes after 06:00 UTC on 2026-11-16. */
  start: number;
  end: number;
  /** Minutes after 06:00 UTC, or -1 when no first active moment is shown. */
  shown: number;
}

/** One morning of sessions, in order. */
interface ModelCase {
  steps: ModelStep[];
}

const BASE_MS = Date.parse("2026-11-16T06:00:00.000Z");
const WAKE = 60;
const iso = (minutes: number) =>
  new Date(BASE_MS + minutes * 60_000).toISOString();

// The first session starts 20 minutes before the wake or on it, and lasts 20
// or 40 minutes. (When the first session starts after the reading's wake, the
// sleep cycle takes the wake from that session instead.)
const FIRST_SESSIONS = [
  ["starts 06:40 for 20 min", 40, 60],
  ["starts 06:40 for 40 min", 40, 80],
  ["starts 07:00 for 20 min", 60, 80],
  ["starts 07:00 for 40 min", 60, 100],
] as const;

// One case per first session; the first two are the ones develop got wrong.
const DEFAULT_CASES: ModelCase[] = [
  {
    steps: [
      { start: 40, end: 60, shown: -1 },
      { start: 65, end: 95, shown: 60 },
      { start: 155, end: 185, shown: 60 },
    ],
  },
  {
    steps: [
      { start: 40, end: 80, shown: 60 },
      { start: 140, end: 170, shown: 60 },
    ],
  },
  {
    steps: [
      { start: 60, end: 80, shown: 60 },
      { start: 140, end: 170, shown: 60 },
    ],
  },
  {
    steps: [
      { start: 60, end: 100, shown: 60 },
      { start: 105, end: 135, shown: 60 },
    ],
  },
];

const casesFile = process.env.ELIZA_FIRST_ACTIVE_WAKE_MODEL_CASES;
const cases: ModelCase[] = casesFile
  ? JSON.parse(readFileSync(casesFile, "utf8"))
  : DEFAULT_CASES;

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

/** Records one session and inspects the schedule 10 minutes after it ends. */
async function session(
  service: LifeOpsService,
  index: number,
  start: number,
  end: number,
) {
  await service.recordScreenTimeEvent({
    source: "app",
    identifier: `com.test.session-${index}`,
    displayName: `Session ${index}`,
    startAt: iso(start),
    endAt: iso(end),
    durationSeconds: (end - start) * 60,
    metadata: {},
  });
  const inspection = await service.inspectSchedule({
    timezone: "UTC",
    now: new Date(iso(end + 10)),
  });
  return {
    wakeAt: inspection.insight.wakeAt,
    firstActiveAt: inspection.insight.firstActiveAt,
  };
}

async function replay(item: ModelCase, name: string) {
  const { service, cleanup } = await morning(name);
  try {
    const seen = [];
    for (const [index, step] of item.steps.entries()) {
      const read = await session(service, index, step.start, step.end);
      seen.push({ start: step.start, end: step.end, ...read });
    }
    expect(seen).toEqual(
      item.steps.map((step) => ({
        start: step.start,
        end: step.end,
        wakeAt: iso(WAKE),
        firstActiveAt: step.shown < 0 ? null : iso(step.shown),
      })),
    );
  } finally {
    await cleanup();
  }
}

it("first active stays at the wake when phone use spans it", async () => {
  const { service, cleanup } = await morning("lifeops-first-active-wake");
  try {
    // Phone use in bed runs from 06:40 across the 07:00 wake to 07:20.
    expect(await session(service, 0, 40, 80)).toEqual({
      wakeAt: "2026-11-16T07:00:00.000Z",
      firstActiveAt: "2026-11-16T07:00:00.000Z",
    });
    // A work session from 08:30 must not move the first active moment.
    expect(await session(service, 1, 150, 355)).toEqual({
      wakeAt: "2026-11-16T07:00:00.000Z",
      firstActiveAt: "2026-11-16T07:00:00.000Z",
    });
  } finally {
    await cleanup();
  }
}, 120_000);

it.each(
  FIRST_SESSIONS.map(([name, start, end]) => ({
    name,
    group: cases.filter(
      (item) => item.steps[0]?.start === start && item.steps[0]?.end === end,
    ),
  })),
)(
  "first active model replays first session $name",
  async ({ name, group }) => {
    expect(group.length).toBeGreaterThan(0);
    for (const [index, item] of group.entries()) {
      await replay(item, `lifeops-first-active-${name}-${index}`);
    }
  },
  600_000,
);
