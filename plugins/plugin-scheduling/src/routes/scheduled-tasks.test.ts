/**
 * Unit tests for the generic ScheduledTask REST handler now owned by
 * `@elizaos/plugin-scheduling`. Exercises the handler with a mock
 * `SchedulingRouteContext` + an in-memory runner so the route logic is testable
 * without spinning up a full runtime.
 */

import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { describe, expect, it } from "vitest";
import {
  createAnchorRegistry,
  createCompletionCheckRegistry,
  createConsolidationRegistry,
  createEscalationLadderRegistry,
  createInMemoryScheduledTaskLogStore,
  createInMemoryScheduledTaskStore,
  createScheduledTaskRunner,
  createTaskGateRegistry,
  registerBuiltInCompletionChecks,
  registerBuiltInGates,
  registerDefaultEscalationLadders,
  type ScheduledTaskRunnerHandle,
  TestNoopScheduledTaskDispatcher,
} from "../scheduled-task/index.js";
import {
  makeScheduledTasksRouteHandler,
  type SchedulingRouteContext,
} from "./scheduled-tasks.js";

function makeRunner(): ScheduledTaskRunnerHandle {
  const gates = createTaskGateRegistry();
  registerBuiltInGates(gates);
  const completionChecks = createCompletionCheckRegistry();
  registerBuiltInCompletionChecks(completionChecks);
  const ladders = createEscalationLadderRegistry();
  registerDefaultEscalationLadders(ladders);
  return createScheduledTaskRunner({
    agentId: "test-agent",
    store: createInMemoryScheduledTaskStore(),
    logStore: createInMemoryScheduledTaskLogStore(),
    gates,
    completionChecks,
    ladders,
    anchors: createAnchorRegistry(),
    consolidation: createConsolidationRegistry(),
    ownerFacts: async () => ({}),
    globalPause: { current: async () => ({ active: false }) },
    activity: { hasSignalSince: () => false },
    subjectStore: { wasUpdatedSince: () => false },
    dispatcher: TestNoopScheduledTaskDispatcher,
  });
}

interface MockResponse {
  statusCode?: number;
  body?: string;
  ended: boolean;
}

function setRemoteAddress(socket: Socket, remoteAddress: string): void {
  Object.defineProperty(socket, "remoteAddress", {
    value: remoteAddress,
    configurable: true,
  });
}

function buildCtx(args: { method: string; pathname: string; body?: unknown }): {
  ctx: SchedulingRouteContext;
  res: MockResponse;
} {
  const res: MockResponse = { ended: false };
  const socket = new Socket();
  setRemoteAddress(socket, "127.0.0.1");
  const httpReq = new IncomingMessage(socket);
  httpReq.method = args.method;
  httpReq.headers = args.body
    ? { "content-type": "application/json", "content-length": "1" }
    : {};
  const httpRes = new ServerResponse(httpReq);

  const ctx: SchedulingRouteContext = {
    req: httpReq,
    res: httpRes,
    method: args.method,
    pathname: args.pathname,
    url: new URL(`http://localhost${args.pathname}`),
    json(_r, data, status = 200) {
      res.statusCode = status;
      res.body = JSON.stringify(data);
      res.ended = true;
    },
    error(_r, message, status = 400) {
      res.statusCode = status;
      res.body = JSON.stringify({ error: message });
      res.ended = true;
    },
    async readJsonBody<T extends object>(): Promise<T | null> {
      return (args.body as T | undefined) ?? null;
    },
  };
  return { ctx, res };
}

describe("scheduled-tasks REST handler", () => {
  it("POST /api/lifeops/scheduled-tasks creates and returns a task", async () => {
    const runner = makeRunner();
    const handler = makeScheduledTasksRouteHandler({
      resolveRunner: async () => runner,
    });
    const { ctx, res } = buildCtx({
      method: "POST",
      pathname: "/api/lifeops/scheduled-tasks",
      body: {
        kind: "reminder",
        promptInstructions: "drink water",
        trigger: { kind: "manual" },
        priority: "low",
        respectsGlobalPause: true,
        source: "user_chat",
        createdBy: "tester",
        ownerVisible: true,
      },
    });
    const handled = await handler(ctx);
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(201);
    const payload = JSON.parse(res.body ?? "{}");
    expect(payload.task.taskId).toBeDefined();
    expect(payload.task.state.status).toBe("scheduled");
  });

  it("POST schedule rejects invalid payloads with 400", async () => {
    const runner = makeRunner();
    const handler = makeScheduledTasksRouteHandler({
      resolveRunner: async () => runner,
    });
    const { ctx, res } = buildCtx({
      method: "POST",
      pathname: "/api/lifeops/scheduled-tasks",
      body: { kind: "not-a-real-kind" },
    });
    await handler(ctx);
    expect(res.statusCode).toBe(400);
  });

  it("POST schedule returns 400 for unknown gates before persistence (#11791)", async () => {
    const runner = makeRunner();
    const handler = makeScheduledTasksRouteHandler({
      resolveRunner: async () => runner,
    });
    const { ctx, res } = buildCtx({
      method: "POST",
      pathname: "/api/lifeops/scheduled-tasks",
      body: {
        kind: "reminder",
        promptInstructions: "drink water",
        trigger: { kind: "manual" },
        priority: "low",
        respectsGlobalPause: true,
        source: "user_chat",
        createdBy: "tester",
        ownerVisible: true,
        shouldFire: { gates: [{ kind: "not_registered" }] },
      },
    });
    await handler(ctx);
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain("not_registered");
    expect(await runner.list()).toHaveLength(0);
  });

  it("GET /api/lifeops/scheduled-tasks lists tasks", async () => {
    const runner = makeRunner();
    await runner.schedule({
      kind: "reminder",
      promptInstructions: "ping",
      trigger: { kind: "manual" },
      priority: "low",
      respectsGlobalPause: true,
      source: "user_chat",
      createdBy: "x",
      ownerVisible: true,
    });
    const handler = makeScheduledTasksRouteHandler({
      resolveRunner: async () => runner,
    });
    const { ctx, res } = buildCtx({
      method: "GET",
      pathname: "/api/lifeops/scheduled-tasks",
    });
    await handler(ctx);
    expect(res.statusCode).toBe(200);
    const payload = JSON.parse(res.body ?? "{}");
    expect(payload.tasks).toHaveLength(1);
  });

  it("POST /:id/complete fires onComplete pipeline; /:id/acknowledge does not (cross-agent §7.6)", async () => {
    const runner = makeRunner();
    const child = {
      kind: "reminder" as const,
      promptInstructions: "child-of-pipeline",
      trigger: { kind: "manual" as const },
      priority: "low" as const,
      respectsGlobalPause: true,
      source: "user_chat" as const,
      createdBy: "x",
      ownerVisible: true,
    };
    const parent = await runner.schedule({
      ...child,
      promptInstructions: "parent",
      pipeline: { onComplete: [child as never] },
    });
    const handler = makeScheduledTasksRouteHandler({
      resolveRunner: async () => runner,
    });
    const { ctx, res } = buildCtx({
      method: "POST",
      pathname: `/api/lifeops/scheduled-tasks/${parent.taskId}/complete`,
      body: { reason: "smoke" },
    });
    await handler(ctx);
    expect(res.statusCode).toBe(200);
    const all = await runner.list();
    expect(
      all.find((t) => t.promptInstructions === "child-of-pipeline"),
    ).toBeDefined();
  });

  it("GET /:id/history returns user-visible state surface", async () => {
    const runner = makeRunner();
    const task = await runner.schedule({
      kind: "reminder",
      promptInstructions: "x",
      trigger: { kind: "manual" },
      priority: "low",
      respectsGlobalPause: true,
      source: "user_chat",
      createdBy: "x",
      ownerVisible: true,
    });
    const handler = makeScheduledTasksRouteHandler({
      resolveRunner: async () => runner,
    });
    const { ctx, res } = buildCtx({
      method: "GET",
      pathname: `/api/lifeops/scheduled-tasks/${task.taskId}/history`,
    });
    await handler(ctx);
    expect(res.statusCode).toBe(200);
    const payload = JSON.parse(res.body ?? "{}");
    expect(payload.taskId).toBe(task.taskId);
    expect(payload.status).toBe("scheduled");
  });

  it("POST /:id/fire fires a task on demand and returns the typed outcome", async () => {
    const runner = makeRunner();
    const task = await runner.schedule({
      kind: "reminder",
      promptInstructions: "fire me now",
      trigger: { kind: "manual" },
      priority: "low",
      respectsGlobalPause: false,
      source: "user_chat",
      createdBy: "x",
      ownerVisible: true,
    });
    const handler = makeScheduledTasksRouteHandler({
      resolveRunner: async () => runner,
    });
    const { ctx, res } = buildCtx({
      method: "POST",
      pathname: `/api/lifeops/scheduled-tasks/${task.taskId}/fire`,
    });
    const handled = await handler(ctx);
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    const payload = JSON.parse(res.body ?? "{}");
    expect(payload.fire.kind).toBe("fired");
    expect(payload.fire.task.taskId).toBe(task.taskId);
    expect(payload.fire.task.state.status).toBe("fired");
  });

  it("POST /:id/fire on an unknown task id does not fire and reports it (never a false 'fired')", async () => {
    const runner = makeRunner();
    const handler = makeScheduledTasksRouteHandler({
      resolveRunner: async () => runner,
    });
    const { ctx, res } = buildCtx({
      method: "POST",
      pathname: "/api/lifeops/scheduled-tasks/does-not-exist/fire",
    });
    await handler(ctx);
    // Either a 400 error or a typed non-"fired" outcome is acceptable; a false
    // "fired" for a missing row is not.
    if (res.statusCode === 200) {
      const payload = JSON.parse(res.body ?? "{}");
      expect(payload.fire.kind).not.toBe("fired");
    } else {
      expect(res.statusCode).toBe(400);
    }
  });

  it("POST /test-probe seeds a due-now reminder and fires it in one call", async () => {
    const runner = makeRunner();
    const handler = makeScheduledTasksRouteHandler({
      resolveRunner: async () => runner,
    });
    const { ctx, res } = buildCtx({
      method: "POST",
      pathname: "/api/lifeops/scheduled-tasks/test-probe",
    });
    const handled = await handler(ctx);
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(201);
    const payload = JSON.parse(res.body ?? "{}");
    expect(payload.task.kind).toBe("reminder");
    expect(payload.task.metadata.liveTest).toBe(true);
    expect(payload.fire.kind).toBe("fired");
    // The seeded probe row is discoverable in the task list.
    const all = await runner.list();
    expect(all.some((t) => t.metadata?.liveTest === true)).toBe(true);
  });

  it("POST /test-probe honors kind:checkin", async () => {
    const runner = makeRunner();
    const handler = makeScheduledTasksRouteHandler({
      resolveRunner: async () => runner,
    });
    const { ctx, res } = buildCtx({
      method: "POST",
      pathname: "/api/lifeops/scheduled-tasks/test-probe",
      body: { kind: "checkin" },
    });
    await handler(ctx);
    expect(res.statusCode).toBe(201);
    const payload = JSON.parse(res.body ?? "{}");
    expect(payload.task.kind).toBe("checkin");
  });

  it("GET /api/lifeops/dev/scheduling/registries returns spine registry health (loopback only)", async () => {
    const runner = makeRunner();
    const handler = makeScheduledTasksRouteHandler({
      resolveRunner: async () => runner,
    });
    const { ctx, res } = buildCtx({
      method: "GET",
      pathname: "/api/lifeops/dev/scheduling/registries",
    });
    await handler(ctx);
    expect(res.statusCode).toBe(200);
    const payload = JSON.parse(res.body ?? "{}");
    expect(payload.gates).toEqual(
      expect.arrayContaining(["weekend_skip", "quiet_hours"]),
    );
  });
});
