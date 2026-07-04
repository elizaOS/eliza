/**
 * Tests `handleBackgroundTasksRoute`, the POST /api/background/run-due-tasks
 * handler that routes native background wakes into the canonical core
 * `TaskService.runDueTasks()`. Covers the happy run, the 503 when no task
 * service is present, coalescing of concurrent wakes into one in-flight run, and
 * pass-through of unrelated paths (with a stubbed `getService`/auth) — then an
 * end-to-end pass against a real `AgentRuntime` + `TaskService` that seeds, runs,
 * and deletes a real due one-shot task.
 */
import * as http from "node:http";
import { Socket } from "node:net";
import {
  AgentRuntime,
  createCharacter,
  ServiceType,
  type UUID,
} from "@elizaos/core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { handleBackgroundTasksRoute } from "./background-tasks-routes";
import type { CompatRuntimeState } from "./compat-route-shared";

vi.mock("@elizaos/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@elizaos/core")>();
  return {
    ...actual,
    ServiceType: { TASK: "task" },
  };
});

vi.mock("./auth.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./auth.ts")>();
  return {
    ...actual,
    ensureRouteAuthorized: vi.fn(async () => true),
  };
});

interface FakeRes {
  res: http.ServerResponse;
  body(): unknown;
  status(): number;
}

function fakeRes(): FakeRes {
  let bodyText = "";
  const req = new http.IncomingMessage(new Socket());
  const res = new http.ServerResponse(req);
  res.statusCode = 200;
  res.setHeader = () => res;
  res.end = ((chunk?: string | Buffer) => {
    if (typeof chunk === "string") bodyText += chunk;
    else if (chunk) bodyText += chunk.toString("utf8");
    return res;
  }) as typeof res.end;
  return {
    res,
    body() {
      return bodyText.length > 0 ? JSON.parse(bodyText) : null;
    },
    status() {
      return res.statusCode;
    },
  };
}

function fakeReq(pathname: string): http.IncomingMessage {
  const req = new http.IncomingMessage(new Socket());
  req.method = "POST";
  req.url = pathname;
  req.headers = { host: "127.0.0.1:31337" };
  Object.defineProperty(req.socket, "remoteAddress", {
    value: "127.0.0.1",
    configurable: true,
  });
  return req;
}

function stateWithTaskService(service: unknown): CompatRuntimeState {
  return {
    current: {
      getService: () => service,
    } as unknown as CompatRuntimeState["current"],
    pendingAgentName: null,
    pendingRestartReasons: [],
  };
}

describe("POST /api/background/run-due-tasks", () => {
  it("routes native wakes into the canonical TaskService runner", async () => {
    const runDueTasks = vi.fn(async () => {});
    const res = fakeRes();

    const handled = await handleBackgroundTasksRoute(
      fakeReq("/api/background/run-due-tasks"),
      res.res,
      stateWithTaskService({ runDueTasks }),
    );

    expect(handled).toBe(true);
    expect(res.status()).toBe(200);
    expect(res.body()).toMatchObject({ ok: true, coalesced: false });
    expect(runDueTasks).toHaveBeenCalledTimes(1);
  });

  it("reports unavailable task service without adding a second scheduler", async () => {
    const res = fakeRes();

    const handled = await handleBackgroundTasksRoute(
      fakeReq("/api/background/run-due-tasks"),
      res.res,
      stateWithTaskService(null),
    );

    expect(handled).toBe(true);
    expect(res.status()).toBe(503);
    expect(res.body()).toEqual({
      ok: false,
      error: "task_service_unavailable",
    });
  });

  it("coalesces concurrent native wakes into one TaskService run", async () => {
    let resolveRun: (() => void) | undefined;
    const runDueTasks = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveRun = resolve;
        }),
    );
    const firstRes = fakeRes();
    const secondRes = fakeRes();
    const state = stateWithTaskService({ runDueTasks });

    const first = handleBackgroundTasksRoute(
      fakeReq("/api/background/run-due-tasks"),
      firstRes.res,
      state,
    );
    await vi.waitFor(() => expect(runDueTasks).toHaveBeenCalledTimes(1));

    const second = handleBackgroundTasksRoute(
      fakeReq("/api/background/run-due-tasks"),
      secondRes.res,
      state,
    );
    resolveRun?.();

    await expect(first).resolves.toBe(true);
    await expect(second).resolves.toBe(true);
    expect(runDueTasks).toHaveBeenCalledTimes(1);
    expect(firstRes.body()).toMatchObject({ ok: true, coalesced: false });
    expect(secondRes.body()).toMatchObject({ ok: true, coalesced: true });
  });

  it("leaves unrelated paths unhandled", async () => {
    const res = fakeRes();
    const handled = await handleBackgroundTasksRoute(
      fakeReq("/api/background/other"),
      res.res,
      stateWithTaskService(null),
    );
    expect(handled).toBe(false);
  });
});

// End-to-end against a real `AgentRuntime` and the canonical core
// `TaskService` (no mocked `getService`). The route resolves the genuine
// `ServiceType.TASK` service and drives `runDueTasks()`, which runs a real
// registered `queue` task worker that mutates real persisted runtime state
// and then deletes the one-shot task row.
//
// NOTE on the full lifeops ScheduledTask path: the route's effect on a
// `LifeOpsRepository` ScheduledTask row (status → "fired") is asserted at the
// scheduler integration layer
// (`plugins/plugin-personal-assistant/src/lifeops/scheduled-task/scheduler.integration.test.ts`),
// which boots a real PGLite-backed runtime with the personal-assistant plugin.
// Re-wiring that cross-package, schema-migrating runtime here would pull the
// heavy lifeops plugin into this fast default-lane unit file; the in-memory
// real runtime below proves the route → real TaskService.runDueTasks() →
// real worker → real DB transition contract without that cost.
describe("POST /api/background/run-due-tasks — real TaskService", () => {
  let runtime: AgentRuntime;
  const WORKER_NAME = "BACKGROUND_ROUTE_REAL_WORKER";
  const RAN_CACHE_KEY = "background-route-real-worker:ran-count";

  beforeAll(async () => {
    runtime = new AgentRuntime({
      character: createCharacter({ name: "BackgroundRouteTestAgent" }),
      plugins: [],
      logLevel: "warn",
      enableAutonomy: false,
    });
    // No SQL plugin: the runtime falls back to the in-memory adapter, which is
    // enough to exercise the real TaskService + task persistence contract.
    await runtime.initialize({ allowNoDatabase: true });

    // A real task worker that records its execution in the (real) runtime
    // cache so we can observe that the route actually drove it.
    runtime.registerTaskWorker({
      name: WORKER_NAME,
      execute: async (rt) => {
        const prior = (await rt.getCache<number>(RAN_CACHE_KEY)) ?? 0;
        await rt.setCache<number>(RAN_CACHE_KEY, prior + 1);
      },
    });
  });

  afterAll(async () => {
    await runtime.stop();
    await runtime.close();
  });

  it("drives the real TaskService runner and transitions persisted task state", async () => {
    const taskService = runtime.getService(ServiceType.TASK);
    expect(taskService).not.toBeNull();
    expect(typeof Reflect.get(taskService as object, "runDueTasks")).toBe(
      "function",
    );

    // Seed a real, due one-shot `queue` task. `runTick` runs non-repeat tasks
    // with no `dueAt`/`scheduledAt` immediately, then deletes them. `agentId`
    // is required: `getTasks`/`runDueTasks` filter by the owning agent.
    const taskId: UUID = await runtime.createTask({
      name: WORKER_NAME,
      description: "Real worker driven by the background route.",
      metadata: { updatedAt: Date.now() },
      tags: ["queue"],
      agentId: runtime.agentId,
    });

    const before = await runtime.getTasks({ tags: ["queue"] });
    expect(before.some((task) => task.id === taskId)).toBe(true);
    expect(await runtime.getCache<number>(RAN_CACHE_KEY)).toBeUndefined();

    const res = fakeRes();
    const handled = await handleBackgroundTasksRoute(
      fakeReq("/api/background/run-due-tasks"),
      res.res,
      {
        current: runtime,
        pendingAgentName: null,
        pendingRestartReasons: [],
      },
    );

    expect(handled).toBe(true);
    expect(res.status()).toBe(200);
    expect(res.body()).toMatchObject({ ok: true, coalesced: false });

    // The real worker ran exactly once: the route → TaskService.runDueTasks()
    // → real worker execution path is live.
    expect(await runtime.getCache<number>(RAN_CACHE_KEY)).toBe(1);

    // The persisted one-shot task transitioned: the real TaskService deleted
    // it from the real DB after a successful run.
    const after = await runtime.getTasks({ tags: ["queue"] });
    expect(after.some((task) => task.id === taskId)).toBe(false);
  });
});
