/**
 * Real-PGLite coverage for native trajectory persistence and lifecycle
 * contracts, including schema migration, owner isolation, atomic fault
 * rollback, strict decoding, terminal cleanup, late capture, and read routes.
 */

import type { ServerResponse } from "node:http";
import { PGlite } from "@electric-sql/pglite";
import type { IAgentRuntime, Memory, MessagePayload } from "@elizaos/core";
import {
  logActiveTrajectoryLlmCall,
  runWithTrajectoryContext,
} from "@elizaos/core";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { trajectoriesPlugin } from "./index";
import { tryHandleTrajectoryReadRoutes } from "./read-routes";
import { ensureTrajectoriesTable } from "./store/trajectory-internals.ts";
import { TrajectoriesService } from "./TrajectoriesService";

let db: ReturnType<typeof drizzle>;
let client: PGlite;
let service: TrajectoriesService;
let serviceRuntime: IAgentRuntime;

function queryText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  const chunks = (value as { queryChunks?: Array<{ value?: unknown }> })
    .queryChunks;
  if (!Array.isArray(chunks)) return String(value);
  return chunks
    .flatMap((chunk) => (Array.isArray(chunk.value) ? chunk.value : []))
    .join("");
}

async function makeFaultService(agentId: string): Promise<{
  service: TrajectoriesService;
  runtime: IAgentRuntime;
  fault: { failAt: number | null; observed: number };
}> {
  const fault = {
    failAt: null as number | null,
    failOn: null as string | null,
    observed: 0,
  };
  type RawQuery = ReturnType<typeof sql.raw>;
  type TransactionExecutor = {
    execute: (query: RawQuery) => Promise<unknown>;
  };
  const proxyDb = {
    execute: (query: RawQuery) => db.execute(query),
    transaction: async <T>(
      work: (executor: TransactionExecutor) => Promise<T>,
    ): Promise<T> =>
      db.transaction(async (tx) => {
        fault.observed = 0;
        return work({
          execute: async (query) => {
            fault.observed += 1;
            if (
              fault.failAt === fault.observed ||
              (fault.failOn !== null && queryText(query).includes(fault.failOn))
            ) {
              throw new Error(
                `injected transaction statement ${fault.observed}: ${queryText(query)}`,
              );
            }
            return tx.execute(query);
          },
        });
      }),
  };
  const runtime = {
    agentId,
    runtimeInstanceId: crypto.randomUUID(),
    adapter: { db: proxyDb },
    getService: () => null,
    getServicesByType: () => [],
    getSetting: () => undefined,
    reportError: vi.fn(),
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  } as unknown as IAgentRuntime;
  const faultService = new TrajectoriesService(runtime);
  faultService.setEnabled(true);
  await ensureTrajectoriesTable(runtime);
  return { service: faultService, runtime, fault };
}

async function readDetailRoute(
  runtime: IAgentRuntime,
  trajectoryId: string,
): Promise<{ status: number; body: unknown }> {
  const state = { status: 0, body: undefined as unknown };
  const response = {
    statusCode: 0,
    setHeader() {},
    end(payload?: string) {
      state.status = response.statusCode;
      state.body = payload ? JSON.parse(payload) : undefined;
    },
  } as unknown as ServerResponse;
  await tryHandleTrajectoryReadRoutes({
    pathname: `/api/trajectories/${trajectoryId}`,
    method: "GET",
    url: new URL(`http://localhost/api/trajectories/${trajectoryId}`),
    runtime,
    res: response,
  });
  return state;
}

async function raw(text: string): Promise<Record<string, unknown>[]> {
  const res = await db.execute(sql.raw(text));
  return (res.rows as Record<string, unknown>[]) ?? [];
}

async function rewardRow(trajectoryId: string): Promise<{
  totalReward: number;
  components: unknown;
}> {
  const [row] = await raw(
    `SELECT total_reward, reward_components_json FROM trajectories WHERE id = '${trajectoryId}'`,
  );
  return {
    totalReward: Number(row?.total_reward),
    components: JSON.parse(String(row?.reward_components_json)).components,
  };
}

async function traceColumnExists(): Promise<boolean> {
  const rows = await raw(
    `SELECT column_name FROM information_schema.columns
     WHERE table_name = 'trajectories' AND column_name = 'trace_id'`,
  );
  return rows.some((r) => r.column_name === "trace_id");
}

beforeAll(async () => {
  client = new PGlite();
  db = drizzle(client);
  serviceRuntime = {
    agentId: "00000000-0000-4000-8000-000000000001",
    runtimeInstanceId: crypto.randomUUID(),
    adapter: { db },
    getService: () => null,
    getServicesByType: () => [],
    getSetting: () => undefined,
  } as unknown as IAgentRuntime;
  service = new TrajectoriesService(serviceRuntime);
  // NODE_ENV=test defaults the gate off; enable persistence directly for this
  // DB-round-trip test.
  service.setEnabled(true);
  await ensureTrajectoriesTable(serviceRuntime);
}, 60_000);

afterAll(async () => {
  await client?.close?.();
});

describe("trajectory graceful shutdown ownership (real PGlite)", () => {
  it.each(["selected", "all"] as const)(
    "releases shutdown ownership after deleting %s trajectories",
    async (mode) => {
      const owner = await makeFaultService(crypto.randomUUID());
      const other = await makeFaultService(crypto.randomUUID());
      const trajectoryId = await owner.service.startTrajectory(
        owner.runtime.agentId,
      );
      const otherId = await other.service.startTrajectory(
        other.runtime.agentId,
      );
      await owner.service.flushWriteQueue();
      await other.service.flushWriteQueue();
      const count =
        mode === "selected"
          ? await owner.service.deleteTrajectories([trajectoryId, otherId])
          : await owner.service.clearAllTrajectories();
      expect(count).toBe(1);
      expect(await owner.service.getTrajectoryDetail(trajectoryId)).toBeNull();
      expect(
        (await other.service.getTrajectoryDetail(otherId))?.metrics.finalStatus,
      ).toBe("active");
      // A deleted run must not leave a shutdown write behind if the database
      // later becomes unavailable during process teardown.
      owner.fault.failAt = 1;
      await expect(owner.service.stop()).resolves.toBeUndefined();
    },
  );

  it("terminates only this service's starts and preserves settled content and other owners", async () => {
    const owner = await makeFaultService(
      "00000000-0000-4000-8000-000000000401",
    );
    const sibling = await makeFaultService(owner.runtime.agentId);
    const otherAgent = await makeFaultService(
      "00000000-0000-4000-8000-000000000402",
    );
    const noStepId = await owner.service.startTrajectory(
      owner.runtime.agentId,
      {
        metadata: { runtimeInstanceId: sibling.runtime.runtimeInstanceId },
      },
    );
    const activeId = await owner.service.startTrajectory(owner.runtime.agentId);
    const stepId = owner.service.startStep(activeId, { timestamp: Date.now() });
    await owner.service.flushWriteQueue(activeId);
    owner.service.logLlmCall({
      stepId,
      model: "shutdown-proof",
      systemPrompt: "system",
      userPrompt: "prompt",
      response: "Saved before shutdown.",
      purpose: "action",
      actionType: "fixture",
    });
    await owner.service.flushWriteQueue(activeId);
    const contentBefore = await owner.service.getTrajectoryDetail(activeId);
    const completedId = await owner.service.startTrajectory(
      owner.runtime.agentId,
    );
    await owner.service.flushWriteQueue();
    // A terminal event can be persisted through another service before the
    // creator shuts down. Its local start registry must not reopen that result.
    await sibling.service.endTrajectory(completedId, "completed");
    const completedBefore =
      await owner.service.getTrajectoryDetail(completedId);
    const siblingId = await sibling.service.startTrajectory(
      sibling.runtime.agentId,
    );
    const otherId = await otherAgent.service.startTrajectory(
      otherAgent.runtime.agentId,
    );
    await sibling.service.flushWriteQueue();
    await otherAgent.service.flushWriteQueue();
    // A service can capture a same-agent trajectory through the public routing
    // contract. That routing is not authority to terminate its creator's run.
    owner.service.startStep(siblingId, { timestamp: Date.now() });
    await owner.service.flushWriteQueue(siblingId);
    const siblingBefore = await sibling.service.getTrajectoryDetail(siblingId);

    await Promise.all([owner.service.stop(), owner.service.stop()]);

    const stopped = await owner.service.getTrajectoryDetail(activeId);
    expect(stopped?.metrics.finalStatus).toBe("terminated");
    expect(stopped?.steps).toEqual(contentBefore?.steps);
    expect(stopped?.metadata).toEqual(contentBefore?.metadata);
    expect(stopped?.endTime).toBeGreaterThanOrEqual(
      stopped?.startTime ?? Infinity,
    );
    expect(stopped?.durationMs).toBe(
      (stopped?.endTime ?? 0) - (stopped?.startTime ?? 0),
    );
    const noStep = await owner.service.getTrajectoryDetail(noStepId);
    expect(noStep).toMatchObject({
      steps: [],
      metrics: { finalStatus: "terminated", episodeLength: 0 },
      metadata: { runtimeInstanceId: owner.runtime.runtimeInstanceId },
    });
    expect(await sibling.service.getTrajectoryDetail(siblingId)).toEqual(
      siblingBefore,
    );
    expect(
      (await otherAgent.service.getTrajectoryDetail(otherId))?.metrics
        .finalStatus,
    ).toBe("active");
    expect(await owner.service.getTrajectoryDetail(completedId)).toEqual(
      completedBefore,
    );
    await owner.service.stop();
    expect(await owner.service.getTrajectoryDetail(activeId)).toEqual(stopped);
  });

  it("drains queued capture before termination without discarding its recorded result", async () => {
    const owner = await makeFaultService(
      "00000000-0000-4000-8000-000000000404",
    );
    const trajectoryId = await owner.service.startTrajectory(
      owner.runtime.agentId,
    );
    const stepId = owner.service.startStep(trajectoryId, {
      timestamp: Date.now(),
    });
    owner.service.logLlmCall({
      stepId,
      model: "queued-before-stop",
      systemPrompt: "system",
      userPrompt: "prompt",
      response: "The accepted response must survive.",
      purpose: "action",
      actionType: "fixture",
    });
    await owner.service.stop();
    const detail = await owner.service.getTrajectoryDetail(trajectoryId);
    expect(detail?.metrics.finalStatus).toBe("terminated");
    expect(detail?.steps.flatMap((step) => step.llmCalls)).toEqual([
      expect.objectContaining({
        response: "The accepted response must survive.",
      }),
    ]);
  });

  it("rolls back every shutdown statement and allows a later stop to finish", async () => {
    for (let failAt = 1; failAt <= 2; failAt += 1) {
      const owner = await makeFaultService(
        `00000000-0000-4000-8000-00000000041${failAt}`,
      );
      const trajectoryId = await owner.service.startTrajectory(
        owner.runtime.agentId,
      );
      owner.service.startStep(trajectoryId, { timestamp: Date.now() });
      await owner.service.flushWriteQueue(trajectoryId);
      const before = await owner.service.getTrajectoryDetail(trajectoryId);
      owner.fault.failAt = failAt;
      await expect(owner.service.stop()).rejects.toThrow();
      owner.fault.failAt = null;
      expect(await owner.service.getTrajectoryDetail(trajectoryId)).toEqual(
        before,
      );
      await owner.service.stop();
      expect(
        (await owner.service.getTrajectoryDetail(trajectoryId))?.metrics
          .finalStatus,
      ).toBe("terminated");
    }
  });
});

describe("trajectories trace_id join key (real PGLite)", () => {
  it("self-migrates trace_id onto a legacy trajectories table", async () => {
    expect(await traceColumnExists()).toBe(true);

    // Simulate a legacy deployment predating the column, then re-run the
    // idempotent schema bootstrap; ensureTrajectoryColumnsExist must re-add it.
    await raw(`ALTER TABLE trajectories DROP COLUMN trace_id`);
    expect(await traceColumnExists()).toBe(false);

    // Schema readiness is remembered per runtime; a fresh runtime over the
    // same database runs the bootstrap again.
    await ensureTrajectoriesTable({ ...serviceRuntime } as IAgentRuntime);
    expect(await traceColumnExists()).toBe(true);
  });

  it("persists + filters by traceId with the correlation envelope in metadata", async () => {
    const logger = service as unknown as {
      startTrajectory: (
        agentId: string,
        opts: {
          source?: string;
          traceId?: string;
          scenarioId?: string;
          metadata?: Record<string, unknown>;
        },
      ) => Promise<string>;
      listTrajectories: (opts: {
        limit?: number;
        traceId?: string;
      }) => Promise<{
        trajectories: Array<{
          id: string;
          metadata: Record<string, unknown>;
        }>;
        total: number;
      }>;
    };
    const traceId = "trace-fixture-0001";

    const id = await logger.startTrajectory(
      "00000000-0000-4000-8000-000000000001",
      {
        source: "chat",
        traceId,
        scenarioId: "run-xyz",
        metadata: { roomId: "room-1" },
      },
    );
    expect(typeof id).toBe("string");

    // A second trajectory under a different trace must NOT match the filter.
    await logger.startTrajectory("00000000-0000-4000-8000-000000000001", {
      source: "chat",
      traceId: "trace-fixture-0002",
    });

    const filtered = await logger.listTrajectories({ traceId, limit: 50 });
    expect(filtered.trajectories.map((t) => t.id)).toEqual([id]);

    const correlation = (
      filtered.trajectories[0].metadata as {
        correlation?: { traceId?: string; runId?: string };
      }
    ).correlation;
    expect(correlation?.traceId).toBe(traceId);
    expect(correlation?.runId).toBe("run-xyz");

    const rows = await raw(
      `SELECT trace_id FROM trajectories WHERE id = '${id}'`,
    );
    expect(rows[0]?.trace_id).toBe(traceId);
  });

  it("filters exact room and source before pagination through the read route", async () => {
    const roomId = "room'_%filter";
    const id = await service.startTrajectory(
      "00000000-0000-4000-8000-000000000001",
      {
        source: "room-filter-chat",
        metadata: { roomId },
      },
    );
    await service.startTrajectory("00000000-0000-4000-8000-000000000001", {
      source: "room-filter-chat",
      metadata: { roomId: "other-room", note: roomId },
    });
    await service.startTrajectory("00000000-0000-4000-8000-000000000001", {
      source: "background_memory",
      metadata: { roomId },
    });
    await service.flushWriteQueue();
    let body = "";
    const res = {
      setHeader: () => {},
      end: (text: string) => {
        body = text;
      },
    } as unknown as ServerResponse;
    const handled = await tryHandleTrajectoryReadRoutes({
      method: "GET",
      pathname: "/api/trajectories",
      url: new URL(
        `http://localhost/api/trajectories?roomId=${encodeURIComponent(roomId)}&source=room-filter-chat&limit=1`,
      ),
      runtime: {
        ...serviceRuntime,
        getService: () => service,
        getServicesByType: () => [service],
      } as unknown as IAgentRuntime,
      res,
    });
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    const result = JSON.parse(body);
    expect(result.total).toBe(1);
    expect(result.trajectories.map((row: { id: string }) => row.id)).toEqual([
      id,
    ]);
  });

  it("round-trips terminated status through the public list filter", async () => {
    const trajectoryId = await service.startTrajectory(
      "00000000-0000-4000-8000-000000000001",
      { source: "status-test", metadata: { roomId: "terminated-room" } },
    );
    await service.endTrajectory(trajectoryId, "terminated");

    const filtered = await service.listTrajectories({
      status: "terminated",
      limit: 50,
    });
    expect(filtered.trajectories).toEqual([
      expect.objectContaining({
        id: trajectoryId,
        status: "terminated",
        roomId: "terminated-room",
      }),
    ]);
  });

  it("applies one delayed reward without reopening a completed trajectory", async () => {
    const trajectoryId = await service.startTrajectory(serviceRuntime.agentId, {
      source: "morning-brief",
    });
    await service.endTrajectory(trajectoryId, "completed");

    const outcomes = await Promise.all(
      Array.from({ length: 8 }, () =>
        service.applyReward({
          trajectoryId,
          idempotencyKey: "brief-engagement:event-1",
          reward: 0.75,
          component: "briefEngagementReward",
        }),
      ),
    );
    // Every caller observes a settled receipt, while the reward is added once.
    expect(outcomes.filter(Boolean)).toHaveLength(8);
    const detail = await service.getTrajectoryDetail(trajectoryId);
    expect(detail).toMatchObject({
      metrics: { finalStatus: "completed" },
      metadata: {
        appliedRewardKeys: ["brief-engagement:event-1"],
      },
    });
    expect(await rewardRow(trajectoryId)).toEqual({
      totalReward: 0.75,
      components: { briefEngagementReward: 0.75 },
    });
  });

  it("serializes different delayed reward keys across service instances", async () => {
    const trajectoryId = await service.startTrajectory(serviceRuntime.agentId, {
      source: "morning-brief-cross-process",
    });
    await service.endTrajectory(trajectoryId, "completed");
    const otherService = new TrajectoriesService(serviceRuntime);
    otherService.setEnabled(true);

    expect(
      await Promise.all([
        service.applyReward({
          trajectoryId,
          idempotencyKey: "brief-engagement:event-a",
          reward: 0.75,
          component: "briefEngagementReward",
        }),
        otherService.applyReward({
          trajectoryId,
          idempotencyKey: "brief-engagement:event-b",
          reward: 0.5,
          component: "briefEngagementReward",
        }),
      ]),
    ).toEqual([true, true]);
    const detail = await service.getTrajectoryDetail(trajectoryId);
    expect(await rewardRow(trajectoryId)).toEqual({
      totalReward: 1.25,
      components: { briefEngagementReward: 1.25 },
    });
    expect(detail?.metadata.appliedRewardKeys).toEqual(
      expect.arrayContaining([
        "brief-engagement:event-a",
        "brief-engagement:event-b",
      ]),
    );
  });

  // Emit-first paths (the agent API chat route and connectors) emit
  // MESSAGE_RECEIVED before messageService.handleMessage mints the turn's
  // traceId, so the plugin handler is the first touchpoint and must mint +
  // stamp the id itself or the DB row persists trace_id NULL and never joins
  // the file trajectory (#13871 audit).
  it("mints and persists a traceId when MESSAGE_RECEIVED arrives before message.ts stamps one", async () => {
    const handler = trajectoriesPlugin.events?.MESSAGE_RECEIVED?.[0];
    expect(typeof handler).toBe("function");

    const runtime = {
      agentId: "00000000-0000-4000-8000-000000000001",
      adapter: { db },
      getService: () => service,
      getServicesByType: () => [service],
      getRoom: async () => null,
      reportError: vi.fn(),
      logger: {
        debug() {},
        info() {},
        warn(...args: unknown[]) {
          // The handler swallows failures via logger.warn; surface them so a
          // broken insert cannot pass as green.
          throw new Error(`trajectory handler warned: ${JSON.stringify(args)}`);
        },
        error() {},
      },
    } as unknown as IAgentRuntime;

    const message = {
      id: "10000000-0000-4000-8000-00000000aaaa",
      roomId: "20000000-0000-4000-8000-00000000bbbb",
      entityId: "30000000-0000-4000-8000-00000000cccc",
      content: { text: "hello", source: "api" },
      // No metadata: mirrors chat-routes.ts emitting before any stamp exists.
    } as unknown as Memory;

    await handler?.({ runtime, message, source: "api" } as MessagePayload);

    const meta = message.metadata as {
      traceId?: string;
      trajectoryId?: string;
    };
    expect(typeof meta.traceId).toBe("string");
    expect((meta.traceId ?? "").length).toBeGreaterThan(0);
    expect(typeof meta.trajectoryId).toBe("string");

    const rows = await raw(
      `SELECT trace_id, metadata_json FROM trajectories WHERE id = '${meta.trajectoryId}'`,
    );
    expect(rows.length).toBe(1);
    expect(rows[0]?.trace_id).toBe(meta.traceId);
  });

  it("round-trips a native actionless step through the owner read route", async () => {
    const trajectoryId = await service.startTrajectory(serviceRuntime.agentId, {
      source: "native-actionless",
      metadata: { roomId: "actionless-room" },
    });
    service.startStep(trajectoryId, { timestamp: Date.now() });
    await service.flushWriteQueue(trajectoryId);
    await service.endTrajectory(trajectoryId, "completed");

    const routeRuntime = {
      ...serviceRuntime,
      getService: (type: string) => (type === "trajectories" ? service : null),
    } as IAgentRuntime;
    const response = await readDetailRoute(routeRuntime, trajectoryId);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      trajectory: { id: trajectoryId, status: "completed" },
      toolEvents: [],
    });
  });

  it("rejects late native capture and keeps stop permanently inert", async () => {
    const harness = await makeFaultService(
      "00000000-0000-4000-8000-000000000101",
    );
    const trajectoryId = await harness.service.startTrajectory(
      harness.runtime.agentId,
      { source: "native-late" },
    );
    const stepId = harness.service.startStep(trajectoryId, {
      timestamp: Date.now(),
    });
    await harness.service.flushWriteQueue(trajectoryId);
    harness.service.logLlmCall({
      stepId,
      model: "native-before-end",
      systemPrompt: "system",
      userPrompt: "prompt",
      response: "response",
      purpose: "action",
      actionType: "fixture",
    });
    await harness.service.flushWriteQueue(trajectoryId);
    await harness.service.endTrajectory(trajectoryId, "completed");

    // Immediate post-delivery captures are allowed; this test owns rejection
    // after that grace window, both in memory and after a service reload.
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 121_000);
    try {
      harness.service.logLlmCall({
        stepId,
        model: "native-after-end",
        systemPrompt: "system",
        userPrompt: "prompt",
        response: "must be rejected",
        purpose: "action",
        actionType: "fixture",
      });
      harness.service.logProviderAccess(stepId, {
        providerName: "native-after-end-provider",
        data: {},
        purpose: "context",
      });
      await harness.service.flushWriteQueue(trajectoryId);
      const completed = await harness.service.getTrajectoryDetail(trajectoryId);
      expect(completed?.metrics.finalStatus).toBe("completed");
      expect(completed?.steps.flatMap((step) => step.llmCalls)).toHaveLength(1);
      expect(completed?.steps.flatMap((step) => step.providerAccesses)).toEqual(
        [],
      );
      expect(
        (
          harness.runtime.reportError as ReturnType<typeof vi.fn>
        ).mock.calls.filter(
          ([scope, , context]) =>
            scope === "TrajectoryStorage.lateCapture" &&
            (context as { diagnosticOnly?: boolean }).diagnosticOnly === true,
        ),
      ).toHaveLength(1);

      const reloaded = await makeFaultService(harness.runtime.agentId);
      reloaded.service.logLlmCall({
        stepId,
        model: "native-after-reload",
        systemPrompt: "system",
        userPrompt: "prompt",
        response: "must still be rejected",
        purpose: "action",
        actionType: "fixture",
      });
      reloaded.service.logProviderAccess(stepId, {
        providerName: "native-after-reload-provider",
        data: {},
        purpose: "context",
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      await reloaded.service.flushWriteQueue(trajectoryId);
      // The reloaded owner first sees the closed row now, so its rejection is
      // the expected same-instant race and is logged at debug level.
      expect(
        (
          reloaded.runtime.reportError as ReturnType<typeof vi.fn>
        ).mock.calls.filter(
          ([scope]) => scope === "TrajectoryStorage.lateCapture",
        ),
      ).toHaveLength(0);
      const afterReloadCapture =
        await reloaded.service.getTrajectoryDetail(trajectoryId);
      expect(
        afterReloadCapture?.steps.flatMap((step) => step.llmCalls),
      ).toHaveLength(1);
      expect(
        afterReloadCapture?.steps.flatMap((step) => step.providerAccesses),
      ).toEqual([]);

      await harness.service.stop();
      const rowsBefore = await raw(
        `SELECT count(*)::int AS total FROM trajectories WHERE agent_id = '${harness.runtime.agentId}'`,
      );
      const inertId = await harness.service.startTrajectory(
        harness.runtime.agentId,
        { source: "native-after-stop" },
      );
      harness.service.startStep(inertId, { timestamp: Date.now() });
      harness.service.logLlmCall({
        stepId,
        model: "native-after-stop",
        systemPrompt: "system",
        userPrompt: "prompt",
        response: "must remain inert",
        purpose: "action",
        actionType: "fixture",
      });
      await harness.service.flushWriteQueue(inertId);
      const rowsAfter = await raw(
        `SELECT count(*)::int AS total FROM trajectories WHERE agent_id = '${harness.runtime.agentId}'`,
      );
      expect(rowsAfter[0]?.total).toBe(rowsBefore[0]?.total);
      expect(harness.service.isEnabled()).toBe(false);
    } finally {
      clock.mockRestore();
    }
  });

  it("terminalizes a durable MESSAGE_RECEIVED parent after child persistence fails", async () => {
    const harness = await makeFaultService(
      "00000000-0000-4000-8000-000000000301",
    );
    Object.assign(harness.runtime as unknown as Record<string, unknown>, {
      getService: (type: string) =>
        type === "trajectories" ? harness.service : null,
      getServicesByType: (type: string) =>
        type === "trajectories" ? [harness.service] : [],
      getRoom: async () => null,
    });
    const handler = trajectoriesPlugin.events?.MESSAGE_RECEIVED?.[0];
    expect(typeof handler).toBe("function");
    const messageId = "10000000-0000-4000-8000-00000000f301";
    const message = {
      id: messageId,
      agentId: harness.runtime.agentId,
      roomId: "20000000-0000-4000-8000-00000000f301",
      entityId: "30000000-0000-4000-8000-00000000f301",
      createdAt: Date.now(),
      content: { text: "partial trajectory start", source: "partial-start" },
    } as unknown as Memory;
    harness.fault.failOn = "INSERT INTO trajectory_steps";
    await handler?.({
      runtime: harness.runtime,
      message,
      source: "partial-start",
    } as MessagePayload);
    harness.fault.failOn = null;

    const rows = await raw(
      `SELECT id, status, end_time, duration_ms FROM trajectories
			 WHERE agent_id = '${harness.runtime.agentId}' AND source = 'partial-start'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("error");
    expect(typeof rows[0]?.end_time).toBe("number");
    expect(typeof rows[0]?.duration_ms).toBe("number");
    expect(
      (message.metadata as Record<string, unknown>).trajectoryId,
    ).toBeUndefined();
    expect(harness.service.getCurrentStepId(String(rows[0]?.id))).toBeNull();

    const endHandler = trajectoriesPlugin.events?.RUN_ENDED?.[0];
    await endHandler?.({
      runtime: harness.runtime,
      messageId,
      status: "completed",
    });
    const afterTerminal = await raw(
      `SELECT status FROM trajectories WHERE id = '${rows[0]?.id}'`,
    );
    expect(afterTerminal[0]?.status).toBe("error");
  });

  it("rejects cross-agent starts before insert for both public signatures", async () => {
    const countBefore = await raw(
      `SELECT count(*)::int AS total FROM trajectories WHERE agent_id = 'foreign-agent'`,
    );
    await expect(
      service.startTrajectory("foreign-agent", { source: "forged-modern" }),
    ).rejects.toMatchObject({
      code: "TRAJECTORY_AGENT_OWNERSHIP_CONFLICT",
    });
    await expect(
      service.startTrajectory("forged-legacy-step", {
        agentId: "foreign-agent",
        source: "forged-legacy",
      }),
    ).rejects.toMatchObject({
      code: "TRAJECTORY_AGENT_OWNERSHIP_CONFLICT",
    });
    const countAfter = await raw(
      `SELECT count(*)::int AS total FROM trajectories WHERE agent_id = 'foreign-agent'`,
    );
    expect(countAfter[0]?.total).toBe(countBefore[0]?.total);
  });

  it("strictly rejects malformed actions and active or terminal timing", async () => {
    // Each read surface wraps the invalid row in its operation failure.
    const rejected = {
      code: expect.stringMatching(
        /^TRAJECTORY_(ROW_INVALID|LOAD_FAILED|STORAGE_OPERATION_FAILED)$/,
      ),
    };
    const assertAllReadSurfacesReject = async (
      trajectoryId: string,
      checkList = true,
    ): Promise<void> => {
      // The list reads parent rows only; step payloads decode on detail/export.
      if (checkList)
        await expect(
          service.listTrajectories({ search: trajectoryId, limit: 10 }),
        ).rejects.toMatchObject(rejected);
      await expect(
        service.getTrajectoryDetail(trajectoryId),
      ).rejects.toMatchObject(rejected);
      await expect(
        service.exportTrajectories({
          format: "jsonl",
          trajectoryIds: [trajectoryId],
        }),
      ).rejects.toMatchObject(rejected);
    };

    const malformedActionId = await service.startTrajectory(
      serviceRuntime.agentId,
      { source: "malformed-native-action" },
    );
    service.startStep(malformedActionId, { timestamp: Date.now() });
    await service.flushWriteQueue(malformedActionId);
    await service.endTrajectory(malformedActionId, "completed");
    const [malformedStep] = await raw(
      `SELECT id, payload FROM trajectory_steps WHERE trajectory_id = '${malformedActionId}'`,
    );
    const malformedPayload = JSON.parse(String(malformedStep?.payload));
    malformedPayload.action = {
      timestamp: Date.now(),
      actionType: "BROKEN",
      actionName: "BROKEN",
      parameters: {},
      success: false,
    };
    const malformedJson = JSON.stringify(malformedPayload).replaceAll(
      "'",
      "''",
    );
    await raw(
      `UPDATE trajectory_steps SET payload = '${malformedJson}' WHERE id = '${malformedStep?.id}'`,
    );
    await assertAllReadSurfacesReject(malformedActionId, false);

    const malformedActiveId = await service.startTrajectory(
      serviceRuntime.agentId,
      { source: "malformed-active-timing" },
    );
    await service.flushWriteQueue(malformedActiveId);
    const activeEnd = Date.now();
    await raw(
      `UPDATE trajectories SET end_time = ${activeEnd}, duration_ms = 0 WHERE id = '${malformedActiveId}'`,
    );
    await assertAllReadSurfacesReject(malformedActiveId);

    const malformedTerminalId = await service.startTrajectory(
      serviceRuntime.agentId,
      { source: "malformed-terminal-timing" },
    );
    await service.endTrajectory(malformedTerminalId, "completed");
    await raw(
      `UPDATE trajectories SET duration_ms = NULL WHERE id = '${malformedTerminalId}'`,
    );
    await assertAllReadSurfacesReject(malformedTerminalId);
  });
});

describe("provider native-call correlation (real PGlite)", () => {
  it("exports concurrent provider calls with exact turn identities and complete wire values", async () => {
    const runtime = {
      ...serviceRuntime,
      getService: (type: string) => (type === "trajectories" ? service : null),
      getServicesByType: () => [service],
    } as unknown as IAgentRuntime;
    let arrivals = 0;
    let release!: () => void;
    const bothEntered = new Promise<void>((resolve) => {
      release = resolve;
    });
    const calls = await Promise.all(
      [false, true].map(async (explicit) => {
        const context = {
          runId: crypto.randomUUID(),
          roomId: crypto.randomUUID(),
          messageId: crypto.randomUUID(),
          traceId: crypto.randomUUID(),
        };
        const provided = {
          runId: crypto.randomUUID(),
          roomId: crypto.randomUUID(),
          messageId: crypto.randomUUID(),
          executionTraceId: crypto.randomUUID(),
        };
        const trajectoryId = await service.startTrajectory(runtime.agentId, {
          source: "provider-correlation-proof",
          metadata: context,
        });
        const stepId = service.startStep(trajectoryId, {
          timestamp: Date.now(),
        });
        const content = `complete-wire-${context.messageId}:${"all bytes ".repeat(2000)}`;
        const messages = [{ role: "user", content }];
        const tools = {
          inspect: { description: content, parameters: { type: "object" } },
        };
        await runWithTrajectoryContext(
          { ...context, trajectoryId, trajectoryStepId: stepId },
          async () => {
            if (++arrivals === 2) release();
            await bothEntered;
            expect(
              logActiveTrajectoryLlmCall(runtime, {
                model: "deterministic-provider",
                provider: "vercel-ai-sdk",
                systemPrompt: "system",
                userPrompt: content,
                messages,
                tools,
                response: content,
                purpose: "provider",
                actionType: "ai.generateText",
                ...(explicit ? provided : {}),
              }),
            ).toBe(true);
          },
        );
        await service.flushWriteQueue(trajectoryId);
        return {
          trajectoryId,
          expected: explicit
            ? provided
            : { ...context, executionTraceId: context.traceId },
          content,
          messages,
          tools,
        };
      }),
    );
    const exported = await service.exportTrajectories({
      format: "json",
      includePrompts: true,
      trajectoryIds: calls.map((call) => call.trajectoryId),
    });
    const rows: unknown = JSON.parse(
      typeof exported.data === "string"
        ? exported.data
        : Buffer.from(exported.data).toString("utf8"),
    );
    if (!Array.isArray(rows))
      throw new Error("Canonical export must contain rows");
    expect(rows).toHaveLength(2);
    for (const call of calls) {
      const row = rows.find(
        (entry) => entry.trajectoryId === call.trajectoryId,
      );
      expect(row).toMatchObject({
        metadata: {
          source_run_id: call.expected.runId,
          source_room_id: call.expected.roomId,
          source_message_id: call.expected.messageId,
          source_execution_trace_id: call.expected.executionTraceId,
        },
        request: { messages: call.messages, tools: call.tools },
        response: { text: call.content },
      });
    }
  });
});
