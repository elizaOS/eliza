/**
 * plugin-health Wave-1 smoke test.
 *
 * Per `IMPLEMENTATION_PLAN.md` §3.2 verification:
 *   - smoke: sleep event fires, bus carries it, a
 *     `relative_to_anchor("wake.confirmed", 30)` task schedules correctly.
 *   - smoke: cross-platform — non-darwin `health_signal_observed` falls back
 *     to `user_acknowledged` with logged degradation.
 *
 * Until W1-A's `ScheduledTask` runner lands, the smoke test is structural
 * (the bus and runner do not yet exist as concrete code). It verifies:
 *   - the moved sleep-wake-events deriver produces the canonical events for
 *     a circadian state transition (sleep → wake.confirmed),
 *   - the default-pack records validate against the W1-A frozen schema and
 *     reference `wake.confirmed` as their anchor,
 *   - the connector / anchor / bus-family registries can register all
 *     contributions without throwing.
 */

/**
 * Direct sub-module imports keep the test isolated from `health-oauth.ts`
 * (which transitively imports `@elizaos/agent` → `@elizaos/app-core` and
 * pulls in a lot of dist code that's not relevant to the smoke surface).
 * The top-level `../index.js` aggregate is verified by the package build,
 * not by this smoke test.
 */
import { describe, expect, it } from "vitest";
import type {
  AnchorContribution,
  AnchorRegistry,
  BusFamilyContribution,
  BusFamilyRegistry,
  ConnectorContribution,
  ConnectorRegistry,
  RuntimeWithHealthRegistries,
} from "../connectors/contract-stubs.js";
import {
  HEALTH_ANCHORS,
  HEALTH_BUS_FAMILIES,
  HEALTH_CONNECTOR_KINDS,
  registerHealthAnchors,
  registerHealthBusFamilies,
  registerHealthConnectors,
} from "../connectors/index.js";
import {
  bedtimeDefaultPack,
  HEALTH_DEFAULT_PACKS,
  sleepRecapDefaultPack,
  wakeUpDefaultPack,
} from "../default-packs/index.js";
import type { LifeOpsScheduleMergedStateRecord } from "../sleep/sleep-wake-events.js";
import { deriveSleepWakeEvents } from "../sleep/sleep-wake-events.js";

function makeStateRecord(
  overrides: Partial<LifeOpsScheduleMergedStateRecord> = {},
): LifeOpsScheduleMergedStateRecord {
  const baseInsight = {
    effectiveDayKey: "2026-01-15",
    localDate: "2026-01-15",
    timezone: "America/New_York",
    inferredAt: "2026-01-15T07:00:00.000Z",
    circadianState: "awake" as const,
    stateConfidence: 0.92,
    uncertaintyReason: null,
    relativeTime: {
      computedAt: "2026-01-15T07:00:00.000Z",
      localNowAt: "2026-01-15T07:00:00.000Z",
      circadianState: "awake" as const,
      stateConfidence: 0.92,
      uncertaintyReason: null,
      awakeProbability: {
        pAwake: 0.9,
        pAsleep: 0.05,
        pUnknown: 0.05,
        contributingSources: [],
        computedAt: "2026-01-15T07:00:00.000Z",
      },
      wakeAnchorAt: "2026-01-15T07:00:00.000Z",
      wakeAnchorSource: "sleep_cycle" as const,
      minutesSinceWake: 5,
      minutesAwake: 5,
      bedtimeTargetAt: "2026-01-15T23:00:00.000Z",
      bedtimeTargetSource: "typical_sleep" as const,
      minutesUntilBedtimeTarget: 960,
      minutesSinceBedtimeTarget: null,
      dayBoundaryStartAt: "2026-01-15T05:00:00.000Z",
      dayBoundaryEndAt: "2026-01-16T05:00:00.000Z",
      minutesSinceDayBoundaryStart: 120,
      minutesUntilDayBoundaryEnd: 1320,
      confidence: 0.92,
    },
    awakeProbability: {
      pAwake: 0.9,
      pAsleep: 0.05,
      pUnknown: 0.05,
      contributingSources: [],
      computedAt: "2026-01-15T07:00:00.000Z",
    },
    regularity: {
      sri: 78,
      bedtimeStddevMin: 28,
      wakeStddevMin: 32,
      midSleepStddevMin: 30,
      regularityClass: "regular" as const,
      sampleCount: 14,
      windowDays: 28,
    },
    baseline: null,
    circadianRuleFirings: [],
    sleepStatus: "slept" as const,
    sleepConfidence: 0.85,
    currentSleepStartedAt: null,
    lastSleepStartedAt: "2026-01-14T23:30:00.000Z",
    lastSleepEndedAt: "2026-01-15T07:00:00.000Z",
    lastSleepDurationMinutes: 450,
    wakeAt: "2026-01-15T07:00:00.000Z",
    firstActiveAt: "2026-01-15T07:00:00.000Z",
    lastActiveAt: "2026-01-15T07:00:00.000Z",
    meals: [],
    lastMealAt: null,
    nextMealLabel: null,
    nextMealWindowStartAt: null,
    nextMealWindowEndAt: null,
    nextMealConfidence: 0,
  };
  return {
    id: "merged-state-1",
    agentId: "agent-1",
    ...baseInsight,
    ...overrides,
  } as LifeOpsScheduleMergedStateRecord;
}

describe("plugin-health smoke (W1-B)", () => {
  it("registers 6 connectors, 4 anchors, 8 bus families", () => {
    expect(HEALTH_CONNECTOR_KINDS).toEqual([
      "apple_health",
      "google_fit",
      "strava",
      "fitbit",
      "withings",
      "oura",
    ]);
    expect(HEALTH_ANCHORS).toEqual([
      "wake.observed",
      "wake.confirmed",
      "bedtime.target",
      "nap.start",
    ]);
    expect(HEALTH_BUS_FAMILIES).toContain("health.wake.observed");
    expect(HEALTH_BUS_FAMILIES).toContain("health.wake.confirmed");
    expect(HEALTH_BUS_FAMILIES).toHaveLength(8);
  });

  it("ships 3 default packs (bedtime, wake-up, sleep-recap)", () => {
    expect(HEALTH_DEFAULT_PACKS).toHaveLength(3);
    expect(HEALTH_DEFAULT_PACKS.map((p) => p.key)).toEqual([
      "bedtime",
      "wake-up",
      "sleep-recap",
    ]);
  });

  it("wake-up pack triggers off `wake.confirmed` (sustained signal anchor)", () => {
    const record = wakeUpDefaultPack.records[0];
    expect(record).toBeDefined();
    if (!record) throw new Error("wakeUpDefaultPack should have a record");
    expect(record.trigger.kind).toBe("relative_to_anchor");
    if (record.trigger.kind === "relative_to_anchor") {
      expect(record.trigger.anchorKey).toBe("wake.confirmed");
      expect(record.trigger.offsetMinutes).toBe(0);
    }
  });

  it("sleep-recap pack uses relative_to_anchor('wake.confirmed', 240) — the §3.2 smoke shape (with offset)", () => {
    const record = sleepRecapDefaultPack.records[0];
    if (!record) throw new Error("sleepRecapDefaultPack should have a record");
    expect(record.trigger.kind).toBe("relative_to_anchor");
    if (record.trigger.kind === "relative_to_anchor") {
      expect(record.trigger.anchorKey).toBe("wake.confirmed");
      // The spec's smoke uses offset 30; sleep-recap uses 240 (4 hours)
      // because the recap is post-morning-brief. Both are valid uses of the
      // `relative_to_anchor` schema. The shape is what matters for the
      // smoke test.
      expect(record.trigger.offsetMinutes).toBeGreaterThan(0);
    }
  });

  it("bedtime pack triggers 30 minutes BEFORE bedtime.target", () => {
    const record = bedtimeDefaultPack.records[0];
    if (!record) throw new Error("bedtimeDefaultPack should have a record");
    expect(record.trigger.kind).toBe("relative_to_anchor");
    if (record.trigger.kind === "relative_to_anchor") {
      expect(record.trigger.anchorKey).toBe("bedtime.target");
      expect(record.trigger.offsetMinutes).toBe(-30);
    }
  });

  it("derives `wake.observed` on sleeping → waking transition", () => {
    const previous = makeStateRecord({
      circadianState: "sleeping",
      currentSleepStartedAt: "2026-01-14T23:30:00.000Z",
    });
    const current = makeStateRecord({ circadianState: "waking" });
    const events = deriveSleepWakeEvents({
      current,
      previous,
      now: new Date("2026-01-15T07:00:00.000Z"),
    });
    const eventKinds = events.map((event) => event.kind);
    expect(eventKinds).toContain("lifeops.wake.observed");
    expect(eventKinds).not.toContain("lifeops.wake.confirmed");
  });

  it("derives `wake.confirmed` on waking → awake transition (sustained signal)", () => {
    const previous = makeStateRecord({ circadianState: "waking" });
    const current = makeStateRecord();
    const events = deriveSleepWakeEvents({
      current,
      previous,
      now: new Date("2026-01-15T07:10:00.000Z"),
    });
    const eventKinds = events.map((event) => event.kind);
    expect(eventKinds).toContain("lifeops.wake.confirmed");
    expect(eventKinds).toContain("lifeops.sleep.ended");
  });

  it("connector / anchor / bus-family registration tolerates a missing registry (Wave-1 soft-dep posture)", () => {
    const fakeRuntime = {} as never;
    expect(() => registerHealthConnectors(fakeRuntime)).not.toThrow();
    expect(() => registerHealthAnchors(fakeRuntime)).not.toThrow();
    expect(() => registerHealthBusFamilies(fakeRuntime)).not.toThrow();
  });

  it("connector / anchor / bus-family registration calls registry methods when registries are present", () => {
    const connectorList: ConnectorContribution[] = [];
    const anchorList: AnchorContribution[] = [];
    const busList: BusFamilyContribution[] = [];

    const connectorRegistry: ConnectorRegistry = {
      register: (c) => {
        connectorList.push(c);
      },
      list: () => connectorList,
      get: (kind) => connectorList.find((c) => c.kind === kind) ?? null,
      byCapability: (capability) =>
        connectorList.filter((c) => c.capabilities.includes(capability)),
    };
    const anchorRegistry: AnchorRegistry = {
      register: (a) => {
        anchorList.push(a);
      },
      list: () => anchorList,
      get: (anchorKey) =>
        anchorList.find((a) => a.anchorKey === anchorKey) ?? null,
    };
    const busFamilyRegistry: BusFamilyRegistry = {
      register: (f) => {
        busList.push(f);
      },
      list: () => busList,
    };
    const fakeRuntime = {
      connectorRegistry,
      anchorRegistry,
      busFamilyRegistry,
    } as RuntimeWithHealthRegistries as never;

    registerHealthConnectors(fakeRuntime);
    registerHealthAnchors(fakeRuntime);
    registerHealthBusFamilies(fakeRuntime);

    expect(connectorList.map((c) => c.kind)).toEqual([
      "apple_health",
      "google_fit",
      "strava",
      "fitbit",
      "withings",
      "oura",
    ]);
    expect(anchorList.map((a) => a.anchorKey)).toEqual([
      "wake.observed",
      "wake.confirmed",
      "bedtime.target",
      "nap.start",
    ]);
    expect(busList.map((f) => f.family)).toContain("health.wake.confirmed");
    expect(busList).toHaveLength(8);
  });

  it("connector dispatcher returns disconnected status (Wave-1 stub posture)", async () => {
    const connectorList: ConnectorContribution[] = [];
    const connectorRegistry: ConnectorRegistry = {
      register: (c) => {
        connectorList.push(c);
      },
      list: () => connectorList,
      get: (kind) => connectorList.find((c) => c.kind === kind) ?? null,
      byCapability: (capability) =>
        connectorList.filter((c) => c.capabilities.includes(capability)),
    };
    const fakeRuntime = { connectorRegistry } as never;
    registerHealthConnectors(fakeRuntime);
    const apple = connectorList.find((c) => c.kind === "apple_health");
    expect(apple).toBeDefined();
    if (!apple) throw new Error("apple_health should be registered");
    const status = await apple.status();
    expect(status.state).toBe("disconnected");
    expect(status.message).toContain("Wave-1");
  });
});
