/**
 * Tests for the scheduleStyle/chronotype owner-fact learner (issue #12284,
 * WI-5): the pure classification (style mapping, rotating cluster detection,
 * chronotype thresholds) and the full writer path over the real fact store
 * (in-memory runtime cache), including the user-override and idempotency
 * contracts. Episodes are synthesized in UTC so local-minute math is exact.
 */

import type { IAgentRuntime, UUID } from "@elizaos/core";
import type { SleepRegularityEpisodeLike } from "@elizaos/plugin-health";
import { describe, expect, it } from "vitest";
import {
  createOwnerFactStore,
  registerOwnerFactStore,
  resolveOwnerFactStore,
} from "./fact-store.js";
import {
  buildScheduleStyleSample,
  deriveChronotype,
  deriveScheduleStyle,
  detectRotatingWakePattern,
} from "./schedule-style.js";
import { learnScheduleStyleFromEpisodes } from "./schedule-style-writer.js";

function makeCacheRuntime(): IAgentRuntime {
  const cache = new Map<string, unknown>();
  return {
    agentId: "33333333-3333-3333-3333-333333333333" as UUID,
    async getCache<T>(key: string): Promise<T | null> {
      const value = cache.get(key);
      return value === undefined ? null : (value as T);
    },
    async setCache<T>(key: string, value: T): Promise<boolean> {
      cache.set(key, value);
      return true;
    },
    async deleteCache(key: string): Promise<boolean> {
      return cache.delete(key);
    },
  } as unknown as IAgentRuntime;
}

function makeRuntimeWithStore(): IAgentRuntime {
  const runtime = makeCacheRuntime();
  registerOwnerFactStore(runtime, createOwnerFactStore(runtime));
  return runtime;
}

const NOW = new Date("2026-07-10T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1_000;

/**
 * One overnight episode per day ending `daysAgo` days before NOW, sleeping
 * from `bedHour` (previous evening, may exceed 24 for after-midnight) until
 * `wakeHour`, with optional per-episode minute offsets to inject jitter.
 */
function episode(args: {
  daysAgo: number;
  bedHour: number;
  wakeHour: number;
  jitterMin?: number;
}): SleepRegularityEpisodeLike {
  const wakeDayStart = Date.UTC(2026, 6, 10, 0, 0, 0) - args.daysAgo * DAY_MS;
  const jitterMs = (args.jitterMin ?? 0) * 60_000;
  const wakeMs = wakeDayStart + args.wakeHour * 3_600_000 + jitterMs;
  const bedMs = wakeDayStart - DAY_MS + args.bedHour * 3_600_000 + jitterMs;
  return {
    startAt: new Date(bedMs).toISOString(),
    endAt: new Date(wakeMs).toISOString(),
    cycleType: "overnight",
  };
}

function regularWeek(): SleepRegularityEpisodeLike[] {
  // Ten near-identical nights, 23:00 → 07:00 UTC.
  return Array.from({ length: 10 }, (_, index) =>
    episode({ daysAgo: index + 1, bedHour: 23, wakeHour: 7 }),
  );
}

function chaoticWeek(): SleepRegularityEpisodeLike[] {
  // Wake/bed times scattered across many hours with no two tight clusters.
  const wakes = [5.5, 8.2, 11, 6.7, 9.3, 12.5, 7.8, 10.1];
  const beds = [21, 25, 23.5, 26.5, 22, 24.5, 27, 23];
  return wakes.map((wakeHour, index) =>
    episode({
      daysAgo: index + 1,
      bedHour: beds[index] as number,
      wakeHour,
    }),
  );
}

function rotatingShifts(): SleepRegularityEpisodeLike[] {
  // Two shift blocks: four nights sleeping 23:00→07:00, then four "days"
  // sleeping 11:00→19:00 — the classic rotating pattern.
  const nights = Array.from({ length: 4 }, (_, index) =>
    episode({ daysAgo: index + 1, bedHour: 23, wakeHour: 7 }),
  );
  const days = Array.from({ length: 4 }, (_, index) =>
    episode({ daysAgo: index + 5, bedHour: 35, wakeHour: 19 }),
  );
  return [...nights, ...days];
}

describe("detectRotatingWakePattern (pure)", () => {
  it("detects two tight wake clusters far apart", () => {
    const wakes = [420, 421, 419, 425, 1140, 1141, 1138, 1145];
    expect(detectRotatingWakePattern(wakes)).toBe(true);
  });

  it("rejects a single tight cluster", () => {
    expect(detectRotatingWakePattern([418, 420, 422, 425, 430])).toBe(false);
  });

  it("rejects scattered wake times without cluster structure", () => {
    expect(
      detectRotatingWakePattern([330, 492, 660, 402, 558, 750, 468, 606]),
    ).toBe(false);
  });

  it("rejects clusters that wrap midnight only when loose", () => {
    // Tight cluster straddling midnight (23:50–00:10) + tight noon cluster:
    // still rotating; the wraparound arc math must not split the first.
    expect(
      detectRotatingWakePattern([1430, 1435, 5, 10, 720, 722, 725, 728]),
    ).toBe(true);
  });

  it("requires at least two samples per cluster", () => {
    expect(detectRotatingWakePattern([420, 421, 422, 1140])).toBe(false);
  });
});

describe("deriveScheduleStyle / deriveChronotype (pure)", () => {
  it("classifies a consistent sleeper as regular", () => {
    const sample = buildScheduleStyleSample({
      episodes: regularWeek(),
      timezone: "UTC",
      nowMs: NOW.getTime(),
    });
    expect(deriveScheduleStyle(sample)).toBe("regular");
  });

  it("classifies a chaotic sleeper as irregular", () => {
    const sample = buildScheduleStyleSample({
      episodes: chaoticWeek(),
      timezone: "UTC",
      nowMs: NOW.getTime(),
    });
    expect(deriveScheduleStyle(sample)).toBe("irregular");
  });

  it("classifies block-rotating shifts as rotating", () => {
    const sample = buildScheduleStyleSample({
      episodes: rotatingShifts(),
      timezone: "UTC",
      nowMs: NOW.getTime(),
    });
    expect(deriveScheduleStyle(sample)).toBe("rotating");
  });

  it("returns null below the evidence threshold", () => {
    const sample = buildScheduleStyleSample({
      episodes: regularWeek().slice(0, 3),
      timezone: "UTC",
      nowMs: NOW.getTime(),
    });
    expect(deriveScheduleStyle(sample)).toBeNull();
  });

  it("ignores naps and open episodes when collecting wake minutes", () => {
    const sample = buildScheduleStyleSample({
      episodes: [
        ...regularWeek(),
        {
          startAt: "2026-07-09T13:00:00.000Z",
          endAt: "2026-07-09T14:00:00.000Z",
          cycleType: "nap",
        },
        {
          startAt: "2026-07-09T23:00:00.000Z",
          endAt: null,
          cycleType: "overnight",
        },
      ],
      timezone: "UTC",
      nowMs: NOW.getTime(),
    });
    expect(sample.wakeMinutesLocal).toHaveLength(10);
  });

  it("maps mid-sleep to early / intermediate / late chronotypes", () => {
    const baseline = {
      medianSleepDurationMin: 480,
      bedtimeStddevMin: 10,
      wakeStddevMin: 10,
      sampleCount: 10,
      windowDays: 28,
    };
    // Bed 21:00 wake 05:00 → mid-sleep 01:00.
    expect(
      deriveChronotype({
        ...baseline,
        medianBedtimeLocalHour: 21,
        medianWakeLocalHour: 5,
      }),
    ).toBe("early");
    // Bed 23:00 wake 07:00 → mid-sleep 03:00.
    expect(
      deriveChronotype({
        ...baseline,
        medianBedtimeLocalHour: 23,
        medianWakeLocalHour: 7,
      }),
    ).toBe("intermediate");
    // Bed 03:00 (27 normalized) wake 11:00 → mid-sleep 07:00.
    expect(
      deriveChronotype({
        ...baseline,
        medianBedtimeLocalHour: 27,
        medianWakeLocalHour: 11,
      }),
    ).toBe("late");
    expect(deriveChronotype(null)).toBeNull();
  });
});

describe("learnScheduleStyleFromEpisodes (writer over the real store)", () => {
  it("writes an irregular persona's scheduleStyle with agent_inferred provenance", async () => {
    const runtime = makeRuntimeWithStore();
    const result = await learnScheduleStyleFromEpisodes(
      runtime,
      { episodes: chaoticWeek(), timezone: "UTC" },
      NOW,
    );
    expect(result.wrote).toBe(true);
    expect(result.scheduleStyle).toBe("irregular");
    expect(result.updated).toContain("scheduleStyle");

    const facts = await resolveOwnerFactStore(runtime).read();
    expect(facts.scheduleStyle?.value).toBe("irregular");
    expect(facts.scheduleStyle?.provenance.source).toBe("agent_inferred");
  });

  it("writes regular + chronotype for a consistent persona", async () => {
    const runtime = makeRuntimeWithStore();
    const result = await learnScheduleStyleFromEpisodes(
      runtime,
      { episodes: regularWeek(), timezone: "UTC" },
      NOW,
    );
    expect(result.wrote).toBe(true);
    expect(result.scheduleStyle).toBe("regular");
    // Bed 23:00 wake 07:00 → mid-sleep 03:00 → intermediate.
    expect(result.chronotype).toBe("intermediate");

    const facts = await resolveOwnerFactStore(runtime).read();
    expect(facts.scheduleStyle?.value).toBe("regular");
    expect(facts.chronotype?.value).toBe("intermediate");
  });

  it("classifies rotating shifts and skips the chronotype artifact", async () => {
    const runtime = makeRuntimeWithStore();
    const result = await learnScheduleStyleFromEpisodes(
      runtime,
      { episodes: rotatingShifts(), timezone: "UTC" },
      NOW,
    );
    expect(result.wrote).toBe(true);
    expect(result.scheduleStyle).toBe("rotating");
    expect(result.chronotype).toBeNull();

    const facts = await resolveOwnerFactStore(runtime).read();
    expect(facts.scheduleStyle?.value).toBe("rotating");
    expect(facts.chronotype).toBeUndefined();
  });

  it("is idempotent: an unchanged classification writes nothing", async () => {
    const runtime = makeRuntimeWithStore();
    const first = await learnScheduleStyleFromEpisodes(
      runtime,
      { episodes: regularWeek(), timezone: "UTC" },
      NOW,
    );
    expect(first.wrote).toBe(true);
    const second = await learnScheduleStyleFromEpisodes(
      runtime,
      { episodes: regularWeek(), timezone: "UTC" },
      NOW,
    );
    expect(second.wrote).toBe(false);
    expect(second.updated).toEqual([]);
  });

  it("updates when the classification meaningfully changes", async () => {
    const runtime = makeRuntimeWithStore();
    await learnScheduleStyleFromEpisodes(
      runtime,
      { episodes: regularWeek(), timezone: "UTC" },
      NOW,
    );
    const shifted = await learnScheduleStyleFromEpisodes(
      runtime,
      { episodes: chaoticWeek(), timezone: "UTC" },
      NOW,
    );
    expect(shifted.wrote).toBe(true);
    const facts = await resolveOwnerFactStore(runtime).read();
    expect(facts.scheduleStyle?.value).toBe("irregular");
  });

  it("never clobbers a user-owned scheduleStyle", async () => {
    const runtime = makeRuntimeWithStore();
    const store = resolveOwnerFactStore(runtime);
    await store.update(
      { scheduleStyle: "regular" },
      { source: "first_run", recordedAt: "2026-07-01T00:00:00.000Z" },
    );
    const result = await learnScheduleStyleFromEpisodes(
      runtime,
      { episodes: chaoticWeek(), timezone: "UTC" },
      NOW,
    );
    expect(result.scheduleStyle).toBe("irregular");
    const facts = await store.read();
    expect(facts.scheduleStyle?.value).toBe("regular");
    expect(facts.scheduleStyle?.provenance.source).toBe("first_run");
  });

  it("writes nothing on insufficient evidence and keeps the store empty", async () => {
    const runtime = makeRuntimeWithStore();
    const result = await learnScheduleStyleFromEpisodes(
      runtime,
      { episodes: regularWeek().slice(0, 3), timezone: "UTC" },
      NOW,
    );
    expect(result.wrote).toBe(false);
    expect(result.scheduleStyle).toBeNull();
    const facts = await resolveOwnerFactStore(runtime).read();
    expect(facts.scheduleStyle).toBeUndefined();
    expect(facts.chronotype).toBeUndefined();
  });
});
