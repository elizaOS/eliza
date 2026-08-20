/**
 * Composes deterministic background control with the production personal-
 * assistant owner-send approval worker and durable triage draft store.
 */

import {
  __resetDefaultTriageServiceForTests,
  type AgentRuntime,
  type DraftRequest,
  getDefaultTriageService,
  type IAgentRuntime,
  type MessageAdapter,
  type MessageAdapterCapabilities,
  type MessageRef,
  ServiceType,
  type Task,
  TaskService,
  type TaskWorker,
  type UUID,
} from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createOwnerSendPolicy,
  OWNER_SEND_APPROVAL_TASK_NAME,
  OWNER_SEND_OUTBOX_TASK_NAME,
  OwnerSendKnownNonDeliveryError,
} from "../../../plugins/plugin-personal-assistant/src/lifeops/messaging/owner-send-policy.ts";
import { ScenarioBackgroundRuntime } from "./background-runtime.ts";

const AGENT_ID = "00000000-0000-0000-0000-000000022902" as UUID;
const EPOCH = "2026-08-20T12:00:00.000Z";

function jsonRoundTrip<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function createRuntimeHarness() {
  const rows = new Map<string, Task>();
  const workers = new Map<string, TaskWorker>();
  const services = new Map<string, unknown>();
  let sequence = 0;
  const runtime = {
    agentId: AGENT_ID,
    serverless: true,
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    adapter: {
      getTasks: async () =>
        [...rows.values()].filter((task) => task.tags?.includes("queue")),
    },
    registerTaskWorker(worker: TaskWorker) {
      workers.set(worker.name, worker);
    },
    unregisterTaskWorker(name: string) {
      return workers.delete(name);
    },
    getTaskWorker(name: string) {
      return workers.get(name);
    },
    async getTasks() {
      return [...rows.values()].filter((task) => task.tags?.includes("queue"));
    },
    async getTask(id: UUID) {
      const task = rows.get(String(id));
      return task ? jsonRoundTrip(task) : null;
    },
    async createTask(task: Task) {
      sequence += 1;
      const id = (task.id ?? `approval-${sequence}`) as UUID;
      rows.set(String(id), jsonRoundTrip({ ...task, id, agentId: AGENT_ID }));
      return id;
    },
    async updateTask(id: UUID, patch: Partial<Task>) {
      const task = rows.get(String(id));
      if (!task) throw new Error(`missing task ${id}`);
      rows.set(String(id), jsonRoundTrip({ ...task, ...patch }));
    },
    async deleteTask(id: UUID) {
      rows.delete(String(id));
    },
    getService(type: string) {
      return services.get(type) ?? null;
    },
    async getServiceLoadPromise(type: string) {
      const service = services.get(type);
      if (!service) throw new Error(`missing service ${type}`);
      return service;
    },
    reportError: vi.fn(),
    getRecentReportedErrors: () => [],
  } as unknown as IAgentRuntime;
  return { rows, runtime, services, workers };
}

class RecoveringMessageAdapter implements MessageAdapter {
  readonly source = "gmail" as const;
  readonly createdDraftIds: string[] = [];
  readonly acceptedDraftIds: string[] = [];
  failuresBeforeAcceptance = 2;
  private sequence = 0;

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
    _draft: DraftRequest,
  ): Promise<{ draftId: string; preview: string }> {
    this.sequence += 1;
    const draftId = `approval-draft-${this.sequence}`;
    this.createdDraftIds.push(draftId);
    return { draftId, preview: "Quarterly numbers" };
  }

  async sendDraft(
    _runtime: IAgentRuntime,
    draftId: string,
  ): Promise<{ externalId: string }> {
    if (this.failuresBeforeAcceptance > 0) {
      this.failuresBeforeAcceptance -= 1;
      throw new OwnerSendKnownNonDeliveryError(
        "connector unavailable before provider acceptance",
      );
    }
    this.acceptedDraftIds.push(draftId);
    return { externalId: `external-${draftId}` };
  }
}

class AmbiguousAcceptanceAdapter extends RecoveringMessageAdapter {
  override failuresBeforeAcceptance = 0;

  override async sendDraft(
    _runtime: IAgentRuntime,
    draftId: string,
  ): Promise<{ externalId: string }> {
    this.acceptedDraftIds.push(draftId);
    throw new Error("connection closed after provider may have accepted send");
  }
}

const taskServices: TaskService[] = [];

beforeEach(() => {
  __resetDefaultTriageServiceForTests();
});

afterEach(async () => {
  __resetDefaultTriageServiceForTests();
  await Promise.all(taskServices.splice(0).map((service) => service.stop()));
});

describe("ScenarioBackgroundRuntime approval and outbox composition", () => {
  it("recovers a zero-delivery outage, persists the outbox receipt, and rejects stale replay", async () => {
    const harness = createRuntimeHarness();
    const taskService = (await TaskService.start(
      harness.runtime,
    )) as TaskService;
    taskServices.push(taskService);
    harness.services.set(ServiceType.TASK, taskService);
    const adapter = new RecoveringMessageAdapter();
    getDefaultTriageService().register(adapter);

    const policy = createOwnerSendPolicy();
    const approval = await policy.enqueueApproval(
      harness.runtime,
      {
        source: "gmail",
        to: [{ identifier: "owner@example.com", displayName: "Owner" }],
        subject: "Quarterly numbers",
        body: "Sending the quarterly numbers as discussed.",
        metadata: {},
      },
      vi.fn(async () => ({ externalId: "forbidden-closure" })),
    );
    const staleTask = harness.rows.get(approval.requestId);
    if (!staleTask) throw new Error("approval row was not persisted");
    const background = new ScenarioBackgroundRuntime(
      harness.runtime as unknown as AgentRuntime,
      {
        namespace: "scenario:approval-outbox",
        epoch: EPOCH,
        workers: [OWNER_SEND_OUTBOX_TASK_NAME],
      },
    );
    await background.captureBaseline();
    await background.start();

    const approvalWorker = harness.workers.get(OWNER_SEND_APPROVAL_TASK_NAME);
    if (!approvalWorker) throw new Error("approval worker unavailable");
    await expect(
      approvalWorker.execute(harness.runtime, { option: "confirm" }, staleTask),
    ).rejects.toThrow("connector unavailable before provider acceptance");
    expect(adapter.acceptedDraftIds).toEqual([]);
    expect(harness.rows.has(approval.requestId)).toBe(true);
    expect(harness.rows.get(approval.requestId)).toMatchObject({
      name: OWNER_SEND_OUTBOX_TASK_NAME,
      tags: expect.arrayContaining(["queue", "repeat", "OUTBOX"]),
    });
    expect(
      getDefaultTriageService().getStore().getDraft("approval-draft-1"),
    ).toMatchObject({ sent: false });

    await expect(background.step()).rejects.toThrow(
      "1 scheduled task failure(s)",
    );
    expect(adapter.createdDraftIds).toEqual(["approval-draft-1"]);
    expect(adapter.acceptedDraftIds).toEqual([]);
    expect(harness.rows.get(approval.requestId)?.metadata).toMatchObject({
      failureCount: 1,
      baseInterval: 1_000,
      updateInterval: 2_000,
    });

    await background.crash();
    await background.restart();
    await background.step(1_999);
    expect(adapter.acceptedDraftIds).toEqual([]);
    await background.step(1);
    expect(adapter.acceptedDraftIds).toEqual(["approval-draft-1"]);
    expect(adapter.createdDraftIds).toEqual(["approval-draft-1"]);
    expect(harness.rows.get(approval.requestId)).toMatchObject({
      name: OWNER_SEND_OUTBOX_TASK_NAME,
      metadata: {
        paused: true,
        outboxReceipt: {
          externalId: "external-approval-draft-1",
          draftId: "approval-draft-1",
          accepted: true,
        },
      },
    });
    expect(
      getDefaultTriageService().getStore().getDraft("approval-draft-1"),
    ).toMatchObject({
      sent: true,
      sentExternalId: "external-approval-draft-1",
    });

    await expect(
      approvalWorker.execute(harness.runtime, { option: "confirm" }, staleTask),
    ).rejects.toThrow(/already delivered.*durable receipt/u);
    expect(adapter.acceptedDraftIds).toEqual(["approval-draft-1"]);
    expect(
      background.ledger
        .all()
        .filter(
          (entry) =>
            entry.target === `worker:${OWNER_SEND_OUTBOX_TASK_NAME}` &&
            entry.status === "failed",
        ),
    ).toHaveLength(1);

    await background.resetSharedRuntime();
    await background.stop();
  });

  it("pauses an ambiguous provider acceptance for reconciliation without redelivery", async () => {
    const harness = createRuntimeHarness();
    const taskService = (await TaskService.start(
      harness.runtime,
    )) as TaskService;
    taskServices.push(taskService);
    harness.services.set(ServiceType.TASK, taskService);
    const adapter = new AmbiguousAcceptanceAdapter();
    getDefaultTriageService().register(adapter);
    const approval = await createOwnerSendPolicy().enqueueApproval(
      harness.runtime,
      {
        source: "gmail",
        to: [{ identifier: "owner@example.com" }],
        subject: "Ambiguous receipt",
        body: "This must never be sent twice.",
        metadata: {},
      },
      vi.fn(async () => ({ externalId: "forbidden-closure" })),
    );
    const staleTask = harness.rows.get(approval.requestId);
    const approvalWorker = harness.workers.get(OWNER_SEND_APPROVAL_TASK_NAME);
    if (!staleTask || !approvalWorker) throw new Error("approval unavailable");

    const background = new ScenarioBackgroundRuntime(
      harness.runtime as unknown as AgentRuntime,
      {
        namespace: "scenario:ambiguous-outbox",
        epoch: EPOCH,
        workers: [OWNER_SEND_OUTBOX_TASK_NAME],
      },
    );
    await background.captureBaseline();
    await background.start();
    await expect(
      approvalWorker.execute(harness.runtime, { option: "confirm" }, staleTask),
    ).rejects.toThrow(/may have accepted/u);
    expect(adapter.acceptedDraftIds).toEqual(["approval-draft-1"]);
    expect(harness.rows.get(approval.requestId)).toMatchObject({
      name: OWNER_SEND_APPROVAL_TASK_NAME,
      metadata: {
        outboxReconciliationRequired: true,
        outboxDraft: { draftId: "approval-draft-1", sent: false },
      },
    });

    await background.step(60_000);
    expect(adapter.acceptedDraftIds).toEqual(["approval-draft-1"]);
    await expect(
      approvalWorker.execute(harness.runtime, { option: "confirm" }, staleTask),
    ).rejects.toThrow(/requires manual reconciliation/u);
    expect(adapter.createdDraftIds).toEqual(["approval-draft-1"]);
    expect(adapter.acceptedDraftIds).toEqual(["approval-draft-1"]);

    await background.resetSharedRuntime();
    await background.stop();
  });
});
