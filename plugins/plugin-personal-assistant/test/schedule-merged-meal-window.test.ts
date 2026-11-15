/**
 * Replays the refresh ticks of quint/MergedMealWindow.qnt through the
 * production local schedule refresh (LifeOpsService.refreshLocalMergedScheduleState)
 * on a PGlite-backed runtime, and reads the next meal back through the
 * production overview (LifeOpsService.getOverview + formatOverview).
 *
 * The telemetry is one observed night (23:30 -> 07:30 UTC) and a morning of
 * activity up to 12:15 UTC, with no lunch seen. Every tick between 13:00 and
 * 14:30 UTC therefore asks the schedule insight for a lunch window that opens
 * at the tick and lasts two hours. The local tick floors the window start to
 * its 30-minute bucket and rounds the end up before it stores the row.
 */

import { readFileSync } from "node:fs";
import type { AgentRuntime } from "@elizaos/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRealTestRuntime } from "../../../packages/app/test/helpers/real-runtime.ts";
import { formatOverview } from "../src/lifeops/google/format-helpers.js";
import { resolveOwnerFactStore } from "../src/lifeops/owner/fact-store.js";
import { LifeOpsRepository } from "../src/lifeops/repository.js";
import { LifeOpsService } from "../src/lifeops/service.js";

/** One refresh of the model and the next meal the merged state must show. */
interface ModelTick {
  /** Minutes after 13:00 UTC. */
  at: number;
  /** Minutes after 13:00 UTC, or -1 when the merged state has no next meal. */
  start: number;
  end: number;
}

/** One device's refresh ticks, in order. */
interface ModelCase {
  ticks: ModelTick[];
}

const BASE_MS = Date.parse("2026-04-19T13:00:00.000Z");
const iso = (minutes: number) =>
  new Date(BASE_MS + minutes * 60_000).toISOString();

// The first tick lands on the bucket, 10 minutes in or 20 minutes in.
const OFFSETS = [
  ["on the bucket", 0],
  ["10 minutes into a bucket", 10],
  ["20 minutes into a bucket", 20],
] as const;

const DEFAULT_CASES: ModelCase[] = [
  {
    ticks: [
      { at: 0, start: 0, end: 120 },
      { at: 20, start: 0, end: 150 },
    ],
  },
  {
    ticks: [
      { at: 10, start: 0, end: 150 },
      { at: 30, start: 30, end: 150 },
    ],
  },
  {
    ticks: [
      { at: 20, start: 0, end: 150 },
      { at: 40, start: 30, end: 180 },
    ],
  },
];

const casesFile = process.env.ELIZA_MERGED_MEAL_WINDOW_MODEL_CASES;
const cases: ModelCase[] = casesFile
  ? JSON.parse(readFileSync(casesFile, "utf8"))
  : DEFAULT_CASES;

let runtime: AgentRuntime;
let service: LifeOpsService;
let cleanup: (() => Promise<void>) | undefined;
const previousDeviceId = process.env.ELIZA_DEVICE_ID;

beforeAll(async () => {
  ({ runtime, cleanup } = await createRealTestRuntime({
    characterName: "lifeops-merged-meal-window-agent",
  }));
  await LifeOpsRepository.bootstrapSchema(runtime);
  service = new LifeOpsService(runtime);
  await resolveOwnerFactStore(runtime).update(
    { timezone: "UTC" },
    { source: "profile_save", recordedAt: new Date().toISOString() },
  );
  await service.recordScreenTimeEvent({
    source: "app",
    identifier: "com.test.evening",
    displayName: "Evening",
    startAt: "2026-04-18T18:00:00.000Z",
    endAt: "2026-04-18T23:30:00.000Z",
    durationSeconds: 5.5 * 60 * 60,
    metadata: {},
  });
  await service.recordScreenTimeEvent({
    source: "app",
    identifier: "com.test.morning",
    displayName: "Morning",
    startAt: "2026-04-19T07:30:00.000Z",
    endAt: "2026-04-19T09:00:00.000Z",
    durationSeconds: 90 * 60,
    metadata: {},
  });
  await service.recordScreenTimeEvent({
    source: "website",
    identifier: "github.com",
    displayName: "GitHub",
    startAt: "2026-04-19T09:40:00.000Z",
    endAt: "2026-04-19T12:15:00.000Z",
    durationSeconds: 155 * 60,
    metadata: {},
  });
  await service.captureActivitySignal({
    source: "mobile_device",
    platform: "mobile_app",
    state: "locked",
    observedAt: "2026-04-18T23:35:00.000Z",
    idleState: "locked",
    idleTimeSeconds: 0,
    onBattery: false,
    metadata: {},
  });
}, 120_000);

afterAll(async () => {
  if (previousDeviceId === undefined) delete process.env.ELIZA_DEVICE_ID;
  else process.env.ELIZA_DEVICE_ID = previousDeviceId;
  await cleanup?.();
});

/** Replays one device's ticks; each case reads only its own device's rows. */
async function replay(item: ModelCase, device: string) {
  process.env.ELIZA_DEVICE_ID = device;
  const seen = [];
  for (const tick of item.ticks) {
    const merged = await service.refreshLocalMergedScheduleState({
      timezone: "UTC",
      now: new Date(iso(tick.at)),
    });
    seen.push({
      at: tick.at,
      nextMealLabel: merged?.nextMealLabel ?? null,
      nextMealWindowStartAt: merged?.nextMealWindowStartAt ?? null,
      nextMealWindowEndAt: merged?.nextMealWindowEndAt ?? null,
      nextMealConfidence: merged?.nextMealConfidence ?? 0,
    });
  }
  return seen;
}

function expected(item: ModelCase) {
  return item.ticks.map((tick) =>
    tick.start < 0
      ? {
          at: tick.at,
          nextMealLabel: null,
          nextMealWindowStartAt: null,
          nextMealWindowEndAt: null,
          nextMealConfidence: 0,
        }
      : {
          at: tick.at,
          nextMealLabel: "lunch",
          nextMealWindowStartAt: iso(tick.start),
          nextMealWindowEndAt: iso(tick.end),
          nextMealConfidence: 0.55,
        },
  );
}

describe("merged meal window", () => {
  it("shows the lunch window that opened inside the current bucket in the overview", async () => {
    process.env.ELIZA_DEVICE_ID = "merged-meal-overview";
    const overview = await service.getOverview(new Date(iso(10)));
    expect(overview.schedule?.nextMealLabel).toBe("lunch");
    expect(overview.schedule?.nextMealWindowStartAt).toBe(iso(0));
    expect(formatOverview(overview)).toContain(
      `- Next lunch window starts ${iso(0)} (55% confidence)`,
    );
  }, 120_000);

  it.each(OFFSETS)(
    "model replays first tick %s",
    async (_name, offset) => {
      const group = cases.filter((item) => item.ticks[0]?.at === offset);
      expect(group.length).toBeGreaterThan(0);
      for (const item of group) {
        const device = `merged-meal-${item.ticks.map((tick) => tick.at).join("-")}`;
        expect(
          { case: item, seen: await replay(item, device) },
          JSON.stringify(item),
        ).toEqual({ case: item, seen: expected(item) });
      }
    },
    600_000,
  );
});
