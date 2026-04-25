import { beforeEach, describe, expect, test, vi } from "vitest";
import type { AgentRuntime } from "@elizaos/core";
import { runScenario } from "./executor.ts";

const apiCalls: Array<{
  method: string;
  path: string;
  body: unknown;
}> = [];

const tickCalls: Array<Record<string, unknown>> = [];

vi.mock("@elizaos/app-lifeops/routes/lifeops-routes", () => ({
  handleLifeOpsRoutes: vi.fn(async (ctx: {
    method: string;
    pathname: string;
    url: URL;
    req: unknown;
    res: unknown;
    json: (res: unknown, data: unknown, status?: number) => void;
    readJsonBody: () => Promise<unknown>;
  }) => {
    const body = await ctx.readJsonBody();
    apiCalls.push({
      method: ctx.method,
      path: `${ctx.pathname}${ctx.url.search}`,
      body,
    });
    ctx.json(
      ctx.res,
      {
        ok: true,
        method: ctx.method,
        path: `${ctx.pathname}${ctx.url.search}`,
        body,
      },
      201,
    );
    return true;
  }),
}));

vi.mock("@elizaos/app-lifeops/lifeops/runtime", () => {
  return {
    LIFEOPS_TASK_NAME: "LIFEOPS_SCHEDULER",
    LIFEOPS_TASK_TAGS: ["queue", "repeat", "lifeops"],
    LIFEOPS_TASK_INTERVAL_MS: 60_000,
    LIFEOPS_TASK_JITTER_MS: 10_000,
    ensureRuntimeAgentRecord: vi.fn(async () => undefined),
    ensureLifeOpsSchedulerTask: vi.fn(async () => "mock-lifeops-task"),
    registerLifeOpsTaskWorker: vi.fn(() => undefined),
    resolveLifeOpsTaskIntervalMs: vi.fn(() => 60_000),
    executeLifeOpsSchedulerTask: vi.fn(
      async (_runtime: AgentRuntime, options: Record<string, unknown>) => {
        tickCalls.push(options);
        return {
          nextInterval: 60_000,
          now: String(options.now),
          reminderAttempts: [],
          workflowRuns: [{ id: "wf-run-1" }],
        };
      },
    ),
  };
});

describe("scenario-runner executor", () => {
  beforeEach(() => {
    apiCalls.length = 0;
    tickCalls.length = 0;
  });

  test("supports advanceClock seeds plus api and tick turns", async () => {
    const seedTimes: string[] = [];
    const runtime = {
      agentId: "00000000-0000-0000-0000-000000000999",
      ensureConnection: vi.fn(async () => undefined),
      createMemory: vi.fn(async () => undefined),
      actions: [],
    } as unknown as AgentRuntime;

    const report = await runScenario(
      {
        id: "ws6.runner.clock-api-tick",
        title: "WS6 runner support",
        domain: "scenario-runner",
        seed: [
          {
            type: "advanceClock",
            by: "48h",
          },
          {
            type: "custom",
            name: "capture-seed-now",
            apply: async (ctx) => {
              if (typeof ctx.now === "string") {
                seedTimes.push(ctx.now);
              }
              return undefined;
            },
          },
        ],
        turns: [
          {
            kind: "api",
            name: "create workflow through local routes",
            method: "POST",
            path: "/api/lifeops/workflows?at={{now}}",
            body: {
              title: "Post-meeting summary",
              schedule: {
                dueAt: "{{now+10m}}",
              },
            },
            expectedStatus: 201,
            assertResponse: (status, body) => {
              if (status !== 201) {
                return `expected 201, saw ${status}`;
              }
              const record = body as { ok?: boolean };
              if (record.ok !== true) {
                return "expected route body to include ok=true";
              }
              return undefined;
            },
          },
          {
            kind: "tick",
            name: "tick lifeops scheduler",
            worker: "lifeops_scheduler",
            now: "{{now+1h}}",
            expectedStatus: 200,
            assertResponse: (status, body) => {
              if (status !== 200) {
                return `expected 200, saw ${status}`;
              }
              const record = body as { success?: boolean; workflowRuns?: unknown[] };
              if (record.success !== true) {
                return "expected success=true";
              }
              if (!Array.isArray(record.workflowRuns) || record.workflowRuns.length !== 1) {
                return "expected one workflow run";
              }
              return undefined;
            },
          },
        ],
      },
      runtime,
      {
        providerName: "test",
        minJudgeScore: 0.8,
        turnTimeoutMs: 5_000,
      },
    );

    expect(report.status).toBe("passed");
    expect(seedTimes).toHaveLength(1);
    expect(apiCalls).toHaveLength(1);
    expect(tickCalls).toHaveLength(1);

    const seedNow = new Date(seedTimes[0]!);
    expect(apiCalls[0]?.path).toContain(seedNow.toISOString());
    expect(apiCalls[0]?.body).toMatchObject({
      schedule: {
        dueAt: new Date(seedNow.getTime() + 10 * 60_000).toISOString(),
      },
    });
    expect(tickCalls[0]?.now).toBe(
      new Date(seedNow.getTime() + 60 * 60_000).toISOString(),
    );
  });
});
