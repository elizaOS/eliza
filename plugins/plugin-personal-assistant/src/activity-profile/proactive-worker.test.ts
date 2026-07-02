/**
 * One-scheduler pin for the activity-profile worker (#10721 H1).
 *
 * The worker's old parallel firing path (own timing gates, fired-actions log,
 * direct `sendMessageToTarget` / assistant-event dispatch of GM/GN/nudges/
 * check-ins) is retired: owner-facing proactive dispatch is owned exclusively
 * by the `ScheduledTask` runner. Three layers of pin:
 *
 *   1. Grep-level — the module source contains none of the dispatch surface.
 *   2. Export-surface — the retired delivery helpers are not exported.
 *   3. Behavioral — a full `executeProactiveTask` tick at a GM-favorable time
 *      (morning, active owner, empty fired log, agent-event service present)
 *      sends nothing and emits nothing; it only refreshes the profile and
 *      strips the retired fired-actions log from task metadata.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { IAgentRuntime, Task, UUID } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActivityProfile } from "./types.js";

// 09:00 in the HOST timezone: the worker resolves its timezone via
// `resolveDefaultTimeZone()` (host Intl), and the retired planner's GM slot
// defaulted to 08:00 local with an 11:00 cutoff — so a 9am-local tick with an
// hour-old owner sighting is squarely inside the old firing window on any
// machine this suite runs on.
const GM_FAVORABLE_NOW = (() => {
  const now = new Date();
  now.setHours(9, 0, 0, 0);
  return now;
})();

const gmFavorableProfile = {
  analyzedAt: GM_FAVORABLE_NOW.getTime(),
  isCurrentlySleeping: false,
  isCurrentlyActive: true,
  lastSeenAt: GM_FAVORABLE_NOW.getTime() - 60 * 60 * 1000,
  lastSeenPlatform: "client_chat",
  primaryPlatform: "client_chat",
  typicalWakeHour: null,
  typicalFirstActiveHour: null,
  hasOpenActivityCycle: false,
  currentActivityCycleStartedAt: null,
  currentActivityCycleLocalDate: null,
  lastSleepSignalAt: null,
  lastWakeSignalAt: null,
  sustainedInactivityThresholdMinutes: 90,
  screenContextAvailable: false,
  screenContextStale: true,
  screenContextFocus: null,
  screenContextSampledAt: null,
  screenContextConfidence: null,
} as unknown as ActivityProfile;

// Mock ONLY the profile I/O boundary; everything else in the module under
// test (and, on the retired code path, the pure planners) runs for real.
vi.mock("./service.js", () => ({
  resolveOwnerEntityId: vi.fn(
    async () => "owner-entity-0000-0000-0000-000000000001",
  ),
  readProfileFromMetadata: vi.fn(() => gmFavorableProfile),
  readFiredLogFromMetadata: vi.fn(() => null),
  profileNeedsRebuild: vi.fn(() => false),
  buildActivityProfile: vi.fn(async () => gmFavorableProfile),
  refreshCurrentState: vi.fn(async () => gmFavorableProfile),
}));

// Boundary guard on the parallel planner: the retired worker consulted
// planGm/planGn/… on every tick; the one-scheduler worker must never import
// (let alone invoke) them. The mock records every invocation — it only takes
// effect if the module under test imports proactive-planner at all, so on the
// current code it is inert and on the retired code it captures the violation.
const parallelPlannerInvocations: string[] = [];
vi.mock("./proactive-planner.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  const guarded = (name: string) => {
    const original = actual[name] as (...args: unknown[]) => unknown;
    return (...args: unknown[]) => {
      parallelPlannerInvocations.push(name);
      return original(...args);
    };
  };
  return {
    ...actual,
    planGm: guarded("planGm"),
    planGn: guarded("planGn"),
    planNudges: guarded("planNudges"),
    planDowntimeNudges: guarded("planDowntimeNudges"),
    planGoalCheckIns: guarded("planGoalCheckIns"),
    planSocialOveruseCheck: guarded("planSocialOveruseCheck"),
  };
});

import * as workerModule from "./proactive-worker.js";
import {
  executeProactiveTask,
  PROACTIVE_TASK_NAME,
} from "./proactive-worker.js";

const workerSource = readFileSync(
  fileURLToPath(new URL("./proactive-worker.ts", import.meta.url)),
  "utf8",
);

describe("proactive-worker no longer fires outside the runner (grep-level)", () => {
  it.each([
    "sendMessageToTarget",
    "getAgentEventService",
    "loadOwnerContactsConfig",
    "resolveOwnerContactWithFallback",
    "planGm",
    "planGn",
    "planNudges",
    "planDowntimeNudges",
    "planGoalCheckIns",
    "planSocialOveruseCheck",
    "recordFiredAction",
  ])("source contains no dispatch surface: %s", (token) => {
    expect(workerSource).not.toContain(token);
  });

  it("exports no delivery-routing helpers", () => {
    const exported = Object.keys(workerModule);
    expect(exported).not.toContain("resolveProactiveDeliverySource");
    expect(exported).not.toContain("resolveProactiveOwnerContact");
    expect(exported).not.toContain(
      "classifyCalendarEventsForProactivePlanning",
    );
  });
});

type SentMessage = { target: unknown; content: unknown };
type EmittedEvent = Record<string, unknown>;

function createTripwireRuntime(): {
  runtime: IAgentRuntime;
  sent: SentMessage[];
  emitted: EmittedEvent[];
  updates: Array<{
    taskId: string;
    patch: { metadata?: Record<string, unknown> };
  }>;
} {
  const sent: SentMessage[] = [];
  const emitted: EmittedEvent[] = [];
  const updates: Array<{
    taskId: string;
    patch: { metadata?: Record<string, unknown> };
  }> = [];

  const proactiveTask: Task = {
    id: "proactive-task-1" as UUID,
    name: PROACTIVE_TASK_NAME,
    description: "test task",
    roomId: "room-1" as UUID,
    tags: ["queue", "repeat", "proactive"],
    metadata: {
      proactiveAgent: { kind: "runtime_runner", version: 1 },
      activityProfile: gmFavorableProfile,
      // Legacy parallel-path bookkeeping — the tick must strip it.
      firedActionsLog: { date: "2026-06-22", nudgedOccurrenceIds: [] },
    },
  };

  const agentEventService = {
    subscribe: () => () => {},
    emit: (event: EmittedEvent) => {
      emitted.push(event);
    },
  };

  const runtime = {
    agentId: "agent-0000-0000-0000-000000000001" as UUID,
    character: { name: "TripwireAgent" },
    logger: console,
    // No useModel → the WS5 planner throws BackgroundPlannerError, which the
    // tick catches and logs; nothing else may depend on a model.
    getService: (type: string) =>
      type === "agent_event" || type === "AGENT_EVENT"
        ? agentEventService
        : null,
    getTasks: async () => [proactiveTask],
    updateTask: async (
      taskId: string,
      patch: { metadata?: Record<string, unknown> },
    ) => {
      updates.push({ taskId, patch });
    },
    getRoomsForParticipant: async () => [],
    getMemoriesByRoomIds: async () => [],
    getRoom: async () => null,
    sendMessageToTarget: async (target: unknown, content: unknown) => {
      sent.push({ target, content });
    },
  } as unknown as IAgentRuntime;

  return { runtime, sent, emitted, updates };
}

describe("proactive-worker behavioral tripwire", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("a GM-favorable tick plans nothing, sends nothing, and emits nothing", async () => {
    const { runtime, sent, emitted } = createTripwireRuntime();
    parallelPlannerInvocations.length = 0;

    const result = await executeProactiveTask(runtime, {
      now: GM_FAVORABLE_NOW,
    });

    expect(result.nextInterval).toBeGreaterThan(0);
    // The retired path consulted the parallel planner on every tick and, at
    // 09:00 local with an active owner and an empty fired log, produced a
    // pending GM for direct delivery. The single scheduler owns that now:
    // the tick must not invoke a planner, push a message, or emit an event.
    expect(parallelPlannerInvocations).toHaveLength(0);
    expect(sent).toHaveLength(0);
    expect(emitted).toHaveLength(0);
  });

  it("the tick persists the refreshed profile and strips the retired fired-actions log", async () => {
    const { runtime, updates } = createTripwireRuntime();

    await executeProactiveTask(runtime, { now: GM_FAVORABLE_NOW });

    expect(updates).toHaveLength(1);
    const metadata = updates[0]?.patch.metadata ?? {};
    expect(metadata.activityProfile).toBeDefined();
    expect(metadata.firedActionsLog).toBeUndefined();
    expect(metadata.proactiveAgent).toMatchObject({ kind: "runtime_runner" });
  });
});
