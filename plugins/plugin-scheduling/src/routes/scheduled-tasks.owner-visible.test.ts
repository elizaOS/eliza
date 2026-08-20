/** Exercises owner-visible task filtering through the scheduled-task route harness. */
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

function buildCtx(pathname: string): {
  ctx: SchedulingRouteContext;
  res: MockResponse;
} {
  const res: MockResponse = { ended: false };
  const socket = new Socket();
  Object.defineProperty(socket, "remoteAddress", {
    value: "127.0.0.1",
    configurable: true,
  });
  const httpReq = new IncomingMessage(socket);
  httpReq.method = "GET";
  const httpRes = new ServerResponse(httpReq);
  const ctx: SchedulingRouteContext = {
    req: httpReq,
    res: httpRes,
    method: "GET",
    pathname: new URL(`http://localhost${pathname}`).pathname,
    url: new URL(`http://localhost${pathname}`),
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
      return null;
    },
  };
  return { ctx, res };
}

async function seed(runner: ScheduledTaskRunnerHandle) {
  await runner.schedule({
    kind: "reminder",
    promptInstructions: "visible",
    trigger: { kind: "manual" },
    priority: "low",
    respectsGlobalPause: true,
    source: "user_chat",
    createdBy: "x",
    ownerVisible: true,
  });
  await runner.schedule({
    kind: "reminder",
    promptInstructions: "hidden",
    trigger: { kind: "manual" },
    priority: "low",
    respectsGlobalPause: true,
    source: "user_chat",
    createdBy: "x",
    ownerVisible: false,
  });
}

describe("GET /api/lifeops/scheduled-tasks ownerVisibleOnly identity", () => {
  it.each([
    "/api/lifeops/scheduled-tasks",
    "/api/lifeops/scheduled-tasks?ownerVisibleOnly=",
  ])("accepts %s as list-all", async (pathname) => {
    const runner = makeRunner();
    await seed(runner);
    let listed = 0;
    const original = runner.list.bind(runner);
    runner.list = async (filter) => {
      listed += 1;
      return original(filter);
    };
    const handler = makeScheduledTasksRouteHandler({
      resolveRunner: async () => runner,
    });
    const { ctx, res } = buildCtx(pathname);
    await handler(ctx);
    expect(res.statusCode).toBe(200);
    const payload = JSON.parse(res.body ?? "{}") as {
      tasks: Array<{ promptInstructions: string }>;
    };
    expect(payload.tasks.map((t) => t.promptInstructions).sort()).toEqual([
      "hidden",
      "visible",
    ]);
    expect(listed).toBe(1);
  });

  it("accepts ownerVisibleOnly=1 as owner-visible-only list", async () => {
    const runner = makeRunner();
    await seed(runner);
    const handler = makeScheduledTasksRouteHandler({
      resolveRunner: async () => runner,
    });
    const { ctx, res } = buildCtx(
      "/api/lifeops/scheduled-tasks?ownerVisibleOnly=1",
    );
    await handler(ctx);
    expect(res.statusCode).toBe(200);
    const payload = JSON.parse(res.body ?? "{}") as {
      tasks: Array<{ promptInstructions: string }>;
    };
    expect(payload.tasks.map((t) => t.promptInstructions)).toEqual(["visible"]);
  });

  it.each(["true", "TRUE", "yes", "foo", "0", "false", "1e2"])(
    "rejects ownerVisibleOnly=%s before list",
    async (token) => {
      const runner = makeRunner();
      await seed(runner);
      let listed = 0;
      const original = runner.list.bind(runner);
      runner.list = async (filter) => {
        listed += 1;
        return original(filter);
      };
      let resolved = 0;
      const handler = makeScheduledTasksRouteHandler({
        resolveRunner: async () => {
          resolved += 1;
          return runner;
        },
      });
      const { ctx, res } = buildCtx(
        `/api/lifeops/scheduled-tasks?ownerVisibleOnly=${encodeURIComponent(token)}`,
      );
      await handler(ctx);
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body ?? "{}")).toMatchObject({
        error: 'ownerVisibleOnly must be specified at most once as "1".',
      });
      expect(resolved).toBe(0);
      expect(listed).toBe(0);
    },
  );

  it.each([
    "/api/lifeops/scheduled-tasks?ownerVisibleOnly=1&ownerVisibleOnly=1",
    "/api/lifeops/scheduled-tasks?ownerVisibleOnly=1&ownerVisibleOnly=0",
    "/api/lifeops/scheduled-tasks?ownerVisibleOnly=&ownerVisibleOnly=1",
    "/api/lifeops/scheduled-tasks?ownerVisibleOnly=foo&ownerVisibleOnly=1",
  ])(
    "rejects duplicate ownerVisibleOnly values in %s before list",
    async (pathname) => {
      let resolved = 0;
      const handler = makeScheduledTasksRouteHandler({
        resolveRunner: async () => {
          resolved += 1;
          return makeRunner();
        },
      });
      const { ctx, res } = buildCtx(pathname);
      await handler(ctx);
      expect(res.statusCode).toBe(400);
      expect(resolved).toBe(0);
    },
  );
});
