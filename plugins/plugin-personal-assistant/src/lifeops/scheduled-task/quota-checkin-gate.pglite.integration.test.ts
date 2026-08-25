/**
 * Real-PGlite coverage for the quota check-in contributions on the single
 * ScheduledTask spine (#17025): the `quota_incomplete` gate and the
 * `quota_complete` completion check registered by the PA runner wiring.
 *
 * The subject is the production contribution pair evaluated against a real
 * scheduled-task row materialized by a real definition with a typed check-in
 * policy — the same row the runner claims — so the assertions cover the
 * stop-when-complete, active-window, snooze, active-day, and stale-revision
 * branches structurally rather than through prompt prose.
 */
import type {
  ActivitySignalBusView,
  GateEvaluationContext,
  OwnerFactsView,
  ScheduledTask,
  SubjectStoreView,
  TaskGateContribution,
} from "@elizaos/plugin-scheduling";
import {
  createCompletionCheckRegistry,
  createTaskGateRegistry,
} from "@elizaos/plugin-scheduling";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createLifeOpsTestRuntime,
  type RealTestRuntimeResult,
} from "../../../test/helpers/runtime.js";
import { LifeOpsRepository } from "../repository.js";
import { LifeOpsService } from "../service.js";
import {
  composeOwnerFacingScheduledTaskText,
  registerQuotaProgressContributions,
} from "./runtime-wiring.js";

const ownerFacts: OwnerFactsView = {
  timezone: "UTC",
} as unknown as OwnerFactsView;

const activity: ActivitySignalBusView = {
  latest: () => null,
  recent: () => [],
} as unknown as ActivitySignalBusView;

const subjectStore: SubjectStoreView = {
  wasUpdatedSince: async () => false,
} as unknown as SubjectStoreView;

function gateContext(task: ScheduledTask, nowIso: string) {
  return {
    task,
    nowIso,
    ownerFacts,
    activity,
    subjectStore,
  } satisfies GateEvaluationContext;
}

function completionContext(task: ScheduledTask, nowIso: string) {
  return {
    task,
    nowIso,
    ownerFacts,
    activity,
    subjectStore,
    acknowledged: false,
  };
}

describe("quota check-in contributions — real spine row", () => {
  let runtimeResult: RealTestRuntimeResult;
  let repository: LifeOpsRepository;
  let service: LifeOpsService;
  let agentId: string;
  let gate: TaskGateContribution;
  let completionCheck: ReturnType<
    ReturnType<typeof createCompletionCheckRegistry>["get"]
  >;

  beforeAll(async () => {
    runtimeResult = await createLifeOpsTestRuntime();
    agentId = runtimeResult.runtime.agentId;
    repository = new LifeOpsRepository(runtimeResult.runtime);
    service = new LifeOpsService(runtimeResult.runtime);

    const gates = createTaskGateRegistry();
    const completionChecks = createCompletionCheckRegistry();
    registerQuotaProgressContributions({
      runtime: runtimeResult.runtime,
      agentId,
      gates,
      completionChecks,
    });
    const registered = gates.get("quota_incomplete");
    expect(registered).not.toBeNull();
    if (!registered) throw new Error("quota_incomplete gate not registered");
    gate = registered;
    completionCheck = completionChecks.get("quota_complete");
    expect(completionCheck).not.toBeNull();
  });

  afterAll(async () => {
    await runtimeResult.cleanup();
  });

  /**
   * Creates a quota definition whose single check-in window brackets `now`,
   * and returns the real scheduled-task row plus the active occurrence.
   */
  async function createCheckInQuota(
    title: string,
    windowOffsets: { startDelta: number; endDelta: number } = {
      startDelta: -1,
      endDelta: 30,
    },
  ): Promise<{
    task: ScheduledTask;
    occurrenceId: string;
    definitionId: string;
  }> {
    const now = new Date();
    const nowMinute = now.getUTCHours() * 60 + now.getUTCMinutes();
    const record = await service.createDefinition({
      kind: "habit",
      title,
      description: "",
      originalIntent: `${title}, three sets any time, check in with me`,
      timezone: "UTC",
      priority: 3,
      cadence: {
        kind: "count_per_day",
        targetCount: 3,
        unit: "set",
        perOccurrenceWork: "25 pushups",
        timing: { kind: "anytime" },
      },
      windowPolicy: {
        timezone: "UTC",
        windows: [
          {
            name: "custom",
            label: "Check-in window",
            startMinute: Math.min(
              24 * 60 - 2,
              Math.max(0, nowMinute + windowOffsets.startDelta),
            ),
            endMinute: Math.min(
              24 * 60 - 1,
              Math.max(1, nowMinute + windowOffsets.endDelta),
            ),
          },
        ],
      },
      checkInPolicy: {
        kind: "quota_progress",
        windows: ["custom"],
        followupAfterMinutes: 30,
        noReplyPolicy: {
          maxRetries: 1,
          retryCadenceMinutes: [30],
          terminalStatus: "expired",
          terminalReason: "quota_checkin_no_reply",
        },
        stopWhenComplete: true,
      },
    });
    const occurrences = await repository.listOccurrencesForDefinition(
      agentId,
      record.definition.id,
    );
    const localDateKey = now.toISOString().slice(0, 10);
    const occurrence = occurrences.find(
      (candidate) => candidate.metadata.localDateKey === localDateKey,
    );
    expect(occurrence).toBeDefined();
    if (!occurrence) throw new Error("active quota occurrence missing");
    const tasks = await repository.listScheduledTasks(agentId, {
      kind: "checkin",
      source: "plugin",
    });
    const task = tasks.find(
      (candidate) => candidate.metadata?.quotaOccurrenceId === occurrence.id,
    );
    expect(task).toBeDefined();
    if (!task) throw new Error("quota check-in scheduled task missing");
    return {
      task,
      occurrenceId: occurrence.id,
      definitionId: record.definition.id,
    };
  }

  it("allows a fire inside an active window while the quota is incomplete", async () => {
    const { task } = await createCheckInQuota("in-window quota");
    const decision = await gate.evaluate(
      task,
      gateContext(task, new Date().toISOString()),
    );
    expect(decision).toEqual({ kind: "allow" });
  });

  it("stops nudging the moment the target is reached", async () => {
    const { task, occurrenceId } = await createCheckInQuota("stop-when-done");
    await service.recordOccurrenceProgress(occurrenceId, {
      idempotencyKey: "done-1",
      quantity: 3,
    });
    const nowIso = new Date().toISOString();
    const decision = await gate.evaluate(task, gateContext(task, nowIso));
    expect(decision.kind).toBe("deny");
    expect(decision.kind === "deny" && decision.reason).toContain(
      "quota complete",
    );
    expect(
      await completionCheck?.shouldComplete(
        task,
        completionContext(task, nowIso),
      ),
    ).toBe(true);
  });

  it("keeps the check-in live while the quota is only partially done", async () => {
    const { task, occurrenceId } = await createCheckInQuota("partial quota");
    await service.recordOccurrenceProgress(occurrenceId, {
      idempotencyKey: "partial-1",
    });
    const nowIso = new Date().toISOString();
    expect(await gate.evaluate(task, gateContext(task, nowIso))).toEqual({
      kind: "allow",
    });
    expect(
      await completionCheck?.shouldComplete(
        task,
        completionContext(task, nowIso),
      ),
    ).toBe(false);
  });

  it("defers to the snooze expiry instead of firing through a snooze", async () => {
    const { task, occurrenceId } = await createCheckInQuota("snoozed quota");
    const snoozed = await service.snoozeOccurrence(occurrenceId, {
      minutes: 45,
    });
    expect(snoozed.state).toBe("snoozed");
    const decision = await gate.evaluate(
      task,
      gateContext(task, new Date().toISOString()),
    );
    expect(decision.kind).toBe("defer");
    expect(decision.kind === "defer" && decision.reason).toContain("snoozed");
  });

  it("denies once the owner-local active day has ended", async () => {
    const { task } = await createCheckInQuota("next-day quota");
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1_000);
    const decision = await gate.evaluate(
      task,
      gateContext(task, tomorrow.toISOString()),
    );
    expect(decision.kind).toBe("deny");
    expect(decision.kind === "deny" && decision.reason).toMatch(
      /active day has ended|check-in windows closed/,
    );
  });

  it("denies a stale check-in whose definition revision moved on", async () => {
    const { task, definitionId } = await createCheckInQuota("revised quota");
    await service.updateDefinition(definitionId, {
      title: "revised quota (renamed)",
    });
    const decision = await gate.evaluate(
      task,
      gateContext(task, new Date().toISOString()),
    );
    expect(decision.kind).toBe("deny");
    expect(decision.kind === "deny" && decision.reason).toContain(
      "no longer current",
    );
  });

  it("denies a check-in row that lost its quota occurrence pointer", async () => {
    const { task } = await createCheckInQuota("orphan quota");
    const orphan = {
      ...task,
      metadata: { ...task.metadata, quotaOccurrenceId: undefined },
    } as ScheduledTask;
    const decision = await gate.evaluate(
      orphan,
      gateContext(orphan, new Date().toISOString()),
    );
    expect(decision.kind).toBe("deny");
    expect(decision.kind === "deny" && decision.reason).toContain(
      "quotaOccurrenceId missing",
    );
    expect(
      await completionCheck?.shouldComplete(
        orphan,
        completionContext(orphan, new Date().toISOString()),
      ),
    ).toBe(false);
  });

  it("states the server-derived remaining count in the owner-facing check-in copy", async () => {
    const { task, occurrenceId } = await createCheckInQuota("copy quota");
    const record = {
      metadata: task.metadata,
    } as unknown as Parameters<typeof composeOwnerFacingScheduledTaskText>[1];

    const atZero = await composeOwnerFacingScheduledTaskText(
      runtimeResult.runtime,
      record,
    );
    expect(atZero).toContain("0/3 sets");
    expect(atZero).toContain("3 remaining");

    await service.recordOccurrenceProgress(occurrenceId, {
      idempotencyKey: "copy-1",
      quantity: 2,
    });
    const atTwo = await composeOwnerFacingScheduledTaskText(
      runtimeResult.runtime,
      record,
    );
    expect(atTwo).toContain("2/3 sets");
    expect(atTwo).toContain("1 remaining");

    await service.recordOccurrenceProgress(occurrenceId, {
      idempotencyKey: "copy-2",
    });
    const atTarget = await composeOwnerFacingScheduledTaskText(
      runtimeResult.runtime,
      record,
    );
    expect(atTarget).toContain("3/3 sets complete");
    expect(atTarget).not.toContain("remaining");
  });

  it("denies once the occurrence is skipped for the day", async () => {
    const { task, occurrenceId } = await createCheckInQuota("skipped quota");
    await service.skipOccurrence(occurrenceId);
    const decision = await gate.evaluate(
      task,
      gateContext(task, new Date().toISOString()),
    );
    expect(decision.kind).toBe("deny");
    expect(decision.kind === "deny" && decision.reason).toMatch(
      /skipped|quota complete/,
    );
  });
});
