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
  type ScheduledTask,
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

  it("POST /:id/fire on an unknown task id reports 404, never a false 'fired'", async () => {
    const runner = makeRunner();
    const handler = makeScheduledTasksRouteHandler({
      resolveRunner: async () => runner,
    });
    const { ctx, res } = buildCtx({
      method: "POST",
      pathname: "/api/lifeops/scheduled-tasks/does-not-exist/fire",
    });
    await handler(ctx);
    // A missing row is a not-found, not a client bad-request: the runner throws
    // `fire: task <id> not found`, which the route maps to 404 (never a false
    // "fired" and never a misleading 400).
    expect(res.statusCode).toBe(404);
    const payload = JSON.parse(res.body ?? "{}");
    expect(payload.error).toMatch(/not found/);
  });

  it("POST /:id/<verb> on an unknown task id reports 404 (apply not-found is distinct from bad input)", async () => {
    const runner = makeRunner();
    const handler = makeScheduledTasksRouteHandler({
      resolveRunner: async () => runner,
    });
    const { ctx, res } = buildCtx({
      method: "POST",
      pathname: "/api/lifeops/scheduled-tasks/does-not-exist/complete",
    });
    await handler(ctx);
    expect(res.statusCode).toBe(404);
    const payload = JSON.parse(res.body ?? "{}");
    expect(payload.error).toMatch(/not found/);
  });

  it("POST /:id/reopen on a non-terminal task is a 409 conflict, not 400 or 500", async () => {
    // Reopening a task that is not in a terminal state is a caller error about
    // the resource's current state (the runner throws `reopen: ... not in a
    // terminal state`), which maps to 409 — not a masked 400 and not a 500.
    const runner = makeRunner();
    const handler = makeScheduledTasksRouteHandler({
      resolveRunner: async () => runner,
    });
    const scheduled = await runner.schedule({
      kind: "reminder",
      promptInstructions: "still scheduled",
      trigger: { kind: "manual" },
      priority: "low",
      respectsGlobalPause: true,
      source: "user_chat",
      createdBy: "tester",
      ownerVisible: true,
    } as Omit<ScheduledTask, "taskId" | "state">);
    const { ctx, res } = buildCtx({
      method: "POST",
      pathname: `/api/lifeops/scheduled-tasks/${scheduled.taskId}/reopen`,
    });
    await handler(ctx);
    expect(res.statusCode).toBe(409);
    const payload = JSON.parse(res.body ?? "{}");
    expect(payload.error).toMatch(/terminal state/);
  });

  it("POST /:id/fire surfaces a genuine runner failure as 500, not 400", async () => {
    // A runner whose fire path throws a non-typed internal error must reach the
    // caller as a server failure (500), not be masked as a client 400.
    const runner = makeRunner();
    const failing: ScheduledTaskRunnerHandle = {
      ...runner,
      fireWithResult: async () => {
        throw new Error("transport exploded");
      },
    };
    const handler = makeScheduledTasksRouteHandler({
      resolveRunner: async () => failing,
    });
    const { ctx, res } = buildCtx({
      method: "POST",
      pathname: "/api/lifeops/scheduled-tasks/some-id/fire",
    });
    await handler(ctx);
    expect(res.statusCode).toBe(500);
    const payload = JSON.parse(res.body ?? "{}");
    expect(payload.error).toMatch(/transport exploded/);
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

  it("rejects illegal percent-encoding in task ids with 400 before runner calls", async () => {
    let listed = 0;
    let applied = 0;
    let fired = 0;
    const runner = makeRunner();
    const origList = runner.list.bind(runner);
    const origApply = runner.apply.bind(runner);
    const origFire = runner.fireWithResult.bind(runner);
    runner.list = async (filter) => {
      listed += 1;
      return origList(filter);
    };
    runner.apply = async (id, verb, payload) => {
      applied += 1;
      return origApply(id, verb, payload);
    };
    runner.fireWithResult = async (id, opts) => {
      fired += 1;
      return origFire(id, opts);
    };
    const handler = makeScheduledTasksRouteHandler({
      resolveRunner: async () => runner,
    });
    for (const { method, pathname } of [
      { method: "POST", pathname: "/api/lifeops/scheduled-tasks/%/complete" },
      { method: "GET", pathname: "/api/lifeops/scheduled-tasks/%2/history" },
      { method: "POST", pathname: "/api/lifeops/scheduled-tasks/%ZZ/fire" },
      {
        method: "GET",
        pathname: "/api/lifeops/dev/scheduled-tasks/%/log",
      },
    ]) {
      const { ctx, res } = buildCtx({ method, pathname });
      const handled = await handler(ctx);
      expect(handled).toBe(true);
      expect(res.statusCode).toBe(400);
      expect(res.body).toContain("percent-encoding");
    }
    expect(listed).toBe(0);
    expect(applied).toBe(0);
    expect(fired).toBe(0);
  });

  it("still applies a canonically encoded task id", async () => {
    const runner = makeRunner();
    const task = await runner.schedule({
      kind: "reminder",
      promptInstructions: "encoded-id",
      trigger: { kind: "manual" },
      priority: "low",
      respectsGlobalPause: true,
      source: "user_chat",
      createdBy: "x",
      ownerVisible: true,
    });
    const encoded = `%${task.taskId.charCodeAt(0).toString(16)}${task.taskId.slice(1)}`;
    expect(decodeURIComponent(encoded)).toBe(task.taskId);
    expect(encoded).not.toBe(task.taskId);
    const handler = makeScheduledTasksRouteHandler({
      resolveRunner: async () => runner,
    });
    const { ctx, res } = buildCtx({
      method: "POST",
      pathname: `/api/lifeops/scheduled-tasks/${encoded}/complete`,
      body: { reason: "canonical-encoding" },
    });
    await handler(ctx);
    expect(res.statusCode).toBe(200);
    const all = await runner.list();
    expect(all.find((t) => t.taskId === task.taskId)?.state.status).toBe(
      "completed",
    );
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

  describe("POST /:id/edit validates the body like its sibling snooze verb", () => {
    const BASE_INPUT = {
      kind: "reminder",
      promptInstructions: "drink water",
      trigger: { kind: "manual" },
      priority: "low",
      respectsGlobalPause: true,
      source: "user_chat",
      createdBy: "tester",
      ownerVisible: true,
    } as const;

    async function seed(): Promise<{
      runner: ScheduledTaskRunnerHandle;
      handler: (ctx: SchedulingRouteContext) => Promise<boolean>;
      task: ScheduledTask;
    }> {
      const runner = makeRunner();
      const handler = makeScheduledTasksRouteHandler({
        resolveRunner: async () => runner,
      });
      const { ctx, res } = buildCtx({
        method: "POST",
        pathname: "/api/lifeops/scheduled-tasks",
        body: BASE_INPUT,
      });
      await handler(ctx);
      expect(res.statusCode).toBe(201);
      return {
        runner,
        handler,
        task: JSON.parse(res.body ?? "{}").task as ScheduledTask,
      };
    }

    async function edit(
      handler: (ctx: SchedulingRouteContext) => Promise<boolean>,
      taskId: string,
      body: unknown,
    ): Promise<MockResponse> {
      const { ctx, res } = buildCtx({
        method: "POST",
        pathname: `/api/lifeops/scheduled-tasks/${taskId}/edit`,
        body,
      });
      await handler(ctx);
      return res;
    }

    it("still accepts every editable ScheduledTaskInput field (no over-rejection)", async () => {
      const { runner, handler, task } = await seed();
      const fullPatch = {
        kind: "checkin",
        promptInstructions: "updated text",
        contextRequest: {
          includeOwnerFacts: ["timezone"],
          includeEventPayload: true,
        },
        trigger: { kind: "interval", everyMinutes: 30 },
        priority: "high",
        shouldFire: { compose: "all", gates: [{ kind: "quiet_hours" }] },
        completionCheck: {
          kind: "user_acknowledged",
          followupAfterMinutes: 10,
        },
        escalation: { steps: [{ delayMinutes: 5, channelKey: "chat" }] },
        output: { destination: "in_app_card" },
        pipeline: { onComplete: [] },
        subject: { kind: "self", id: "owner" },
        idempotencyKey: "idem-1",
        respectsGlobalPause: false,
        source: "plugin",
        createdBy: "someone-else",
        ownerVisible: false,
        metadata: { note: "kept" },
        executionProfile: "bg-light-30s",
      };
      const res = await edit(handler, task.taskId, fullPatch);
      expect(res.statusCode).toBe(200);
      const persisted = (await runner.list()).find(
        (t) => t.taskId === task.taskId,
      );
      for (const [key, value] of Object.entries(fullPatch)) {
        if (key === "metadata") continue;
        expect(persisted?.[key as keyof ScheduledTask]).toEqual(value);
      }
      expect(persisted?.metadata?.note).toBe("kept");
    });

    it("returns 400 (not 500) for a malformed trigger", async () => {
      const { runner, handler, task } = await seed();
      const res = await edit(
        handler,
        task.taskId,
        JSON.parse('{"trigger":null}'),
      );
      expect(res.statusCode).toBe(400);
      expect(res.body).toContain("invalid edit payload");
      const persisted = (await runner.list()).find(
        (t) => t.taskId === task.taskId,
      );
      expect(persisted?.trigger).toEqual({ kind: "manual" });
    });

    it("rejects wrong-typed fields the create path already rejects, leaving the task untouched", async () => {
      const { runner, handler, task } = await seed();
      const res = await edit(
        handler,
        task.taskId,
        JSON.parse(
          '{"kind":12345,"priority":{"$ne":1},"ownerVisible":"yes","createdBy":null}',
        ),
      );
      expect(res.statusCode).toBe(400);
      const persisted = (await runner.list()).find(
        (t) => t.taskId === task.taskId,
      );
      expect(persisted?.kind).toBe("reminder");
      expect(persisted?.priority).toBe("low");
      expect(persisted?.ownerVisible).toBe(true);
      expect(persisted?.createdBy).toBe("tester");
    });

    it("rejects an unknown field instead of silently dropping it", async () => {
      const { handler, task } = await seed();
      const res = await edit(handler, task.taskId, { whatever: "junk" });
      expect(res.statusCode).toBe(400);
      expect(res.body).toContain("whatever");
    });

    it("does not re-parent the task when the body carries an own __proto__ key", async () => {
      const { runner, handler, task } = await seed();
      const body = JSON.parse(
        '{"promptInstructions":"edited","__proto__":{"isAdmin":true}}',
      );
      expect(Object.hasOwn(body, "__proto__")).toBe(true);
      const res = await edit(handler, task.taskId, body);
      expect(res.statusCode).toBe(409);
      expect(res.body).toContain("edit: __proto__ is read-only");
      const persisted = (await runner.list()).find(
        (t) => t.taskId === task.taskId,
      );
      expect(Object.getPrototypeOf(persisted)).toBe(Object.prototype);
      expect((persisted as unknown as { isAdmin?: unknown }).isAdmin).toBe(
        undefined,
      );
      expect(({} as { isAdmin?: unknown }).isAdmin).toBe(undefined);
      expect(persisted?.promptInstructions).toBe("drink water");
    });

    it("keeps the 409 read-only contract for the server-managed keys", async () => {
      const { handler, task } = await seed();
      for (const key of ["taskId", "state"] as const) {
        const res = await edit(handler, task.taskId, { [key]: "anything" });
        expect(res.statusCode).toBe(409);
        expect(res.body).toContain(`edit: ${key} is read-only`);
      }
    });
  });
});
