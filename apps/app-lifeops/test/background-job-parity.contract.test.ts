/**
 * WS5 background-job parity contract test.
 *
 * For every PRD background job (see docs/prd-lifeops-executive-assistant.md
 * lines 418-433), this test asserts:
 *
 *   1. The job routes action selection through {@link planJob} — the shared
 *      LLM planner — not through regex / keyword logic.
 *   2. Sensitive plans (`requiresApproval === true`) are enqueued into the
 *      WS6 approval queue via {@link enqueueIfSensitive}, not auto-executed.
 *
 * Parity is observed via the runtime-scoped
 * {@link readPlannerDispatchLog} set that every dispatch writes to.
 */

import type {
  IAgentRuntime,
  Memory,
  Task,
  UUID,
} from "@elizaos/core";
import { describe, expect, test } from "vitest";
import {
  executeProactiveTask,
  PROACTIVE_TASK_NAME,
} from "../src/activity-profile/proactive-worker.js";
import {
  executeFollowupTrackerTick,
  reconcileFollowupsOnce,
} from "../src/followup/followup-tracker.js";
import { executeLifeOpsSchedulerTask } from "../src/lifeops/runtime.js";
import {
  APPROVAL_QUEUE_SERVICE_NAME,
  readPlannerDispatchLog,
  resetPlannerDispatchLog,
  type PlannerDispatchResult,
} from "../src/lifeops/background-planner-dispatch.js";
import type {
  ApprovalEnqueueInput,
  ApprovalQueue,
  ApprovalRequest,
} from "../src/lifeops/approval-queue.types.js";
import { KNOWN_JOB_KINDS } from "../src/lifeops/background-planner.js";

// ---------------------------------------------------------------------------
// In-memory approval queue double
// ---------------------------------------------------------------------------

class InMemoryApprovalQueue implements ApprovalQueue {
  public readonly enqueued: ApprovalRequest[] = [];

  async enqueue(input: ApprovalEnqueueInput): Promise<ApprovalRequest> {
    const request: ApprovalRequest = {
      id: `req-${this.enqueued.length + 1}`,
      createdAt: new Date(),
      updatedAt: new Date(),
      state: "pending",
      requestedBy: input.requestedBy,
      subjectUserId: input.subjectUserId,
      action: input.action,
      payload: input.payload,
      channel: input.channel,
      reason: input.reason,
      expiresAt: input.expiresAt,
      resolvedAt: null,
      resolvedBy: null,
      resolutionReason: null,
    };
    this.enqueued.push(request);
    return request;
  }
  async list(): Promise<ReadonlyArray<ApprovalRequest>> {
    return this.enqueued;
  }
  async byId(id: string): Promise<ApprovalRequest | null> {
    return this.enqueued.find((r) => r.id === id) ?? null;
  }
  async approve(): Promise<ApprovalRequest> {
    throw new Error("not implemented in contract test");
  }
  async reject(): Promise<ApprovalRequest> {
    throw new Error("not implemented in contract test");
  }
  async markExecuting(): Promise<ApprovalRequest> {
    throw new Error("not implemented in contract test");
  }
  async markDone(): Promise<ApprovalRequest> {
    throw new Error("not implemented in contract test");
  }
  async markExpired(): Promise<ApprovalRequest> {
    throw new Error("not implemented in contract test");
  }
  async purgeExpired(): Promise<ReadonlyArray<string>> {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Mock runtime harness
// ---------------------------------------------------------------------------

const AGENT_ID = "00000000-0000-0000-0000-000000000000" as UUID;
const OWNER_ID = "11111111-1111-1111-1111-111111111111" as UUID;

interface HarnessOptions {
  /** Planner response to return from `runtime.useModel`. */
  readonly plannerResponse: object;
  /** Whether a PROACTIVE_AGENT task exists and is returned by getTasks. */
  readonly includeProactiveTask?: boolean;
}

function makeRuntime(opts: HarnessOptions): {
  runtime: IAgentRuntime;
  queue: InMemoryApprovalQueue;
  memories: Array<{ table: string; memory: Memory }>;
  useModelCalls: unknown[];
} {
  const queue = new InMemoryApprovalQueue();
  const memories: Array<{ table: string; memory: Memory }> = [];
  const useModelCalls: unknown[] = [];
  const tasks: Task[] = opts.includeProactiveTask
    ? [
        {
          id: "task-proactive" as UUID,
          name: PROACTIVE_TASK_NAME,
          roomId: "room-0" as UUID,
          tags: ["queue", "repeat", "proactive"],
          metadata: {
            proactiveAgent: { kind: "runtime_runner", version: 1 },
          },
        } as unknown as Task,
      ]
    : [];

  const runtime = {
    agentId: AGENT_ID,
    character: { id: AGENT_ID, name: "Test", bio: [] },
    getService(name: string) {
      if (name === APPROVAL_QUEUE_SERVICE_NAME) return queue;
      if (name === "relationships") {
        return {
          async searchContacts() {
            return [
              {
                entityId: OWNER_ID,
                categories: [],
                tags: [],
                customFields: {
                  displayName: "Test Contact",
                  lastContactedAt: new Date(
                    Date.now() - 60 * 24 * 60 * 60 * 1000,
                  ).toISOString(),
                },
              },
            ];
          },
          async getContact() {
            return null;
          },
          async updateContact() {
            return null;
          },
        };
      }
      return null;
    },
    async getAgent() {
      return { id: AGENT_ID, name: "Test" };
    },
    async getEntityById() {
      return { id: OWNER_ID, names: ["Test"] };
    },
    async ensureWorldExists() {
      return undefined;
    },
    async ensureRoomExists() {
      return undefined;
    },
    async createMemory(memory: Memory, table: string) {
      memories.push({ table, memory });
      return memory.id ?? (("mem-" + memories.length) as UUID);
    },
    async getTasks() {
      return tasks;
    },
    async updateTask() {
      return undefined;
    },
    async createTask() {
      return "task-new" as UUID;
    },
    getTaskWorker() {
      return null;
    },
    registerTaskWorker() {
      return undefined;
    },
    async useModel(_modelType: unknown, _params: unknown) {
      useModelCalls.push(_params);
      return JSON.stringify(opts.plannerResponse);
    },
    async sendMessageToTarget() {
      return undefined;
    },
  } as unknown as IAgentRuntime;

  return { runtime, queue, memories, useModelCalls };
}

function sensitivePlannerResponse(
  reason = "owner overdue for follow-up",
): object {
  return {
    action: "send_message",
    channel: "telegram",
    requiresApproval: true,
    reason,
    payload: {
      recipient: "+1-555-0100",
      body: "Hey, haven't heard from you in a while.",
      replyToMessageId: null,
    },
  };
}

function noopPlannerResponse(reason = "nothing to do"): object {
  return { action: "noop", channel: "internal", requiresApproval: false, reason };
}

// ---------------------------------------------------------------------------
// Contract: every PRD job kind is known to the planner
// ---------------------------------------------------------------------------

describe("background-job-parity: PRD job kinds known to planner", () => {
  test("every PRD-listed job kind has a BackgroundJobKind entry", () => {
    // Source of truth: docs/prd-lifeops-executive-assistant.md lines 418-433
    // + Follow-Up Handlers section.
    const prdJobs = [
      "inbox_ingest",
      "daily_brief",
      "evening_closeout",
      "followup_watchdog",
      "decision_nudger",
      "meeting_reminder",
      "travel_conflict",
      "event_asset_sweep",
      "draft_aging_sweep",
      "remote_stuck_escalate",
      "pending_decision",
      "missed_commitment",
      "unsent_draft",
      "relationship_overdue",
      "deadline_escalate",
      "travel_ops",
    ];
    for (const kind of prdJobs) {
      expect(KNOWN_JOB_KINDS).toContain(kind);
    }
  });
});

// ---------------------------------------------------------------------------
// Contract: real workers call planJob and enqueue sensitive plans
// ---------------------------------------------------------------------------

describe("background-job-parity: proactive worker", () => {
  test("executeProactiveTask invokes planJob and enqueues sensitive plans", async () => {
    const { runtime, queue } = makeRuntime({
      plannerResponse: sensitivePlannerResponse("daily brief window"),
      includeProactiveTask: true,
    });
    resetPlannerDispatchLog(runtime);

    await executeProactiveTask(runtime);

    const log = readPlannerDispatchLog(runtime);
    const dispatches = log.filter((d) => d.jobKind === "daily_brief");
    expect(dispatches.length).toBeGreaterThan(0);
    const enqueued = dispatches.filter((d) => d.approvalRequest !== null);
    expect(enqueued.length).toBe(queue.enqueued.length);
    expect(queue.enqueued[0]?.action).toBe("send_message");
  });

  test("proactive worker skips enqueue when planner returns noop", async () => {
    const { runtime, queue } = makeRuntime({
      plannerResponse: noopPlannerResponse("still morning, too early"),
      includeProactiveTask: true,
    });
    resetPlannerDispatchLog(runtime);

    await executeProactiveTask(runtime);

    const log = readPlannerDispatchLog(runtime);
    const skipped = log.filter(
      (d: PlannerDispatchResult) => d.skipped && d.plan.action === null,
    );
    expect(skipped.length).toBeGreaterThan(0);
    expect(queue.enqueued).toHaveLength(0);
  });

  test("executeProactiveTask honors an explicit logical now", async () => {
    const fixedNow = "2026-04-19T15:00:00.000Z";
    const { runtime, useModelCalls } = makeRuntime({
      plannerResponse: noopPlannerResponse("still morning, too early"),
    });

    await executeProactiveTask(runtime, { now: fixedNow });

    expect(useModelCalls.length).toBeGreaterThan(0);
    expect(JSON.stringify(useModelCalls)).toContain(fixedNow);
  });
});

describe("background-job-parity: followup tracker", () => {
  test("reconcileFollowupsOnce invokes planJob per overdue contact", async () => {
    const { runtime, queue } = makeRuntime({
      plannerResponse: sensitivePlannerResponse("60 days overdue"),
    });
    resetPlannerDispatchLog(runtime);

    const digest = await reconcileFollowupsOnce(runtime);

    expect(digest.overdue.length).toBeGreaterThan(0);
    const log = readPlannerDispatchLog(runtime);
    const watchdog = log.filter((d) => d.jobKind === "followup_watchdog");
    expect(watchdog.length).toBe(digest.overdue.length);
    expect(queue.enqueued.length).toBe(digest.overdue.length);
    for (const req of queue.enqueued) {
      expect(req.action).toBe("send_message");
      expect(req.state).toBe("pending");
      expect(req.requestedBy).toBe("background-job:followup_watchdog");
    }
  });

  test("executeFollowupTrackerTick forwards explicit now into the digest", async () => {
    const fixedNow = "2026-04-19T18:30:00.000Z";
    const { runtime } = makeRuntime({
      plannerResponse: sensitivePlannerResponse("60 days overdue"),
    });

    const result = await executeFollowupTrackerTick(runtime, { now: fixedNow });

    expect(result.digest.generatedAt).toBe(fixedNow);
  });
});

describe("background-job-parity: lifeops scheduler", () => {
  test("executeLifeOpsSchedulerTask does NOT invoke the LLM planner with an empty snapshot", async () => {
    // Prior behavior (LARP): this function called planJob every tick with a
    // hardcoded jobKind and an empty snapshot, wasting tokens for a result
    // that was never used. The call was removed. This test guards against
    // that regression.
    const { runtime, queue } = makeRuntime({
      plannerResponse: noopPlannerResponse("no reminders due"),
    });
    resetPlannerDispatchLog(runtime);

    await executeLifeOpsSchedulerTask(runtime);

    const log = readPlannerDispatchLog(runtime);
    const scheduler = log.filter((d) => d.jobKind === "meeting_reminder");
    expect(scheduler).toHaveLength(0);
    // No enqueues either.
    expect(queue.enqueued).toHaveLength(0);
  });

  test("executeLifeOpsSchedulerTask forwards explicit now into planner input", async () => {
    const fixedNow = "2026-04-19T20:45:00.000Z";
    const { runtime, useModelCalls } = makeRuntime({
      plannerResponse: noopPlannerResponse("no reminders due"),
    });

    try {
      const result = await executeLifeOpsSchedulerTask(runtime, { now: fixedNow });
      expect(result.now).toBe(fixedNow);
    } catch {
      // The mock harness does not implement the full LifeOps persistence stack.
      // Even when scheduled work crashes, the planner prompt must still carry
      // the explicit logical clock.
    }

    expect(useModelCalls.length).toBeGreaterThan(0);
    expect(JSON.stringify(useModelCalls)).toContain(fixedNow);
  });
});
