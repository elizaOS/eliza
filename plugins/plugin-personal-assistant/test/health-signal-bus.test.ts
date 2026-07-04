/**
 * #12284 WI-1 + WI-4 end to end across the real seams: real
 * `deriveSleepWakeEvents` → `publishDerivedHealthSignals` → real
 * FamilyRegistry-validated bus → real `health_signal_observed` completion
 * check and real `computeNextFireAt` anchor resolution — no mock stands in
 * for anything under test. Fixed 2026-05-09 timeline; the bus gets a large
 * retentionMs because its eviction cutoff is wall-clock `Date.now()`.
 */

import type {
  ActivitySignalReader,
  AnchorRegistry as HealthAnchorRegistry,
  BusFamilyRegistry as HealthBusFamilyRegistry,
  LifeOpsScheduleMergedStateRecord,
} from "@elizaos/plugin-health";
import {
  deriveSleepWakeEvents,
  HEALTH_BUS_FAMILIES,
  registerHealthAnchors,
  registerHealthBusFamilies,
} from "@elizaos/plugin-health";
import type {
  AnchorContribution,
  CompletionCheckContext,
  OwnerFactsView,
  ScheduledTask,
} from "@elizaos/plugin-scheduling";
import {
  computeNextFireAt,
  createAnchorRegistry,
  createCompletionCheckRegistry,
  registerBuiltInCompletionChecks,
} from "@elizaos/plugin-scheduling";
import { describe, expect, it } from "vitest";
import {
  createFamilyRegistry,
  registerAppLifeOpsBusFamilies,
  registerBuiltinTelemetryFamilies,
} from "../src/lifeops/registries/family-registry.js";
import type { ActivitySignalBus } from "../src/lifeops/signals/bus.js";
import { createActivitySignalBus } from "../src/lifeops/signals/bus.js";
import { publishDerivedHealthSignals } from "../src/lifeops/signals/health-signal-publisher.js";

const NY = "America/New_York";
/** 2026-05-09 09:00 EDT. */
const NOW_ISO = "2026-05-09T13:00:00.000Z";
/** 06:47 EDT — the observed wake instant on the fixture day. */
const WAKE_AT_ISO = "2026-05-09T10:47:00.000Z";

const OWNER_FACTS: OwnerFactsView = {
  timezone: NY,
  morningWindow: { start: "07:30", end: "11:00" },
};

function makeBusWithHealthFamilies(): ActivitySignalBus {
  const familyRegistry = createFamilyRegistry();
  registerBuiltinTelemetryFamilies(familyRegistry);
  registerAppLifeOpsBusFamilies(familyRegistry);
  registerHealthBusFamilies({
    busFamilyRegistry: familyRegistry as HealthBusFamilyRegistry,
  });
  return createActivitySignalBus({
    familyRegistry,
    // Fixture instants are fixed dates; the default 24h sliding window is
    // anchored on wall-clock Date.now() and would evict them at publish.
    retentionMs: Number.MAX_SAFE_INTEGER,
  });
}

function makeStateRecord(
  overrides: Partial<LifeOpsScheduleMergedStateRecord> = {},
): LifeOpsScheduleMergedStateRecord {
  const baseInsight = {
    effectiveDayKey: "2026-05-09",
    localDate: "2026-05-09",
    timezone: NY,
    inferredAt: "2026-05-09T10:50:00.000Z",
    circadianState: "awake" as const,
    stateConfidence: 0.92,
    uncertaintyReason: null,
    relativeTime: {
      computedAt: "2026-05-09T10:50:00.000Z",
      localNowAt: "2026-05-09T10:50:00.000Z",
      circadianState: "awake" as const,
      stateConfidence: 0.92,
      uncertaintyReason: null,
      awakeProbability: {
        pAwake: 0.9,
        pAsleep: 0.05,
        pUnknown: 0.05,
        contributingSources: [],
        computedAt: "2026-05-09T10:50:00.000Z",
      },
      wakeAnchorAt: WAKE_AT_ISO,
      wakeAnchorSource: "sleep_cycle" as const,
      minutesSinceWake: 5,
      minutesAwake: 5,
      bedtimeTargetAt: "2026-05-10T03:00:00.000Z",
      bedtimeTargetSource: "typical_sleep" as const,
      minutesUntilBedtimeTarget: 960,
      minutesSinceBedtimeTarget: null,
      dayBoundaryStartAt: "2026-05-09T09:00:00.000Z",
      dayBoundaryEndAt: "2026-05-10T09:00:00.000Z",
      minutesSinceDayBoundaryStart: 120,
      minutesUntilDayBoundaryEnd: 1320,
      confidence: 0.92,
    },
    awakeProbability: {
      pAwake: 0.9,
      pAsleep: 0.05,
      pUnknown: 0.05,
      contributingSources: [],
      computedAt: "2026-05-09T10:50:00.000Z",
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
    lastSleepStartedAt: "2026-05-09T03:30:00.000Z",
    lastSleepEndedAt: WAKE_AT_ISO,
    lastSleepDurationMinutes: 437,
    wakeAt: WAKE_AT_ISO,
    firstActiveAt: WAKE_AT_ISO,
    lastActiveAt: "2026-05-09T10:50:00.000Z",
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

/** sleeping → waking edge: derives `lifeops.wake.observed`. */
function deriveWakeObserved() {
  return deriveSleepWakeEvents({
    previous: makeStateRecord({
      circadianState: "sleeping",
      currentSleepStartedAt: "2026-05-09T03:30:00.000Z",
    }),
    current: makeStateRecord({ circadianState: "waking" }),
    now: new Date("2026-05-09T10:47:00.000Z"),
  });
}

/** waking → awake edge: derives `lifeops.wake.confirmed` + `lifeops.sleep.ended`. */
function deriveWakeConfirmed() {
  return deriveSleepWakeEvents({
    previous: makeStateRecord({ circadianState: "waking" }),
    current: makeStateRecord({ circadianState: "awake" }),
    now: new Date("2026-05-09T10:57:00.000Z"),
  });
}

describe("#12284 WI-4 — production publisher onto the real ActivitySignalBus", () => {
  it("plugin-health registers every health.* family into the real FamilyRegistry", () => {
    const familyRegistry = createFamilyRegistry();
    registerBuiltinTelemetryFamilies(familyRegistry);
    registerAppLifeOpsBusFamilies(familyRegistry);
    registerHealthBusFamilies({
      busFamilyRegistry: familyRegistry as HealthBusFamilyRegistry,
    });
    for (const family of HEALTH_BUS_FAMILIES) {
      expect(familyRegistry.has(family)).toBe(true);
    }
  });

  it("simulated wake transition → bus hasSignalSince flips true for the family", () => {
    const bus = makeBusWithHealthFamilies();
    const sinceIso = "2026-05-09T05:00:00.000Z";

    expect(
      bus.hasSignalSince({ signalKind: "health.wake.observed", sinceIso }),
    ).toBe(false);

    const events = deriveWakeObserved();
    expect(events.map((event) => event.kind)).toEqual([
      "lifeops.wake.observed",
    ]);
    const result = publishDerivedHealthSignals(bus, events);
    expect(result).toEqual({ published: 1, unmapped: 0 });

    expect(
      bus.hasSignalSince({ signalKind: "health.wake.observed", sinceIso }),
    ).toBe(true);
    // The envelope instant is the observed wake time itself.
    const envelopes = bus.recent({
      sinceIso,
      family: "health.wake.observed",
    });
    expect(envelopes).toHaveLength(1);
    expect(envelopes[0]?.occurredAt).toBe(WAKE_AT_ISO);
  });

  it("wake.confirmed edge publishes wake.confirmed + sleep.ended; onset candidates stay unmapped", () => {
    const bus = makeBusWithHealthFamilies();
    const confirmResult = publishDerivedHealthSignals(
      bus,
      deriveWakeConfirmed(),
    );
    expect(confirmResult).toEqual({ published: 2, unmapped: 0 });
    expect(
      bus.hasSignalSince({
        signalKind: "health.wake.confirmed",
        sinceIso: "2026-05-09T05:00:00.000Z",
      }),
    ).toBe(true);
    expect(
      bus.hasSignalSince({
        signalKind: "health.sleep.ended",
        sinceIso: "2026-05-09T05:00:00.000Z",
      }),
    ).toBe(true);

    // any → sleeping derives onset_candidate + sleep.detected; the onset
    // candidate intentionally has no bus family and must be skipped, not
    // crash the publisher against the validating registry.
    const sleepEvents = deriveSleepWakeEvents({
      previous: makeStateRecord({ circadianState: "awake" }),
      current: makeStateRecord({
        circadianState: "sleeping",
        currentSleepStartedAt: "2026-05-10T03:10:00.000Z",
      }),
      now: new Date("2026-05-10T03:20:00.000Z"),
    });
    expect(sleepEvents.map((event) => event.kind).sort()).toEqual([
      "lifeops.sleep.detected",
      "lifeops.sleep.onset_candidate",
    ]);
    const sleepResult = publishDerivedHealthSignals(bus, sleepEvents);
    expect(sleepResult).toEqual({ published: 1, unmapped: 1 });
  });

  it("health_signal_observed completion check passes through the real bus (no longer always-false)", async () => {
    const bus = makeBusWithHealthFamilies();
    const registry = createCompletionCheckRegistry();
    registerBuiltInCompletionChecks(registry);
    const check = registry.get("health_signal_observed");
    expect(check).not.toBeNull();
    if (!check) throw new Error("health_signal_observed not registered");

    const task: ScheduledTask = {
      taskId: "task-wake-check",
      kind: "checkin",
      promptInstructions: "confirm the owner is up",
      trigger: {
        kind: "relative_to_anchor",
        anchorKey: "wake.confirmed",
        offsetMinutes: 0,
      },
      priority: "medium",
      respectsGlobalPause: true,
      source: "default_pack",
      createdBy: "plugin-health-default-pack",
      ownerVisible: true,
      completionCheck: {
        kind: "health_signal_observed",
        params: {
          signalKind: "health.wake.confirmed",
          requireSinceTaskFired: true,
        },
      },
      state: {
        status: "fired",
        firedAt: "2026-05-09T10:00:00.000Z",
        followupCount: 0,
      },
    };
    const context: CompletionCheckContext = {
      task,
      nowIso: NOW_ISO,
      ownerFacts: OWNER_FACTS,
      activity: bus,
      subjectStore: { wasUpdatedSince: () => false },
      acknowledged: false,
    };

    expect(await check.shouldComplete(task, context)).toBe(false);
    publishDerivedHealthSignals(bus, deriveWakeConfirmed());
    expect(await check.shouldComplete(task, context)).toBe(true);
  });
});

describe("#12284 WI-1 — observed anchors resolve through the spine's real anchor path", () => {
  function makeAnchorsWiredToBus(bus: ActivitySignalBus) {
    const anchors = createAnchorRegistry();
    // Same adapter shape the production wiring uses: plugin-health sees the
    // registry + bus through its structural runtime properties.
    const registryAdapter: HealthAnchorRegistry = {
      register(contribution) {
        anchors.register(contribution as unknown as AnchorContribution, {
          override: true,
        });
      },
      list: () => [],
      get: (anchorKey) =>
        (anchors.get(anchorKey) as unknown as ReturnType<
          HealthAnchorRegistry["get"]
        >) ?? null,
    };
    registerHealthAnchors({
      anchorRegistry: registryAdapter,
      activitySignalBus: bus as ActivitySignalReader,
    });
    return anchors;
  }

  it("relative_to_anchor('wake.confirmed', 30) resolves to observed wake + 30", async () => {
    const bus = makeBusWithHealthFamilies();
    const anchors = makeAnchorsWiredToBus(bus);
    publishDerivedHealthSignals(bus, deriveWakeConfirmed());

    const nextFireAt = await computeNextFireAt(
      {
        trigger: {
          kind: "relative_to_anchor",
          anchorKey: "wake.confirmed",
          offsetMinutes: 30,
        },
        state: { status: "scheduled", followupCount: 0 },
        metadata: undefined,
      },
      {
        now: new Date(NOW_ISO),
        ownerFacts: OWNER_FACTS,
        anchors,
      },
    );
    // Observed wake 10:47Z (06:47 EDT) + 30min — NOT the configured
    // morning-window start.
    expect(nextFireAt).toBe("2026-05-09T11:17:00.000Z");
  });

  it("falls back to morningWindow.start when no observation exists", async () => {
    const bus = makeBusWithHealthFamilies();
    const anchors = makeAnchorsWiredToBus(bus);

    const nextFireAt = await computeNextFireAt(
      {
        trigger: {
          kind: "relative_to_anchor",
          anchorKey: "wake.confirmed",
          offsetMinutes: 30,
        },
        state: { status: "scheduled", followupCount: 0 },
        metadata: undefined,
      },
      {
        now: new Date(NOW_ISO),
        ownerFacts: OWNER_FACTS,
        anchors,
      },
    );
    // Static default: 07:30 EDT (11:30Z) + 30min.
    expect(nextFireAt).toBe("2026-05-09T12:00:00.000Z");
  });

  it("ignores a stale prior-day observation and falls back", async () => {
    const bus = makeBusWithHealthFamilies();
    const anchors = makeAnchorsWiredToBus(bus);
    // Yesterday's confirmed wake, published directly onto the bus.
    bus.publish({
      family: "health.wake.confirmed",
      occurredAt: "2026-05-08T10:47:00.000Z",
    });

    const nextFireAt = await computeNextFireAt(
      {
        trigger: {
          kind: "relative_to_anchor",
          anchorKey: "wake.confirmed",
          offsetMinutes: 30,
        },
        state: { status: "scheduled", followupCount: 0 },
        metadata: undefined,
      },
      {
        now: new Date(NOW_ISO),
        ownerFacts: OWNER_FACTS,
        anchors,
      },
    );
    expect(nextFireAt).toBe("2026-05-09T12:00:00.000Z");
  });
});
