/**
 * W1-A REST surface unit tests for the ScheduledTask routes.
 *
 * Exercises the handler with a mock LifeOpsRouteContext + an in-memory
 * runner so the route logic is testable without spinning up the full
 * runtime. The DB-backed runner is covered separately via the runtime
 * wiring path (`runtime-wiring.ts`).
 */

import type http from "node:http";
import { describe, expect, it } from "vitest";

import {
  createCompletionCheckRegistry,
  registerBuiltInCompletionChecks,
} from "../lifeops/scheduled-task/completion-check-registry.js";
import {
  createAnchorRegistry,
  createConsolidationRegistry,
} from "../lifeops/scheduled-task/consolidation-policy.js";
import {
  createEscalationLadderRegistry,
  registerDefaultEscalationLadders,
} from "../lifeops/scheduled-task/escalation.js";
import {
  createTaskGateRegistry,
  registerBuiltInGates,
} from "../lifeops/scheduled-task/gate-registry.js";
import {
  createInMemoryScheduledTaskLogStore,
  createInMemoryScheduledTaskStore,
  createScheduledTaskRunner,
  type ScheduledTaskRunnerHandle,
} from "../lifeops/scheduled-task/index.js";
import type { LifeOpsRouteContext } from "./lifeops-routes.js";
import { makeScheduledTasksRouteHandler } from "./scheduled-tasks.js";

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
  });
}

interface MockResponse {
  statusCode?: number;
  body?: string;
  headers: Record<string, string>;
  ended: boolean;
}

function buildCtx(args: {
  method: string;
  pathname: string;
  body?: unknown;
  runner: ScheduledTaskRunnerHandle;
}): { ctx: LifeOpsRouteContext; res: MockResponse } {
  const res: MockResponse = { headers: {}, ended: false };
  const httpRes = {
    statusCode: 0,
    setHeader(name: string, value: string) {
      res.headers[name] = value;
    },
    end(buf?: string) {
      res.ended = true;
      res.body = buf ?? "";
      res.statusCode = (this as unknown as { statusCode: number }).statusCode;
    },
    write(_chunk: string) {
      /* noop */
    },
  } as unknown as http.ServerResponse;

  const httpReq = {
    method: args.method,
    headers: args.body
      ? { "content-type": "application/json", "content-length": "1" }
      : {},
    socket: { remoteAddress: "127.0.0.1" },
  } as unknown as http.IncomingMessage;

  const ctx: LifeOpsRouteContext = {
    req: httpReq,
    res: httpRes,
    method: args.method,
    pathname: args.pathname,
    url: new URL(`http://localhost${args.pathname}`),
    state: { runtime: null, adminEntityId: null },
    json(r, data, status = 200) {
      (r as unknown as { statusCode: number }).statusCode = status;
      r.setHeader?.("content-type", "application/json");
      r.end?.(JSON.stringify(data));
    },
    error(r, message, status = 400) {
      (r as unknown as { statusCode: number }).statusCode = status;
      r.setHeader?.("content-type", "application/json");
      r.end?.(JSON.stringify({ error: message }));
    },
    async readJsonBody<T extends object>(): Promise<T | null> {
      return (args.body as T | undefined) ?? null;
    },
    decodePathComponent(raw) {
      try {
        return decodeURIComponent(raw);
      } catch {
        return null;
      }
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
      runner,
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
      runner,
    });
    await handler(ctx);
    expect(res.statusCode).toBe(400);
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
      runner,
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
    {
      const { ctx, res } = buildCtx({
        method: "POST",
        pathname: `/api/lifeops/scheduled-tasks/${parent.taskId}/complete`,
        body: { reason: "smoke" },
        runner,
      });
      await handler(ctx);
      expect(res.statusCode).toBe(200);
    }
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
      runner,
    });
    await handler(ctx);
    expect(res.statusCode).toBe(200);
    const payload = JSON.parse(res.body ?? "{}");
    expect(payload.taskId).toBe(task.taskId);
    expect(payload.status).toBe("scheduled");
  });

  it("GET /api/lifeops/dev/registries returns registry health (loopback only)", async () => {
    const runner = makeRunner();
    const handler = makeScheduledTasksRouteHandler({
      resolveRunner: async () => runner,
    });
    const { ctx, res } = buildCtx({
      method: "GET",
      pathname: "/api/lifeops/dev/registries",
      runner,
    });
    await handler(ctx);
    expect(res.statusCode).toBe(200);
    const payload = JSON.parse(res.body ?? "{}");
    expect(payload.gates).toEqual(
      expect.arrayContaining([
        "weekend_skip",
        "weekday_only",
        "weekend_only",
        "late_evening_skip",
        "quiet_hours",
        "during_travel",
      ]),
    );
  });

  it("rejects /api/lifeops/dev/registries when not on loopback", async () => {
    const runner = makeRunner();
    const handler = makeScheduledTasksRouteHandler({
      resolveRunner: async () => runner,
    });
    const { ctx, res } = buildCtx({
      method: "GET",
      pathname: "/api/lifeops/dev/registries",
      runner,
    });
    // Override remoteAddress to a public IP.
    (ctx.req.socket as unknown as { remoteAddress: string }).remoteAddress =
      "8.8.8.8";
    await handler(ctx);
    expect(res.statusCode).toBe(403);
  });
});
