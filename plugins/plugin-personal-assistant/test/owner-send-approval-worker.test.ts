/**
 * Owner send-approval worker (issue #10723 Bug 1).
 *
 * The old flow created an approval task named `OWNER_SEND_APPROVAL_<timestamp>`
 * and DISCARDED the executor (`void executor;`). Core's CHOOSE_OPTION resolves
 * the task worker by the task's `name`; no worker was ever registered, so its
 * `if (taskWorker)` guard fell through to a success reply and the approved
 * send never executed. These tests drive the same worker-lookup contract core
 * uses (see packages/core/src/features/basic-capabilities/actions/choice.ts)
 * against the fixed flow: one stable worker name, executor held per task id.
 *
 * Run: bunx vitest run test/owner-send-approval-worker.test.ts
 */

import { randomUUID } from "node:crypto";
import type {
  DraftRequest,
  IAgentRuntime,
  Task,
  TaskWorker,
  UUID,
} from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import {
  createOwnerSendPolicy,
  OWNER_SEND_APPROVAL_TASK_NAME,
  registerOwnerSendApprovalWorker,
} from "../src/lifeops/messaging/owner-send-policy.js";

interface FakeRuntimeHarness {
  readonly runtime: IAgentRuntime;
  readonly createdTasks: Task[];
  readonly deletedTaskIds: UUID[];
  readonly workers: Map<string, TaskWorker>;
}

function makeRuntime(): FakeRuntimeHarness {
  const workers = new Map<string, TaskWorker>();
  const createdTasks: Task[] = [];
  const deletedTaskIds: UUID[] = [];
  const runtime = {
    agentId: randomUUID() as UUID,
    registerTaskWorker: (worker: TaskWorker) => {
      workers.set(worker.name, worker);
    },
    getTaskWorker: (name: string) => workers.get(name),
    createTask: async (task: Task) => {
      const id = randomUUID() as UUID;
      createdTasks.push({ ...task, id });
      return id;
    },
    deleteTask: async (id: UUID) => {
      deletedTaskIds.push(id);
    },
  } as unknown as IAgentRuntime;
  return { runtime, createdTasks, deletedTaskIds, workers };
}

function makeDraft(): DraftRequest {
  return {
    source: "gmail",
    to: [{ identifier: "ada@example.com", displayName: "Ada" }],
    subject: "Quarterly numbers",
    body: "Sending the quarterly numbers as discussed.",
    metadata: {},
  };
}

/**
 * Mirror of core CHOOSE_OPTION's task-option dispatch: resolve the worker by
 * the task's name and execute it only when found. With the old per-timestamp
 * task name this returned `executed: false` — the exact silent-success bug.
 */
async function dispatchChosenOption(
  runtime: IAgentRuntime,
  task: Task,
  option: string,
): Promise<{ executed: boolean }> {
  const worker = runtime.getTaskWorker(task.name);
  if (!worker) return { executed: false };
  await worker.execute(runtime, { option }, task);
  return { executed: true };
}

async function enqueue(harness: FakeRuntimeHarness) {
  const executor = vi.fn(async () => ({ externalId: "ext-msg-1" }));
  const policy = createOwnerSendPolicy();
  const enq = await policy.enqueueApproval(
    harness.runtime,
    makeDraft(),
    executor,
  );
  const task = harness.createdTasks.at(-1);
  if (!task) throw new Error("enqueueApproval created no task");
  return { executor, enq, task };
}

describe("owner send-approval worker", () => {
  it("approve (confirm) actually executes the held send", async () => {
    const harness = makeRuntime();
    const { executor, enq, task } = await enqueue(harness);

    // The created task must resolve to a registered worker by name — this is
    // the contract core CHOOSE_OPTION relies on and what the old code broke.
    expect(task.name).toBe(OWNER_SEND_APPROVAL_TASK_NAME);
    expect(harness.runtime.getTaskWorker(task.name)).toBeDefined();
    expect(enq.requestId).toBe(String(task.id));

    const result = await dispatchChosenOption(harness.runtime, task, "confirm");
    expect(result.executed).toBe(true);
    expect(executor).toHaveBeenCalledTimes(1);
    expect(harness.deletedTaskIds).toContain(task.id);
  });

  it("reject (cancel) executes nothing and clears the task", async () => {
    const harness = makeRuntime();
    const { executor, task } = await enqueue(harness);

    const result = await dispatchChosenOption(harness.runtime, task, "cancel");
    expect(result.executed).toBe(true);
    expect(executor).not.toHaveBeenCalled();
    expect(harness.deletedTaskIds).toContain(task.id);

    // A later confirm on the same (now cancelled) task must not send either.
    await expect(
      dispatchChosenOption(harness.runtime, task, "confirm"),
    ).rejects.toThrow(/no longer execute/u);
    expect(executor).not.toHaveBeenCalled();
  });

  it("unknown option hard-fails without sending", async () => {
    const harness = makeRuntime();
    const { executor, task } = await enqueue(harness);

    await expect(
      dispatchChosenOption(harness.runtime, task, "resend-later"),
    ).rejects.toThrow(/unknown option/u);
    expect(executor).not.toHaveBeenCalled();
  });

  it("unknown action metadata hard-fails without sending", async () => {
    const harness = makeRuntime();
    const { executor, task } = await enqueue(harness);
    const tampered: Task = {
      ...task,
      metadata: { ...task.metadata, actionName: "SOMETHING_ELSE" },
    };

    await expect(
      dispatchChosenOption(harness.runtime, tampered, "confirm"),
    ).rejects.toThrow(/unknown action/u);
    expect(executor).not.toHaveBeenCalled();
  });

  it("lost executor (restart) hard-fails and deletes the dead task", async () => {
    // Simulate a restart: the task row survived, the in-memory executor did
    // not. A fresh runtime has the worker registered but no held executor.
    const stale = makeRuntime();
    const { task } = await enqueue(stale);
    const fresh = makeRuntime();
    registerOwnerSendApprovalWorker(fresh.runtime);

    await expect(
      dispatchChosenOption(fresh.runtime, task, "confirm"),
    ).rejects.toThrow(/no longer execute/u);
    expect(fresh.deletedTaskIds).toContain(task.id);
  });

  it("worker registration is idempotent", async () => {
    const harness = makeRuntime();
    registerOwnerSendApprovalWorker(harness.runtime);
    const first = harness.runtime.getTaskWorker(OWNER_SEND_APPROVAL_TASK_NAME);
    registerOwnerSendApprovalWorker(harness.runtime);
    expect(harness.runtime.getTaskWorker(OWNER_SEND_APPROVAL_TASK_NAME)).toBe(
      first,
    );
  });

  it("a concurrent duplicate confirm does not double-send (atomic claim)", async () => {
    const harness = makeRuntime();
    // Gate the send so both confirms are in-flight before either completes —
    // this is the window a second CHOOSE_OPTION confirm for the same task could
    // slip through if the executor were only consumed AFTER the awaited send.
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let sends = 0;
    const executor = vi.fn(async () => {
      sends += 1;
      await gate;
      return { externalId: `ext-${sends}` };
    });
    const policy = createOwnerSendPolicy();
    await policy.enqueueApproval(harness.runtime, makeDraft(), executor);
    const task = harness.createdTasks.at(-1);
    if (!task) throw new Error("enqueueApproval created no task");

    // Two overlapping confirms for the SAME task, then release the gated send.
    const first = dispatchChosenOption(harness.runtime, task, "confirm");
    const second = dispatchChosenOption(harness.runtime, task, "confirm");
    release();
    const settled = await Promise.allSettled([first, second]);

    // Exactly one send happened; the loser rejected with re-send guidance and
    // never invoked the executor. Consuming the executor before the await makes
    // the claim atomic on the single-threaded event loop.
    expect(sends).toBe(1);
    expect(executor).toHaveBeenCalledTimes(1);
    const rejected = settled.filter((r) => r.status === "rejected");
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      message: expect.stringMatching(/no longer execute/u),
    });
  });
});
