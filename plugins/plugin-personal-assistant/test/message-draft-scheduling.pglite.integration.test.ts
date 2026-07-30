/**
 * Real-PGlite proof for deferred MESSAGE delivery through the ScheduledTask spine.
 *
 * The suite recreates runtime/service/connector instances over one database,
 * inspects the persisted draft snapshot, and exercises duplicate scheduling,
 * concurrent fire claims, missing payloads, disconnected connectors, and
 * ambiguous transport failures.
 */

import { PGlite } from "@electric-sql/pglite";
import {
  __resetDefaultMessageRefStoreForTests,
  __resetDefaultTriageServiceForTests,
  BaseMessageAdapter,
  getDefaultTriageService,
  type IAgentRuntime,
  type ListOptions,
  type MessageAdapterCapabilities,
  type MessageRef,
  type MessageSource,
} from "@elizaos/core";
import {
  getScheduledTaskRunner,
  ScheduledTaskRunnerService,
} from "@elizaos/plugin-scheduling";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MESSAGE_DRAFT_DISPATCH_CHANNEL,
  reconcileInterruptedMessageDraftDispatches,
  registerMessageDraftScheduledTaskBridge,
  unregisterMessageDraftScheduledTaskBridge,
} from "../src/lifeops/scheduled-task/message-draft-dispatch.js";

type RawSqlQuery = {
  queryChunks: Array<{ value?: unknown }>;
};

function rawQueryText(query: RawSqlQuery): string {
  return String(query.queryChunks.map((chunk) => chunk.value ?? "").join(""));
}

class DurableDraftAdapter extends BaseMessageAdapter {
  readonly source: MessageSource = "discord";
  available = true;
  failSend = false;
  createCount = 0;
  sendCount = 0;
  createdBodies: string[] = [];
  beforeSend?: () => Promise<void>;

  isAvailable(): boolean {
    return this.available;
  }

  capabilities(): MessageAdapterCapabilities {
    return {
      list: false,
      search: false,
      manage: {},
      send: { new: true, schedule: false },
      worlds: "single",
      channels: "explicit",
    };
  }

  protected listMessagesImpl(
    _runtime: IAgentRuntime,
    _opts: ListOptions,
  ): Promise<MessageRef[]> {
    return Promise.resolve([]);
  }

  protected createDraftImpl(
    _runtime: IAgentRuntime,
    draft: { body: string },
  ): Promise<{ draftId: string; preview: string }> {
    this.createCount += 1;
    this.createdBodies.push(draft.body);
    return Promise.resolve({
      draftId: `provider-draft-${this.createCount}`,
      preview: draft.body,
    });
  }

  protected async sendDraftImpl(): Promise<{ externalId: string }> {
    this.sendCount += 1;
    await this.beforeSend?.();
    if (this.failSend) throw new Error("provider outcome is unknown");
    return { externalId: `provider-message-${this.sendCount}` };
  }
}

interface RuntimeHarness {
  runtime: IAgentRuntime;
  service: ScheduledTaskRunnerService;
  stop(): Promise<void>;
}

async function bootRuntime(
  pg: PGlite,
  agentId: string,
  adapter?: DurableDraftAdapter,
  options: { bridgeInstanceId?: string } = {},
): Promise<RuntimeHarness> {
  const db = {
    execute: (query: RawSqlQuery) => pg.query(rawQueryText(query)),
  };
  let service: ScheduledTaskRunnerService | null = null;
  const runtime = {
    agentId,
    adapter: { db },
    initPromise: Promise.resolve(),
    getService: (serviceType: string) =>
      serviceType === ScheduledTaskRunnerService.serviceType ? service : null,
    getServiceLoadPromise: async () => service,
    reportError: vi.fn(),
    logger: {
      warn: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
    },
  } as unknown as IAgentRuntime;
  registerMessageDraftScheduledTaskBridge(runtime, options);
  service = await ScheduledTaskRunnerService.start(runtime);
  if (adapter) getDefaultTriageService().register(adapter);
  return {
    runtime,
    service,
    async stop() {
      unregisterMessageDraftScheduledTaskBridge(runtime);
      await service?.stop();
      service = null;
    },
  };
}

function saveDraft(): void {
  getDefaultTriageService()
    .getStore()
    .saveDraft({
      draftId: "durable-draft-1",
      source: "discord",
      to: [{ identifier: "family-channel" }],
      body: "Pickup moved to 5:30; please confirm.",
      preview: "Pickup moved to 5:30; please confirm.",
      createdAtMs: Date.parse("2026-07-27T20:00:00.000Z"),
      sent: false,
      channelId: "family-channel",
      metadata: { accountId: "family-account" },
    });
}

function resetCoreMessageSingletons(): void {
  __resetDefaultTriageServiceForTests();
  __resetDefaultMessageRefStoreForTests();
}

const databases: PGlite[] = [];
const harnesses: RuntimeHarness[] = [];

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((harness) => harness.stop()));
  resetCoreMessageSingletons();
  await Promise.all(databases.splice(0).map((pg) => pg.close()));
});

describe("deferred MESSAGE scheduling — durable ScheduledTask path", () => {
  it("survives restart and deduplicates schedule + concurrent fire", async () => {
    const pg = new PGlite();
    databases.push(pg);
    const firstAdapter = new DurableDraftAdapter();
    const first = await bootRuntime(pg, "agent-durable-message", firstAdapter);
    harnesses.push(first);
    saveDraft();
    const sendAtMs = Date.parse("2026-07-28T09:00:00.000Z");

    const [scheduledA, scheduledB] = await Promise.all([
      getDefaultTriageService().scheduleDraftSend(
        first.runtime,
        "durable-draft-1",
        sendAtMs,
      ),
      getDefaultTriageService().scheduleDraftSend(
        first.runtime,
        "durable-draft-1",
        sendAtMs,
      ),
    ]);

    expect(scheduledA.scheduledId).toBe(scheduledB.scheduledId);
    expect([
      scheduledA.scheduleCommit?.replayed,
      scheduledB.scheduleCommit?.replayed,
    ]).toContain(true);
    const persisted = await pg.query<{
      id: string;
      metadata_json: string;
    }>(
      `SELECT id, metadata_json
			   FROM app_scheduling.life_scheduled_tasks
			  WHERE agent_id = 'agent-durable-message'
			    AND idempotency_key =
			        'message-draft-send:agent-durable-message:discord:durable-draft-1'`,
    );
    expect(persisted.rows).toHaveLength(1);
    expect(JSON.parse(persisted.rows[0]?.metadata_json ?? "{}")).toMatchObject({
      deferredMessageDraft: {
        version: 1,
        draft: {
          draftId: "durable-draft-1",
          body: "Pickup moved to 5:30; please confirm.",
          channelId: "family-channel",
        },
      },
    });

    await first.stop();
    harnesses.splice(harnesses.indexOf(first), 1);
    resetCoreMessageSingletons();

    const restartedAdapter = new DurableDraftAdapter();
    const restarted = await bootRuntime(
      pg,
      "agent-durable-message",
      restartedAdapter,
    );
    harnesses.push(restarted);
    saveDraft();
    const replay = await getDefaultTriageService().scheduleDraftSend(
      restarted.runtime,
      "durable-draft-1",
      sendAtMs,
    );
    expect(replay.scheduledId).toBe(scheduledA.scheduledId);
    expect(replay.scheduleCommit?.replayed).toBe(true);

    const runner = getScheduledTaskRunner(restarted.runtime, {
      agentId: "agent-durable-message",
      now: () => new Date("2026-07-28T09:01:00.000Z"),
    });
    const taskId = replay.scheduledId ?? "";
    const outcomes = await Promise.all([
      runner.fireWithResult(taskId),
      runner.fireWithResult(taskId),
    ]);

    expect(outcomes.map((outcome) => outcome.kind).sort()).toEqual([
      "fired",
      "raced",
    ]);
    expect(restartedAdapter.createCount).toBe(1);
    expect(restartedAdapter.sendCount).toBe(1);
    expect(restartedAdapter.createdBodies).toEqual([
      "Pickup moved to 5:30; please confirm.",
    ]);
    const row = await pg.query<{
      status: string;
      metadata_json: string;
    }>(
      `SELECT state_json::jsonb ->> 'status' AS status, metadata_json
			   FROM app_scheduling.life_scheduled_tasks
			  WHERE id = '${taskId}'`,
    );
    expect(row.rows[0]?.status).toBe("fired");
    expect(JSON.parse(row.rows[0]?.metadata_json ?? "{}")).toMatchObject({
      lastDispatchResult: {
        ok: true,
        messageId: "provider-message-1",
        channelKey: MESSAGE_DRAFT_DISPATCH_CHANNEL,
      },
    });
  });

  it("fails a tampered task whose persisted draft snapshot is missing", async () => {
    const pg = new PGlite();
    databases.push(pg);
    const harness = await bootRuntime(pg, "agent-missing-draft");
    harnesses.push(harness);
    const runner = getScheduledTaskRunner(harness.runtime, {
      agentId: "agent-missing-draft",
      now: () => new Date("2026-07-28T09:01:00.000Z"),
    });
    const task = await runner.schedule({
      kind: "output",
      promptInstructions: "Dispatch a structurally persisted draft.",
      trigger: { kind: "once", atIso: "2026-07-28T09:00:00.000Z" },
      priority: "medium",
      escalation: { steps: [] },
      output: {
        destination: "channel",
        target: MESSAGE_DRAFT_DISPATCH_CHANNEL,
      },
      respectsGlobalPause: true,
      source: "plugin",
      createdBy: "integration-test",
      ownerVisible: false,
      executionProfile: "bg-light-30s",
    });

    const result = await runner.fireWithResult(task.taskId);

    expect(result.kind).toBe("dispatch_failed");
    const stored = (await runner.list()).find(
      (candidate) => candidate.taskId === task.taskId,
    );
    expect(stored?.metadata?.lastDispatchResult).toMatchObject({
      ok: false,
      reason: "transport_error",
      acceptance: "not_accepted",
    });
  });

  it("surfaces a disconnected adapter after restart without sending", async () => {
    const pg = new PGlite();
    databases.push(pg);
    const first = await bootRuntime(
      pg,
      "agent-disconnected-message",
      new DurableDraftAdapter(),
    );
    harnesses.push(first);
    saveDraft();
    const scheduled = await getDefaultTriageService().scheduleDraftSend(
      first.runtime,
      "durable-draft-1",
      Date.parse("2026-07-28T09:00:00.000Z"),
    );
    await first.stop();
    harnesses.splice(harnesses.indexOf(first), 1);
    resetCoreMessageSingletons();

    const restarted = await bootRuntime(pg, "agent-disconnected-message");
    harnesses.push(restarted);
    const runner = getScheduledTaskRunner(restarted.runtime, {
      agentId: "agent-disconnected-message",
      now: () => new Date("2026-07-28T09:01:00.000Z"),
    });
    const result = await runner.fireWithResult(scheduled.scheduledId ?? "");

    expect(result.kind).toBe("dispatch_failed");
    const stored = (await runner.list()).find(
      (candidate) => candidate.taskId === scheduled.scheduledId,
    );
    expect(stored?.metadata?.lastDispatchResult).toMatchObject({
      ok: false,
      reason: "disconnected",
      acceptance: "not_accepted",
    });
  });

  it("records an ambiguous connector failure and never fabricates success", async () => {
    const pg = new PGlite();
    databases.push(pg);
    const adapter = new DurableDraftAdapter();
    adapter.failSend = true;
    const harness = await bootRuntime(pg, "agent-failed-message", adapter);
    harnesses.push(harness);
    saveDraft();
    const scheduled = await getDefaultTriageService().scheduleDraftSend(
      harness.runtime,
      "durable-draft-1",
      Date.parse("2026-07-28T09:00:00.000Z"),
    );
    const runner = getScheduledTaskRunner(harness.runtime, {
      agentId: "agent-failed-message",
      now: () => new Date("2026-07-28T09:01:00.000Z"),
    });

    const result = await runner.fireWithResult(scheduled.scheduledId ?? "");

    expect(result.kind).toBe("dispatch_failed");
    expect(adapter.sendCount).toBe(1);
    expect(harness.runtime.reportError).toHaveBeenCalledOnce();
    const stored = (await runner.list()).find(
      (candidate) => candidate.taskId === scheduled.scheduledId,
    );
    expect(stored?.metadata?.lastDispatchResult).toMatchObject({
      ok: false,
      reason: "transport_error",
      acceptance: "unknown",
    });
  });

  it("persists the attempt marker before invoking connector egress", async () => {
    const pg = new PGlite();
    databases.push(pg);
    const adapter = new DurableDraftAdapter();
    const harness = await bootRuntime(pg, "agent-attempt-order", adapter, {
      bridgeInstanceId: "attempt-order-process",
    });
    harnesses.push(harness);
    saveDraft();
    const scheduled = await getDefaultTriageService().scheduleDraftSend(
      harness.runtime,
      "durable-draft-1",
      Date.parse("2026-07-28T09:00:00.000Z"),
    );
    let markerSeenBeforeSend = false;
    adapter.beforeSend = async () => {
      const row = await pg.query<{ metadata_json: string }>(
        `SELECT metadata_json
           FROM app_scheduling.life_scheduled_tasks
          WHERE id = '${scheduled.scheduledId ?? ""}'`,
      );
      const metadata = JSON.parse(row.rows[0]?.metadata_json ?? "{}");
      expect(metadata).toMatchObject({
        deferredMessageAttempt: {
          bridgeInstanceId: "attempt-order-process",
          state: "dispatching",
        },
      });
      markerSeenBeforeSend = true;
    };
    const runner = getScheduledTaskRunner(harness.runtime, {
      agentId: "agent-attempt-order",
      now: () => new Date("2026-07-28T09:01:00.000Z"),
    });

    await expect(
      runner.fireWithResult(scheduled.scheduledId ?? ""),
    ).resolves.toMatchObject({ kind: "fired" });

    expect(markerSeenBeforeSend).toBe(true);
    expect(adapter.sendCount).toBe(1);
    const [stored] = (await runner.list()).filter(
      (candidate) => candidate.taskId === scheduled.scheduledId,
    );
    expect(stored?.metadata?.deferredMessageAttempt).toBeUndefined();
    expect(stored?.metadata?.lastDispatchResult).toMatchObject({
      ok: true,
      messageId: "provider-message-1",
    });
  });

  it("reconciles a prior-process dispatch marker without retrying the provider", async () => {
    const pg = new PGlite();
    databases.push(pg);
    const adapter = new DurableDraftAdapter();
    const harness = await bootRuntime(
      pg,
      "agent-interrupted-message",
      adapter,
      { bridgeInstanceId: "current-process" },
    );
    harnesses.push(harness);
    saveDraft();
    const scheduled = await getDefaultTriageService().scheduleDraftSend(
      harness.runtime,
      "durable-draft-1",
      Date.parse("2026-07-28T09:00:00.000Z"),
    );
    const runner = getScheduledTaskRunner(harness.runtime, {
      agentId: "agent-interrupted-message",
      now: () => new Date("2026-07-28T09:01:00.000Z"),
    });
    const taskId = scheduled.scheduledId ?? "";
    const [task] = (await runner.list()).filter(
      (candidate) => candidate.taskId === taskId,
    );
    await runner.apply(taskId, "edit", {
      metadata: {
        ...(task?.metadata ?? {}),
        deferredMessageAttempt: {
          version: 1,
          bridgeInstanceId: "stopped-process",
          startedAtIso: "2026-07-28T09:01:00.000Z",
          state: "dispatching",
        },
      },
    });
    await pg.query(
      `UPDATE app_scheduling.life_scheduled_tasks
          SET state_json = (
                state_json::jsonb ||
                '{"status":"fired","firedAt":"2026-07-28T09:01:00.000Z"}'::jsonb
              )::text,
              next_fire_at = NULL
        WHERE id = '${taskId}'`,
    );

    await expect(
      reconcileInterruptedMessageDraftDispatches(harness.runtime),
    ).resolves.toEqual([taskId]);

    const [reconciled] = (await runner.list()).filter(
      (candidate) => candidate.taskId === taskId,
    );
    expect(reconciled?.state.status).toBe("failed");
    expect(reconciled?.metadata).toMatchObject({
      deferredMessageAttempt: {
        bridgeInstanceId: "stopped-process",
        state: "outcome_unknown",
      },
      lastDispatchResult: {
        ok: false,
        reason: "transport_error",
        acceptance: "unknown",
        userActionable: true,
      },
    });
    expect(adapter.sendCount).toBe(0);
    expect(harness.runtime.reportError).toHaveBeenCalledOnce();

    const replay = await runner.fireWithResult(taskId);
    expect(replay).toMatchObject({
      kind: "skipped",
      reason: "terminal:failed",
    });
    expect(adapter.sendCount).toBe(0);
  });
});
