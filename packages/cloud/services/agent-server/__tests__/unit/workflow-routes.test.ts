/** Exercises native Smithers workflow Cloud routes with authenticated, tenant-owned definitions and runs. */
import { describe, expect, mock, test } from "bun:test";
import type { AgentManager } from "../../src/agent-manager";
import { createRoutes } from "../../src/routes";

const SECRET = "workflow-test-secret";
const AGENT_ID = "agent-1";

function definition(id = "owned-workflow") {
  const now = "2026-08-12T12:00:00.000Z";
  return {
    id,
    name: "Smithers workflow",
    description: "Native Cloud workflow",
    source:
      'import { createSmithers } from "smthrs/create"; export default createSmithers({}).smithers(() => null);',
    language: "tsx" as const,
    active: false,
    steps: [{ id: "run", label: "Run", kind: "task" }],
    widgets: [],
    versionId: "v1",
    createdAt: now,
    updatedAt: now,
  };
}

function createHarness() {
  const workflows = new Map([["owned-workflow", definition()]]);
  const executions = new Map<string, Record<string, unknown>>();
  const service = {
    listWorkflows: mock(async (userId: string) =>
      userId === "owner" ? [...workflows.values()] : [],
    ),
    getWorkflow: mock(async (id: string) => workflows.get(id)),
    deployWorkflow: mock(
      async (draft: ReturnType<typeof definition>, userId: string) => {
        const saved = {
          ...draft,
          id: draft.id || "created-workflow",
          active: false,
        };
        if (userId === "owner") workflows.set(saved.id, saved);
        return saved;
      },
    ),
    generateWorkflowDraft: mock(async () => ({
      ...definition(""),
      id: undefined,
    })),
    activateWorkflow: mock(async () => undefined),
    deactivateWorkflow: mock(async () => undefined),
    deleteWorkflow: mock(async (id: string) => {
      workflows.delete(id);
    }),
    startWorkflow: mock(async (id: string) => {
      const run = {
        id: "run-1",
        workflowId: id,
        status: "queued",
        finished: false,
      };
      executions.set("run-1", run);
      return run;
    }),
    listExecutions: mock(async ({ workflowId }: { workflowId?: string }) => ({
      data: [...executions.values()].filter(
        (run) => run.workflowId === workflowId,
      ),
    })),
    getExecutionDetail: mock(async (id: string) => executions.get(id)),
    cancelExecution: mock(async (id: string) => ({
      ...executions.get(id),
      status: "cancelled",
    })),
    decideApproval: mock(
      async (
        id: string,
        nodeId: string,
        iteration: number,
        approved: boolean,
      ) => ({
        ...executions.get(id),
        approval: { nodeId, iteration, approved },
      }),
    ),
    signalExecution: mock(
      async (id: string, signal: string, payload: unknown) => ({
        ...executions.get(id),
        signal: { signal, payload },
      }),
    ),
    getWorkflowRevisions: mock(async () => []),
    restoreWorkflowRevision: mock(async () => definition()),
    getWorkflowEvaluationSuite: mock(async () => ({ samples: [] })),
  };
  const useRuntime = mock(
    async (
      _id: string,
      callback: (runtime: { getService: () => unknown }) => Promise<unknown>,
    ) => callback({ getService: () => service }),
  );
  const manager = {
    useRuntime,
    isDraining: () => false,
  } as unknown as AgentManager;
  return { app: createRoutes(manager, SECRET), service, useRuntime };
}

function request(
  app: ReturnType<typeof createRoutes>,
  path: string,
  options: { method?: string; userId?: string; body?: unknown } = {},
) {
  const headers = new Headers({ "x-server-token": SECRET });
  if (options.userId) headers.set("x-eliza-user-id", options.userId);
  if (options.body !== undefined)
    headers.set("content-type", "application/json");
  return app.handle(
    new Request(`http://test/agents/${AGENT_ID}/workflows${path}`, {
      method: options.method ?? "GET",
      headers,
      body:
        options.body === undefined ? undefined : JSON.stringify(options.body),
    }),
  );
}

describe("native Smithers Cloud workflow routes", () => {
  test("requires the forwarded Cloud principal", async () => {
    const { app, useRuntime } = createHarness();
    const response = await request(app, "");
    expect(response.status).toBe(401);
    expect(useRuntime).not.toHaveBeenCalled();
  });

  test("generates native source without deploying a clarification draft", async () => {
    const { app, service } = createHarness();
    const response = await request(app, "/generate", {
      method: "POST",
      userId: "owner",
      body: { prompt: "Build a digest" },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      workflow: { language: "tsx", active: false },
    });
    expect(service.deployWorkflow).not.toHaveBeenCalled();
  });

  test("starts and administers an owned run", async () => {
    const { app, service } = createHarness();
    const started = await request(app, "/owned-workflow/run", {
      method: "POST",
      userId: "owner",
      body: { input: { topic: "AI" } },
    });
    expect(started.status).toBe(202);
    expect(await started.json()).toMatchObject({
      execution: { id: "run-1", status: "queued" },
    });

    const approved = await request(
      app,
      "/executions/run-1/approvals/review/0",
      { method: "POST", userId: "owner", body: { approved: true } },
    );
    expect(approved.status).toBe(200);
    expect(service.decideApproval).toHaveBeenCalled();

    const signaled = await request(app, "/executions/run-1/signals/continue", {
      method: "POST",
      userId: "owner",
      body: { payload: { ok: true } },
    });
    expect(signaled.status).toBe(200);
    expect(service.signalExecution).toHaveBeenCalled();
  });

  test("does not expose another principal's definitions", async () => {
    const { app } = createHarness();
    const owner = await request(app, "", { userId: "owner" });
    const attacker = await request(app, "", { userId: "attacker" });
    expect((await owner.json()).workflows).toHaveLength(1);
    expect((await attacker.json()).workflows).toHaveLength(0);
  });
});
