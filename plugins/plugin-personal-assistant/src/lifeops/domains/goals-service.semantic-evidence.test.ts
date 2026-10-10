import type {
  LifeOpsActivitySignal,
  LifeOpsGoalDefinition,
  LifeOpsGoalReview,
} from "@elizaos/contracts";
import type { IAgentRuntime, UUID } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import type { LifeOpsContext } from "../lifeops-context.js";
import {
  createOwnerFactStore,
  type OwnerFactProvenance,
  registerOwnerFactStore,
  resolveOwnerFactStore,
} from "../owner/fact-store.js";
import { type GoalsDeps, GoalsDomain } from "./goals-service.js";

function makeRuntime(): IAgentRuntime {
  const cache = new Map<string, unknown>();
  return {
    agentId: "44444444-4444-4444-4444-444444444444" as UUID,
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

function makeSleepSignal(
  observedAt: string,
  asleepAt: string,
  awakeAt: string,
): LifeOpsActivitySignal {
  return {
    id: observedAt,
    agentId: "44444444-4444-4444-4444-444444444444",
    source: "mobile_health",
    platform: "ios_capacitor",
    state: "sleeping",
    observedAt,
    idleState: null,
    idleTimeSeconds: null,
    onBattery: null,
    health: {
      source: "apple_health",
      permissions: { sleep: true, biometrics: false },
      sleep: {
        available: true,
        isSleeping: false,
        asleepAt,
        awakeAt,
        durationMinutes: 480,
        stage: "asleep",
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
    createdAt: observedAt,
  };
}

const provenance: OwnerFactProvenance = {
  source: "profile_save",
  recordedAt: "2026-10-01T00:00:00.000Z",
};

describe("GoalsDomain semantic sleep evidence", () => {
  it("uses the owner zone effective at each sleep signal observation", async () => {
    const runtime = makeRuntime();
    registerOwnerFactStore(runtime, createOwnerFactStore(runtime));
    const store = resolveOwnerFactStore(runtime);
    await store.update({ timezone: "America/New_York" }, provenance);
    await store.setActiveTravel(
      {
        startIso: "2026-10-09T00:00:00.000Z",
        endIso: "2026-10-20T00:00:00.000Z",
        destinationTimezone: "Asia/Tokyo",
      },
      provenance,
    );

    const sleepSignals = [
      makeSleepSignal(
        "2026-10-08T12:00:00.000Z",
        "2026-10-08T03:30:00.000Z",
        "2026-10-08T11:30:00.000Z",
      ),
      makeSleepSignal(
        "2026-10-10T12:00:00.000Z",
        "2026-10-10T03:30:00.000Z",
        "2026-10-10T11:30:00.000Z",
      ),
    ];
    const deps = {
      listActivitySignals: async () => sleepSignals,
    } as GoalsDeps;
    const domain = new GoalsDomain(
      { runtime } as unknown as LifeOpsContext,
      deps,
    );

    const evidence = await domain.buildGoalSemanticEvidence({
      activeOccurrences: [],
      goal: { metadata: {} } as LifeOpsGoalDefinition,
      lastActivityAt: null,
      linkedDefinitions: [],
      overdueOccurrences: [],
      recentCompletions: [],
      reviewState: "on_track",
      summary: {} as LifeOpsGoalReview["summary"],
      now: new Date("2026-10-10T12:00:00.000Z"),
    });

    expect(evidence.timeZone).toBe("Asia/Tokyo");
    expect(evidence.sleepSessions).toMatchObject([
      {
        observedAt: "2026-10-08T12:00:00.000Z",
        timeZone: "America/New_York",
        localBedtime: "23:30",
        localWakeTime: "07:30",
      },
      {
        observedAt: "2026-10-10T12:00:00.000Z",
        timeZone: "Asia/Tokyo",
        localBedtime: "12:30",
        localWakeTime: "20:30",
      },
    ]);
  });
});
