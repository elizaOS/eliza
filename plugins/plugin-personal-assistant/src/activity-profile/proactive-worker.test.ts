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

// Mock profile I/O; keep the planner and dispatch logic real. The approval
// persistence boundary below records any unintended enqueue without sending.
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

const approvalEnqueue = vi.hoisted(() =>
  vi.fn(async () => ({ id: "unexpected-maintenance-approval" })),
);
vi.mock("../lifeops/approval-queue.js", () => ({
  createApprovalQueue: vi.fn(() => ({ enqueue: approvalEnqueue })),
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

import { planJob } from "../lifeops/background-planner.js";
import { enqueueIfSensitive } from "../lifeops/background-planner-dispatch.js";
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
    "planJob",
    "enqueueIfSensitive",
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

  // In-memory cache so the rhythm-window learner (run at the end of the tick)
  // can read/write the OwnerFactStore. A real runtime always provides these.
  const cache = new Map<string, unknown>();

  const runtime = {
    agentId: "agent-0000-0000-0000-000000000001" as UUID,
    character: { name: "TripwireAgent" },
    logger: console,
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
    // A functioning model is essential: a missing model hid the unsolicited
    // daily-brief planning path behind its caught BackgroundPlannerError.
    useModel: vi.fn(async () =>
      JSON.stringify({
        action: "send_email",
        payload: {
          to: ["owner@example.test"],
          subject: "Morning brief",
          body: "Your calendar is clear today.",
        },
        requiresApproval: true,
        channel: "email",
        reason: "Offer a morning brief",
      }),
    ),
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
    parallelPlannerInvocations.length = 0;
  });

  it("the model fixture reaches the real sensitive-plan dispatch boundary", async () => {
    const { runtime } = createTripwireRuntime();
    const context = {
      jobKind: "daily_brief" as const,
      subjectUserId: "owner-entity-0000-0000-0000-000000000001",
      snapshot: {},
      availableChannels: ["email" as const],
      trigger: "test-approved-job",
    };
    const plan = await planJob(runtime, context);
    const result = await enqueueIfSensitive(runtime, context, plan);

    expect(runtime.useModel).toHaveBeenCalledOnce();
    expect(approvalEnqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        requestedBy: "background-job:daily_brief",
        action: "send_email",
      }),
    );
    expect(result.skipped).toBe(false);
  });

  it("repeated GM-favorable ticks maintain the profile without planning, approvals, or delivery", async () => {
    const { runtime, sent, emitted, updates } = createTripwireRuntime();

    for (let tick = 0; tick < 2; tick++) {
      const result = await executeProactiveTask(runtime, {
        now: new Date(GM_FAVORABLE_NOW.getTime() + tick * 60_000),
      });
      expect(result.nextInterval).toBeGreaterThan(0);
    }

    expect(updates).toHaveLength(2);
    for (const update of updates) {
      expect(update.patch.metadata?.activityProfile).toEqual(
        gmFavorableProfile,
      );
    }
    expect(runtime.useModel).not.toHaveBeenCalled();
    expect(approvalEnqueue).not.toHaveBeenCalled();
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

  it("the tick INVOKES the rhythm learner, patching OwnerFacts with the derived window (B1 end-to-end)", async () => {
    const { runtime } = createTripwireRuntime();
    const {
      readProfileFromMetadata,
      buildActivityProfile,
      refreshCurrentState,
    } = await import("./service.js");
    // Give the profile a real observed rhythm so the learner has something to
    // fold into owner facts: 07:00 wake / 23:00 sleep.
    const rhythmProfile = {
      ...gmFavorableProfile,
      typicalWakeHour: 7,
      typicalSleepHour: 23,
    } as unknown as ActivityProfile;
    vi.mocked(readProfileFromMetadata).mockReturnValueOnce(rhythmProfile);
    vi.mocked(buildActivityProfile).mockResolvedValueOnce(rhythmProfile);
    vi.mocked(refreshCurrentState).mockResolvedValueOnce(rhythmProfile);

    await executeProactiveTask(runtime, { now: GM_FAVORABLE_NOW });

    // Read the REAL OwnerFactStore back: the learner must have written the
    // derived morning/evening windows with agent_inferred provenance.
    const { resolveOwnerFactStore } = await import(
      "../lifeops/owner/fact-store.js"
    );
    const facts = await resolveOwnerFactStore(runtime).read();
    expect(facts.morningWindow?.value).toEqual({
      startLocal: "07:00",
      endLocal: "10:00",
    });
    expect(facts.morningWindow?.provenance.source).toBe("agent_inferred");
    expect(facts.eveningWindow?.value).toEqual({
      startLocal: "21:00",
      endLocal: "23:00",
    });
  });
});
