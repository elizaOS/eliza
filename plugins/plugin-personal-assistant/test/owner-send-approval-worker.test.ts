/**
 * Owner send-approval worker (issues #10723 Bug 1 and #10721).
 *
 * The original flow created an approval task named
 * `OWNER_SEND_APPROVAL_<timestamp>` and DISCARDED the executor; the #10723
 * fix registered one stable worker holding executors as in-memory closures —
 * which meant an approved send hard-failed after a process restart. These
 * tests pin the restart-safe contract: the full draft payload is persisted
 * in the task row at enqueue time and the worker reconstructs the send from
 * that persisted state (adapter.createDraft + adapter.sendDraft), never from
 * a closure. Task rows are modelled as a Map shared across "restarted"
 * runtimes and every row round-trips through JSON on write and read,
 * mirroring the JSONB-backed task table — a payload that is not
 * JSON-serializable cannot fake persistence here.
 *
 * Run: bunx vitest run test/owner-send-approval-worker.test.ts
 */

import { randomUUID } from "node:crypto";
import type {
  DraftRequest,
  IAgentRuntime,
  MessageAdapter,
  MessageAdapterCapabilities,
  MessageRef,
  Task,
  TaskWorker,
  UUID,
} from "@elizaos/core";
import {
  __resetDefaultTriageServiceForTests,
  getDefaultTriageService,
} from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createOwnerSendPolicy,
  OWNER_SEND_APPROVAL_TASK_NAME,
  registerOwnerSendApprovalWorker,
} from "../src/lifeops/messaging/owner-send-policy.js";

interface FakeRuntimeHarness {
  readonly runtime: IAgentRuntime;
  /** Persisted task rows — share across harnesses to model a DB restart. */
  readonly rows: Map<string, Task>;
  readonly deletedTaskIds: UUID[];
  readonly workers: Map<string, TaskWorker>;
}

/**
 * Model the database boundary: real task rows live in a JSONB column, so
 * everything written at enqueue time round-trips through JSON. Anything not
 * JSON-safe (a closure, a Date, an `undefined` field) is lost here exactly
 * as it would be in the real task table — a payload that only "persists"
 * inside process memory cannot pass these tests.
 */
function jsonRoundTrip<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function makeRuntime(rows?: Map<string, Task>): FakeRuntimeHarness {
  const workers = new Map<string, TaskWorker>();
  const taskRows = rows ?? new Map<string, Task>();
  const deletedTaskIds: UUID[] = [];
  const runtime = {
    agentId: randomUUID() as UUID,
    registerTaskWorker: (worker: TaskWorker) => {
      workers.set(worker.name, worker);
    },
    getTaskWorker: (name: string) => workers.get(name),
    createTask: async (task: Task) => {
      const id = randomUUID() as UUID;
      taskRows.set(String(id), jsonRoundTrip({ ...task, id }));
      return id;
    },
    getTask: async (id: UUID) => {
      const row = taskRows.get(String(id));
      return row ? jsonRoundTrip(row) : null;
    },
    deleteTask: async (id: UUID) => {
      taskRows.delete(String(id));
      deletedTaskIds.push(id);
    },
  } as unknown as IAgentRuntime;
  return { runtime, rows: taskRows, deletedTaskIds, workers };
}

/**
 * Recording message adapter registered over the default gmail adapter. Sends
 * are only observable through this — if the worker "succeeds" without going
 * through createDraft + sendDraft, the assertions fail.
 */
class RecordingAdapter implements MessageAdapter {
  readonly source = "gmail" as const;
  readonly createDraftCalls: DraftRequest[] = [];
  readonly sentDraftIds: string[] = [];
  /** Optional gate awaited inside sendDraft for concurrency tests. */
  sendGate: Promise<void> | null = null;
  private seq = 0;

  isAvailable(): boolean {
    return true;
  }
  capabilities(): MessageAdapterCapabilities {
    return {
      list: true,
      search: false,
      manage: {},
      send: { reply: true, new: true },
      worlds: "single",
      channels: "none",
    };
  }
  async listMessages(): Promise<MessageRef[]> {
    return [];
  }
  async getMessage(): Promise<MessageRef | null> {
    return null;
  }
  async createDraft(
    _runtime: IAgentRuntime,
    draft: DraftRequest,
  ): Promise<{ draftId: string; preview: string }> {
    this.createDraftCalls.push(draft);
    this.seq += 1;
    return {
      draftId: `rec-draft-${this.seq}`,
      preview: draft.body.slice(0, 40),
    };
  }
  async sendDraft(
    _runtime: IAgentRuntime,
    draftId: string,
  ): Promise<{ externalId: string }> {
    if (this.sendGate) await this.sendGate;
    this.sentDraftIds.push(draftId);
    return { externalId: `ext-${draftId}` };
  }
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
 * the task's name and execute it only when found.
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
  // The closure executor core hands the policy — must never be what sends.
  const executor = vi.fn(async () => ({ externalId: "closure-ext" }));
  const policy = createOwnerSendPolicy();
  const enq = await policy.enqueueApproval(
    harness.runtime,
    makeDraft(),
    executor,
  );
  const task = harness.rows.get(enq.requestId);
  if (!task) throw new Error("enqueueApproval created no task row");
  return { executor, enq, task };
}

let adapter: RecordingAdapter;

beforeEach(() => {
  __resetDefaultTriageServiceForTests();
  adapter = new RecordingAdapter();
  getDefaultTriageService().register(adapter);
});

afterEach(() => {
  __resetDefaultTriageServiceForTests();
});

describe("owner send-approval worker", () => {
  it("approve (confirm) executes the send from the persisted payload, not the closure", async () => {
    const harness = makeRuntime();
    const { executor, enq, task } = await enqueue(harness);

    expect(task.name).toBe(OWNER_SEND_APPROVAL_TASK_NAME);
    expect(harness.runtime.getTaskWorker(task.name)).toBeDefined();
    expect(enq.requestId).toBe(String(task.id));

    const result = await dispatchChosenOption(harness.runtime, task, "confirm");
    expect(result.executed).toBe(true);

    // The send went through the adapter with the enqueued draft content.
    expect(adapter.createDraftCalls).toHaveLength(1);
    expect(adapter.createDraftCalls[0]).toMatchObject({
      source: "gmail",
      subject: "Quarterly numbers",
      body: "Sending the quarterly numbers as discussed.",
      to: [{ identifier: "ada@example.com", displayName: "Ada" }],
    });
    expect(adapter.sentDraftIds).toEqual(["rec-draft-1"]);
    // The closure executor is dead weight by design — never invoked.
    expect(executor).not.toHaveBeenCalled();
    expect(harness.deletedTaskIds).toContain(task.id);
    // The triage store learned about the sent draft.
    const stored = getDefaultTriageService().getStore().getDraft("rec-draft-1");
    expect(stored).toMatchObject({
      sent: true,
      sentExternalId: "ext-rec-draft-1",
    });
  });

  it("an approved send survives a restart: new runtime + new triage service, send reconstructs from the persisted row", async () => {
    // Enqueue on the pre-restart runtime.
    const stale = makeRuntime();
    const { executor, task } = await enqueue(stale);

    // Simulated restart: every in-memory structure is rebuilt — new runtime,
    // new triage service/adapters, re-registered worker. Only the task rows
    // (the database) survive.
    __resetDefaultTriageServiceForTests();
    const freshAdapter = new RecordingAdapter();
    getDefaultTriageService().register(freshAdapter);
    const fresh = makeRuntime(stale.rows);
    registerOwnerSendApprovalWorker(fresh.runtime);

    const result = await dispatchChosenOption(fresh.runtime, task, "confirm");
    expect(result.executed).toBe(true);
    expect(freshAdapter.createDraftCalls).toHaveLength(1);
    expect(freshAdapter.createDraftCalls[0]).toMatchObject({
      source: "gmail",
      subject: "Quarterly numbers",
      body: "Sending the quarterly numbers as discussed.",
      to: [{ identifier: "ada@example.com", displayName: "Ada" }],
    });
    expect(freshAdapter.sentDraftIds).toEqual(["rec-draft-1"]);
    expect(executor).not.toHaveBeenCalled();
    expect(fresh.rows.has(String(task.id))).toBe(false);
  });

  it("reject (cancel) executes nothing and clears the task", async () => {
    const harness = makeRuntime();
    const { task } = await enqueue(harness);

    const result = await dispatchChosenOption(harness.runtime, task, "cancel");
    expect(result.executed).toBe(true);
    expect(adapter.createDraftCalls).toHaveLength(0);
    expect(adapter.sentDraftIds).toHaveLength(0);
    expect(harness.deletedTaskIds).toContain(task.id);

    // A subsequent confirm replaying the stale task object must not send: the
    // live-row re-read sees the deletion.
    await expect(
      dispatchChosenOption(harness.runtime, task, "confirm"),
    ).rejects.toThrow(/no longer exists/u);
    expect(adapter.sentDraftIds).toHaveLength(0);
  });

  it("a stale confirm replay after a completed send does not send twice", async () => {
    const harness = makeRuntime();
    const { task } = await enqueue(harness);

    await dispatchChosenOption(harness.runtime, task, "confirm");
    expect(adapter.sentDraftIds).toHaveLength(1);

    await expect(
      dispatchChosenOption(harness.runtime, task, "confirm"),
    ).rejects.toThrow(/no longer exists/u);
    expect(adapter.createDraftCalls).toHaveLength(1);
    expect(adapter.sentDraftIds).toHaveLength(1);
  });

  it("unknown option hard-fails without sending", async () => {
    const harness = makeRuntime();
    const { task } = await enqueue(harness);

    await expect(
      dispatchChosenOption(harness.runtime, task, "resend-later"),
    ).rejects.toThrow(/unknown option/u);
    expect(adapter.sentDraftIds).toHaveLength(0);
  });

  it("unknown action metadata hard-fails without sending", async () => {
    const harness = makeRuntime();
    const { task } = await enqueue(harness);
    const tampered: Task = {
      ...task,
      metadata: { ...task.metadata, actionName: "SOMETHING_ELSE" },
    };

    await expect(
      dispatchChosenOption(harness.runtime, tampered, "confirm"),
    ).rejects.toThrow(/unknown action/u);
    expect(adapter.sentDraftIds).toHaveLength(0);
  });

  it("a missing or invalid persisted payload hard-fails, deletes the dead task, and sends nothing", async () => {
    const harness = makeRuntime();
    const { task } = await enqueue(harness);
    // Corrupt the persisted row (e.g. a bad migration): body dropped.
    const row = harness.rows.get(String(task.id));
    if (!row) throw new Error("row missing");
    const payload = (row.metadata?.payload ?? {}) as Record<string, unknown>;
    harness.rows.set(String(task.id), {
      ...row,
      metadata: {
        ...row.metadata,
        payload: { ...payload, body: undefined },
      },
    });

    await expect(
      dispatchChosenOption(harness.runtime, task, "confirm"),
    ).rejects.toThrow(/invalid persisted draft payload/u);
    expect(adapter.sentDraftIds).toHaveLength(0);
    expect(harness.rows.has(String(task.id))).toBe(false);
  });

  it("a source with no registered adapter hard-fails, keeps the task for retry, and sends nothing", async () => {
    const harness = makeRuntime();
    const policy = createOwnerSendPolicy();
    const enq = await policy.enqueueApproval(
      harness.runtime,
      { ...makeDraft(), source: "calendly" },
      vi.fn(async () => ({ externalId: "closure-ext" })),
    );
    const task = harness.rows.get(enq.requestId);
    if (!task) throw new Error("enqueueApproval created no task row");

    await expect(
      dispatchChosenOption(harness.runtime, task, "confirm"),
    ).rejects.toThrow(/no "calendly" message adapter/u);
    expect(adapter.sentDraftIds).toHaveLength(0);
    // Retriable: the row survives so the owner can confirm again once the
    // connector is available.
    expect(harness.rows.has(String(task.id))).toBe(true);
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
    const { task } = await enqueue(harness);
    // Gate the send so both confirms are in-flight before either completes.
    let release: () => void = () => undefined;
    adapter.sendGate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const first = dispatchChosenOption(harness.runtime, task, "confirm");
    const second = dispatchChosenOption(harness.runtime, task, "confirm");
    release();
    const settled = await Promise.allSettled([first, second]);

    // Exactly one send happened; the loser rejected on the synchronous claim
    // before reaching the adapter.
    expect(adapter.sentDraftIds).toHaveLength(1);
    const rejected = settled.filter((r) => r.status === "rejected");
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      message: expect.stringMatching(/already executing/u),
    });
  });

  it("cancel racing an in-flight confirm fails loudly instead of claiming nothing was sent", async () => {
    const harness = makeRuntime();
    const { task } = await enqueue(harness);
    let release: () => void = () => undefined;
    adapter.sendGate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const confirm = dispatchChosenOption(harness.runtime, task, "confirm");
    await expect(
      dispatchChosenOption(harness.runtime, task, "cancel"),
    ).rejects.toThrow(/already executing/u);
    release();
    await confirm;
    expect(adapter.sentDraftIds).toHaveLength(1);
  });
});
