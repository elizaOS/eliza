/**
 * Unit tests for the real ActivityProfile-backed gate readers
 * (issue #12186, tasks B2 + B3 / plan D.2.2, D.4.1, D.2.3):
 *   - circadian_state_in — allow/deny per observed awake/asleep state;
 *   - no_recent_user_message_in — allow when quiet, defer when recently active;
 *   - behaviouralBaselineFromProfile — sample count feeder for
 *     personal_baseline_sufficient.
 */

import type { IAgentRuntime, Task, UUID } from "@elizaos/core";
import type {
  GateEvaluationContext,
  ScheduledTask,
} from "@elizaos/plugin-scheduling";
import {
  createTaskGateRegistry,
  registerBuiltInGates,
} from "@elizaos/plugin-scheduling";
import { describe, expect, it } from "vitest";
import type { ActivityProfile } from "../../activity-profile/types.js";
import {
  behaviouralBaselineFromProfile,
  registerActivityProfileGates,
} from "./activity-gates.js";

function baseProfile(overrides: Partial<ActivityProfile>): ActivityProfile {
  return {
    ownerEntityId: "owner",
    analyzedAt: 0,
    analysisWindowDays: 7,
    timezone: "UTC",
    totalMessages: 0,
    sustainedInactivityThresholdMinutes: 180,
    platforms: [],
    primaryPlatform: null,
    secondaryPlatform: null,
    bucketCounts: {
      EARLY_MORNING: 0,
      MORNING: 0,
      MIDDAY: 0,
      AFTERNOON: 0,
      EVENING: 0,
      NIGHT: 0,
      LATE_NIGHT: 0,
    },
    hasCalendarData: false,
    typicalFirstEventHour: null,
    typicalLastEventHour: null,
    avgWeekdayMeetings: null,
    typicalFirstActiveHour: null,
    typicalLastActiveHour: null,
    typicalWakeHour: null,
    typicalSleepHour: null,
    hasSleepData: false,
    isCurrentlySleeping: false,
    lastSleepSignalAt: null,
    lastWakeSignalAt: null,
    sleepSourcePlatform: null,
    sleepSource: null,
    typicalSleepDurationMinutes: null,
    lastSeenAt: 0,
    lastSeenPlatform: null,
    isCurrentlyActive: false,
    hasOpenActivityCycle: false,
    currentActivityCycleStartedAt: null,
    currentActivityCycleLocalDate: null,
    effectiveDayKey: "2026-05-10",
    screenContextFocus: null,
    screenContextSource: null,
    screenContextSampledAt: null,
    screenContextConfidence: null,
    screenContextBusy: false,
    screenContextAvailable: false,
    screenContextStale: false,
    ...overrides,
  };
}

function makeRuntime(profile: ActivityProfile | null): IAgentRuntime {
  const tasks: Task[] = profile
    ? [
        {
          id: "proactive-task" as UUID,
          name: "PROACTIVE_AGENT",
          metadata: { activityProfile: profile },
        } as unknown as Task,
      ]
    : [];
  return {
    agentId: "11111111-1111-1111-1111-111111111111" as UUID,
    async getTasks(): Promise<Task[]> {
      return tasks;
    },
  } as unknown as IAgentRuntime;
}

function makeContext(
  task: ScheduledTask,
  opts: { nowIso?: string; busActive?: boolean } = {},
): GateEvaluationContext {
  return {
    task,
    nowIso: opts.nowIso ?? "2026-05-10T12:00:00.000Z",
    ownerFacts: { timezone: "UTC" },
    activity: { hasSignalSince: () => opts.busActive === true },
    subjectStore: { wasUpdatedSince: () => false },
  };
}

function taskWithGate(kind: string, params: unknown): ScheduledTask {
  return {
    taskId: "t1",
    kind: "reminder",
    promptInstructions: "x",
    trigger: { kind: "manual" },
    priority: "low",
    shouldFire: { compose: "all", gates: [{ kind, params }] },
    respectsGlobalPause: true,
    state: { status: "scheduled", followupCount: 0 },
    source: "default_pack",
    createdBy: "test",
    ownerVisible: true,
  };
}

describe("circadian_state_in reader", () => {
  it("allows when observed state (awake) is in requested states", async () => {
    const reg = createTaskGateRegistry();
    registerActivityProfileGates(
      makeRuntime(baseProfile({ isCurrentlySleeping: false })),
      reg,
    );
    const gate = reg.get("circadian_state_in");
    const task = taskWithGate("circadian_state_in", { states: ["awake"] });
    const decision = await gate?.evaluate(task, makeContext(task));
    expect(decision).toEqual({ kind: "allow" });
  });

  it("denies when observed state (asleep) is not in requested states", async () => {
    const reg = createTaskGateRegistry();
    registerActivityProfileGates(
      makeRuntime(baseProfile({ isCurrentlySleeping: true })),
      reg,
    );
    const gate = reg.get("circadian_state_in");
    const task = taskWithGate("circadian_state_in", { states: ["awake"] });
    const decision = await gate?.evaluate(task, makeContext(task));
    expect(decision?.kind).toBe("deny");
  });

  it("allows an asleep-only task when the user is asleep", async () => {
    const reg = createTaskGateRegistry();
    registerActivityProfileGates(
      makeRuntime(baseProfile({ isCurrentlySleeping: true })),
      reg,
    );
    const gate = reg.get("circadian_state_in");
    const task = taskWithGate("circadian_state_in", { states: ["asleep"] });
    const decision = await gate?.evaluate(task, makeContext(task));
    expect(decision).toEqual({ kind: "allow" });
  });

  it("defaults to awake when no profile has been built yet", async () => {
    const reg = createTaskGateRegistry();
    registerActivityProfileGates(makeRuntime(null), reg);
    const gate = reg.get("circadian_state_in");
    const task = taskWithGate("circadian_state_in", { states: ["awake"] });
    const decision = await gate?.evaluate(task, makeContext(task));
    expect(decision).toEqual({ kind: "allow" });
  });
});

describe("no_recent_user_message_in reader", () => {
  const NOW = "2026-05-10T12:00:00.000Z";
  const nowMs = Date.parse(NOW);

  it("allows when the user has been quiet longer than the window", async () => {
    const reg = createTaskGateRegistry();
    registerActivityProfileGates(
      makeRuntime(baseProfile({ lastSeenAt: nowMs - 60 * 60 * 1000 })),
      reg,
    );
    const gate = reg.get("no_recent_user_message_in");
    const task = taskWithGate("no_recent_user_message_in", { minutes: 30 });
    const decision = await gate?.evaluate(
      task,
      makeContext(task, { nowIso: NOW }),
    );
    expect(decision).toEqual({ kind: "allow" });
  });

  it("defers when the user was active within the window (profile heartbeat)", async () => {
    const reg = createTaskGateRegistry();
    registerActivityProfileGates(
      makeRuntime(baseProfile({ lastSeenAt: nowMs - 10 * 60 * 1000 })),
      reg,
    );
    const gate = reg.get("no_recent_user_message_in");
    const task = taskWithGate("no_recent_user_message_in", { minutes: 30 });
    const decision = await gate?.evaluate(
      task,
      makeContext(task, { nowIso: NOW }),
    );
    expect(decision?.kind).toBe("defer");
    if (decision?.kind === "defer" && "offsetMinutes" in decision.until) {
      // last seen 10m ago, window 30m → quiet again in ~20m.
      expect(decision.until.offsetMinutes).toBe(20);
    }
  });

  it("defers when a message_activity_event is on the bus within the window", async () => {
    const reg = createTaskGateRegistry();
    registerActivityProfileGates(
      makeRuntime(baseProfile({ lastSeenAt: 0 })),
      reg,
    );
    const gate = reg.get("no_recent_user_message_in");
    const task = taskWithGate("no_recent_user_message_in", { minutes: 30 });
    const decision = await gate?.evaluate(
      task,
      makeContext(task, { nowIso: NOW, busActive: true }),
    );
    expect(decision?.kind).toBe("defer");
  });
});

describe("behaviouralBaselineFromProfile (B3 feeder)", () => {
  it("returns null when the profile has no observed samples", () => {
    expect(behaviouralBaselineFromProfile(baseProfile({}))).toBeNull();
    expect(behaviouralBaselineFromProfile(null)).toBeNull();
  });

  it("counts wake + sleep hours and per-platform history as samples", () => {
    const result = behaviouralBaselineFromProfile(
      baseProfile({
        typicalWakeHour: 7,
        typicalSleepHour: 23,
        analysisWindowDays: 7,
        platforms: [
          {
            source: "client_chat",
            messageCount: 40,
            bucketCounts: {
              EARLY_MORNING: 0,
              MORNING: 0,
              MIDDAY: 0,
              AFTERNOON: 0,
              EVENING: 0,
              NIGHT: 0,
              LATE_NIGHT: 0,
            },
            lastMessageAt: 0,
            averageMessagesPerDay: 5,
          },
        ],
      }),
    );
    expect(result).toEqual({ sampleCount: 3, windowDays: 7 });
  });
});

describe("first-wins: PA's real reader overrides the plugin-scheduling fallback", () => {
  // This mirrors the production wiring in runtime-wiring.ts: PA registers its
  // ActivityProfile-backed readers BEFORE registerBuiltInGates, which is
  // first-wins, so the PA reader stays authoritative.
  it("PA's circadian_state_in (asleep-aware) wins over the built-in awake-default fallback", async () => {
    const reg = createTaskGateRegistry();
    // 1. PA registers its real reader first, over a profile that says asleep.
    registerActivityProfileGates(
      makeRuntime(baseProfile({ isCurrentlySleeping: true })),
      reg,
    );
    // 2. Built-ins run second and must NOT overwrite it.
    registerBuiltInGates(reg);

    const task = taskWithGate("circadian_state_in", { states: ["awake"] });
    const decision = await reg
      .get("circadian_state_in")
      ?.evaluate(task, makeContext(task));
    // PA's reader denies (user asleep). The built-in fallback, if it had won,
    // would have allowed (no profile → assume awake). deny proves PA won.
    expect(decision?.kind).toBe("deny");
  });

  it("PA's no_recent_user_message_in (heartbeat-aware) wins over the built-in bus-only fallback", async () => {
    const NOW = "2026-05-10T12:00:00.000Z";
    const nowMs = Date.parse(NOW);
    const reg = createTaskGateRegistry();
    // PA reader over a profile with a recent heartbeat but NO bus signal.
    registerActivityProfileGates(
      makeRuntime(baseProfile({ lastSeenAt: nowMs - 10 * 60 * 1000 })),
      reg,
    );
    registerBuiltInGates(reg);

    const task = taskWithGate("no_recent_user_message_in", { minutes: 30 });
    // Bus reports no activity; only the profile heartbeat does. The built-in
    // fallback (bus-only) would ALLOW; PA's reader DEFERS by the remaining 20m.
    const decision = await reg
      .get("no_recent_user_message_in")
      ?.evaluate(task, makeContext(task, { nowIso: NOW, busActive: false }));
    expect(decision?.kind).toBe("defer");
    if (decision?.kind === "defer" && "offsetMinutes" in decision.until) {
      expect(decision.until.offsetMinutes).toBe(20);
    }
  });
});
