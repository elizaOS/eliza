/**
 * Exercises the hosted workflow HTTP boundary with adversarial user identities.
 * The runtime and workflow service are deterministic in-memory collaborators.
 */
import { describe, expect, mock, test } from "bun:test";
import type { AgentManager } from "../../src/agent-manager";
import { createRoutes } from "../../src/routes";

const SHARED_SECRET = "workflow-test-secret";
const AGENT_ID = "agent-1";

type WorkflowInput = {
  id?: string;
  name: string;
  nodes: unknown[];
  connections: Record<string, unknown>;
};

function workflow(id?: string): WorkflowInput {
  return {
    ...(id ? { id } : {}),
    name: id ? `Workflow ${id}` : "New workflow",
    nodes: [],
    connections: {},
  };
}

function createWorkflowService(
  initialOwnership: Record<string, string[]> = {},
  options: {
    persistDeployOwnership?: boolean;
    omitDeployId?: boolean;
    executionWorkflowIds?: Record<string, string>;
    inactiveWorkflowIds?: string[];
    generatedDraft?: WorkflowInput & { _meta?: Record<string, unknown> };
  } = {},
) {
  const persistDeployOwnership = options.persistDeployOwnership ?? true;
  const ownedByUser = new Map<string, Array<Record<string, unknown>>>(
    Object.entries(initialOwnership).map(([userId, ids]) => [
      userId,
      ids.map((id) => ({ ...workflow(id), id })),
    ]),
  );
  let createdCount = 0;
  let executionCount = 0;
  const executionWorkflowIds = new Map(
    Object.entries(options.executionWorkflowIds ?? {}),
  );
  const inactiveWorkflowIds = new Set(options.inactiveWorkflowIds ?? []);
  const activeById = new Map<string, boolean>();
  const definitionById = new Map<string, WorkflowInput>();
  for (const ids of Object.values(initialOwnership)) {
    for (const id of ids) {
      activeById.set(id, !inactiveWorkflowIds.has(id));
      definitionById.set(id, workflow(id));
    }
  }

  const listWorkflows = mock(async (userId: string) => [
    ...(ownedByUser.get(userId) ?? []),
  ]);
  const getWorkflow = mock(async (workflowId: string, _userId: string) => ({
    ...(definitionById.get(workflowId) ?? workflow(workflowId)),
    id: workflowId,
    active: activeById.get(workflowId) ?? false,
    versionId: "current-version",
  }));
  const deployWorkflow = mock(
    async (
      definition: WorkflowInput,
      userId: string,
      deployOptions?: { activate?: boolean },
    ) => {
      const id = definition.id ?? `created-${++createdCount}`;
      const previousActive = definition.id
        ? (activeById.get(id) ?? false)
        : false;
      if (persistDeployOwnership) {
        const owned = ownedByUser.get(userId) ?? [];
        if (!owned.some((candidate) => candidate.id === id)) {
          ownedByUser.set(userId, [...owned, { ...definition, id }]);
        }
      }
      definitionById.set(id, { ...definition, id });
      const active = deployOptions?.activate ?? previousActive;
      activeById.set(id, active);
      if (options.omitDeployId) {
        return { name: definition.name, active };
      }
      return { id, name: definition.name, active };
    },
  );
  const generateWorkflowDraft = mock(
    async (_prompt: string, _opts?: { userId?: string }) =>
      options.generatedDraft ?? workflow(),
  );
  const activateWorkflow = mock(async (workflowId: string, _userId: string) => {
    activeById.set(workflowId, true);
  });
  const deactivateWorkflow = mock(
    async (workflowId: string, _userId: string) => {
      activeById.set(workflowId, false);
    },
  );
  const deleteWorkflow = mock(async (workflowId: string, _userId: string) => {
    activeById.delete(workflowId);
    definitionById.delete(workflowId);
    for (const [userId, workflows] of ownedByUser) {
      ownedByUser.set(
        userId,
        workflows.filter((candidate) => candidate.id !== workflowId),
      );
    }
  });
  const runWorkflow = mock(
    async (
      workflowId: string,
      _options: { mode?: "manual"; throwOnError?: boolean } | undefined,
      _userId: string,
    ) => {
      const id = `execution-${++executionCount}`;
      executionWorkflowIds.set(id, workflowId);
      return { id, workflowId, status: "success", finished: true };
    },
  );
  const listExecutions = mock(
    async (
      params: { workflowId?: string; limit?: number },
      _userId: string,
    ) => ({
      data: [...executionWorkflowIds]
        .filter(([, workflowId]) => workflowId === params?.workflowId)
        .slice(0, params?.limit)
        .map(([id, workflowId]) => ({
          id,
          workflowId,
          status: "success",
          finished: true,
        })),
    }),
  );
  const getExecutionDetail = mock(
    async (executionId: string, _userId: string) => {
      const workflowId = executionWorkflowIds.get(executionId);
      if (!workflowId) {
        throw Object.assign(new Error(`Execution not found: ${executionId}`), {
          statusCode: 404,
        });
      }
      return { id: executionId, workflowId, status: "success", finished: true };
    },
  );
  const listWorkflowRevisions = mock(
    async (workflowId: string, limit: number | undefined, _userId: string) =>
      [
        {
          id: "revision-1",
          workflowId,
          versionId: "version-1",
          operation: "update",
        },
      ].slice(0, limit),
  );
  const restoreWorkflowRevision = mock(
    async (workflowId: string, versionId: string, _userId: string) => {
      if (versionId === "missing-version") {
        throw Object.assign(
          new Error(`Workflow revision not found: ${workflowId}/${versionId}`),
          { statusCode: 404 },
        );
      }
      return {
        ...workflow(workflowId),
        id: workflowId,
        active: true,
        versionId,
      };
    },
  );
  const getWorkflowEvaluationSuite = mock(
    async (workflowId: string, limit: number | undefined, _userId: string) => ({
      workflowId,
      workflowName: `Workflow ${workflowId}`,
      generatedAt: "2026-07-17T12:00:00.000Z",
      sampleCount: Math.min(limit ?? 10, 1),
      samples: [],
      jsonl: "",
      optimizer: { engine: "smithers-gepa" },
    }),
  );

  return {
    listWorkflows,
    getWorkflow,
    deployWorkflow,
    generateWorkflowDraft,
    activateWorkflow,
    deactivateWorkflow,
    deleteWorkflow,
    runWorkflow,
    listExecutions,
    getExecutionDetail,
    listWorkflowRevisions,
    restoreWorkflowRevision,
    getWorkflowEvaluationSuite,
  };
}

function createHarness(
  service = createWorkflowService(),
  catalog?: {
    listGroups: (opts?: { platform?: string }) => Promise<unknown[]>;
  },
) {
  const useRuntime = mock(
    async (
      _agentId: string,
      callback: (runtime: {
        getService: (serviceType: string) => unknown;
      }) => Promise<unknown>,
    ) =>
      callback({
        getService: (serviceType: string) => {
          if (serviceType === "workflow") return service;
          if (serviceType === "connector_target_catalog") return catalog;
          return null;
        },
      }),
  );
  const manager = {
    useRuntime,
    isDraining: () => false,
  } as unknown as AgentManager;
  return { app: createRoutes(manager, SHARED_SECRET), service, useRuntime };
}

async function requestWorkflow(
  app: ReturnType<typeof createRoutes>,
  path: string,
  options: {
    method?: "GET" | "POST" | "PUT" | "DELETE";
    userId?: string;
    body?: unknown;
  } = {},
): Promise<Response> {
  const headers = new Headers({ "x-server-token": SHARED_SECRET });
  if (options.userId) headers.set("x-eliza-user-id", options.userId);
  if (options.body !== undefined)
    headers.set("content-type", "application/json");
  return app.handle(
    new Request(
      `http://agent-server.test/agents/${AGENT_ID}/workflows${path}`,
      {
        method: options.method ?? "GET",
        headers,
        body:
          options.body === undefined ? undefined : JSON.stringify(options.body),
      },
    ),
  );
}

function callsOf(mockFunction: {
  mock: { calls: readonly unknown[] };
}): unknown[][] {
  return mockFunction.mock.calls as unknown as unknown[][];
}

describe("workflow route principals", () => {
  test("uses the trusted forwarded principal instead of a body userId", async () => {
    const { app, service } = createHarness();
    const response = await requestWorkflow(app, "", {
      method: "POST",
      userId: "header-user",
      body: {
        userId: "spoofed-user",
        workflow: workflow(),
      },
    });

    expect(response.status).toBe(200);
    expect(callsOf(service.deployWorkflow)[0]?.[1]).toBe("header-user");
    expect(callsOf(service.listWorkflows).map((call) => call[0])).not.toContain(
      "spoofed-user",
    );
  });

  test("uses the trusted principal for generated workflows", async () => {
    const { app, service } = createHarness();
    const response = await requestWorkflow(app, "/generate", {
      method: "POST",
      userId: "header-user",
      body: { prompt: "Send a daily recap", userId: "spoofed-user" },
    });

    expect(response.status).toBe(200);
    expect(callsOf(service.generateWorkflowDraft)[0]?.[1]).toEqual({
      userId: "header-user",
    });
    expect(callsOf(service.deployWorkflow)[0]?.[1]).toBe("header-user");
  });

  test("rejects a missing forwarded principal even when the body supplies one", async () => {
    const { app, useRuntime } = createHarness();
    const response = await requestWorkflow(app, "", {
      method: "POST",
      body: { userId: "body-user", workflow: workflow() },
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      success: false,
      code: "workflow_principal_required",
      error: "Workflow user principal is required",
    });
    expect(useRuntime).not.toHaveBeenCalled();
  });
});

describe("workflow route ownership", () => {
  test("does not reveal or read another user's workflow", async () => {
    const { app, service } = createHarness(
      createWorkflowService({
        caller: ["owned-workflow"],
        victim: ["victim-workflow"],
      }),
    );

    const foreign = await requestWorkflow(app, "/victim-workflow", {
      userId: "caller",
    });
    const missing = await requestWorkflow(app, "/missing-workflow", {
      userId: "caller",
    });

    expect(foreign.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(await foreign.json()).toEqual(await missing.json());
    expect(
      await requestWorkflow(app, "/owned-workflow", { userId: "caller" }).then(
        (response) => response.status,
      ),
    ).toBe(200);
    expect(service.getWorkflow).toHaveBeenCalledWith(
      "owned-workflow",
      "caller",
    );
    expect(callsOf(service.getWorkflow).map((call) => call[0])).not.toContain(
      "victim-workflow",
    );
  });

  test("denies every mutating operation on a foreign workflow", async () => {
    const { app, service } = createHarness(
      createWorkflowService({ victim: ["victim-workflow"] }),
    );
    const attempts = [
      { method: "PUT" as const, path: "/victim-workflow", body: workflow() },
      { method: "DELETE" as const, path: "/victim-workflow" },
      { method: "POST" as const, path: "/victim-workflow/activate" },
      { method: "POST" as const, path: "/victim-workflow/deactivate" },
    ];

    for (const attempt of attempts) {
      const response = await requestWorkflow(app, attempt.path, {
        method: attempt.method,
        userId: "attacker",
        body: attempt.body,
      });
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({
        success: false,
        code: "workflow_not_found",
      });
    }

    expect(service.deployWorkflow).not.toHaveBeenCalled();
    expect(service.deleteWorkflow).not.toHaveBeenCalled();
    expect(service.activateWorkflow).not.toHaveBeenCalled();
    expect(service.deactivateWorkflow).not.toHaveBeenCalled();
  });

  test("denies foreign IDs supplied through create and generate bodies", async () => {
    const { app, service } = createHarness(
      createWorkflowService({ victim: ["victim-workflow"] }),
    );
    const createResponse = await requestWorkflow(app, "", {
      method: "POST",
      userId: "attacker",
      body: { workflow: workflow("victim-workflow") },
    });
    const generateResponse = await requestWorkflow(app, "/generate", {
      method: "POST",
      userId: "attacker",
      body: { prompt: "Change it", workflowId: "victim-workflow" },
    });

    expect(createResponse.status).toBe(404);
    expect(generateResponse.status).toBe(404);
    expect(service.deployWorkflow).not.toHaveBeenCalled();
    expect(service.generateWorkflowDraft).not.toHaveBeenCalled();
  });

  test("fails closed when a newly deployed workflow has no persisted owner", async () => {
    const { app, service } = createHarness(
      createWorkflowService(
        {},
        {
          persistDeployOwnership: false,
        },
      ),
    );
    const response = await requestWorkflow(app, "", {
      method: "POST",
      userId: "caller",
      body: { workflow: workflow() },
    });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      success: false,
      code: "workflow_ownership_not_persisted",
      error: "Workflow ownership could not be persisted",
    });
    expect(service.getWorkflow).not.toHaveBeenCalled();
    expect(service.deleteWorkflow).toHaveBeenCalledWith("created-1", "caller");
  });

  test("allows an owner to update, activate, and delete their workflow", async () => {
    const { app, service } = createHarness(
      createWorkflowService({ caller: ["owned-workflow"] }),
    );
    const update = await requestWorkflow(app, "/owned-workflow", {
      method: "PUT",
      userId: "caller",
      body: { workflow: workflow() },
    });
    const activate = await requestWorkflow(app, "/owned-workflow/activate", {
      method: "POST",
      userId: "caller",
    });
    const remove = await requestWorkflow(app, "/owned-workflow", {
      method: "DELETE",
      userId: "caller",
    });

    expect(update.status).toBe(200);
    expect(activate.status).toBe(200);
    expect(remove.status).toBe(200);
    expect(service.deployWorkflow).toHaveBeenCalledTimes(1);
    expect(service.activateWorkflow).toHaveBeenCalledWith(
      "owned-workflow",
      "caller",
    );
    expect(service.deleteWorkflow).toHaveBeenCalledWith(
      "owned-workflow",
      "caller",
    );
  });
});

describe("workflow activation contracts", () => {
  test("saves a new workflow inactive unless activation is explicitly requested", async () => {
    const { app, service } = createHarness();

    const saved = await requestWorkflow(app, "", {
      method: "POST",
      userId: "caller",
      body: { workflow: workflow() },
    });
    const activated = await requestWorkflow(app, "", {
      method: "POST",
      userId: "caller",
      body: { workflow: workflow(), activate: true },
    });

    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({
      id: "created-1",
      active: false,
    });
    expect(activated.status).toBe(200);
    expect(await activated.json()).toMatchObject({
      id: "created-2",
      active: true,
    });
    expect(callsOf(service.deployWorkflow)[0]?.[2]).toEqual({
      activate: undefined,
    });
    expect(callsOf(service.deployWorkflow)[1]?.[2]).toEqual({
      activate: true,
    });
    expect(service.deactivateWorkflow).not.toHaveBeenCalled();
    expect(service.activateWorkflow).not.toHaveBeenCalled();
  });

  test("preserves inactive and active state when updates omit a lifecycle instruction", async () => {
    const { app, service } = createHarness(
      createWorkflowService(
        { caller: ["inactive-workflow", "active-workflow"] },
        { inactiveWorkflowIds: ["inactive-workflow"] },
      ),
    );

    const inactive = await requestWorkflow(app, "/inactive-workflow", {
      method: "PUT",
      userId: "caller",
      body: { workflow: workflow() },
    });
    const active = await requestWorkflow(app, "/active-workflow", {
      method: "PUT",
      userId: "caller",
      body: { workflow: workflow() },
    });

    expect(inactive.status).toBe(200);
    expect(await inactive.json()).toMatchObject({ active: false });
    expect(active.status).toBe(200);
    expect(await active.json()).toMatchObject({ active: true });
    expect(callsOf(service.deployWorkflow)[0]?.[2]).toEqual({
      activate: undefined,
    });
    expect(callsOf(service.deployWorkflow)[1]?.[2]).toEqual({
      activate: undefined,
    });
    expect(service.deactivateWorkflow).not.toHaveBeenCalled();
    expect(service.activateWorkflow).not.toHaveBeenCalled();
  });

  test("threads explicit update lifecycle instructions to the workflow service", async () => {
    const { app, service } = createHarness(
      createWorkflowService(
        { caller: ["inactive-workflow", "active-workflow"] },
        { inactiveWorkflowIds: ["inactive-workflow"] },
      ),
    );

    const activated = await requestWorkflow(app, "/inactive-workflow", {
      method: "PUT",
      userId: "caller",
      body: { workflow: workflow(), activate: true },
    });
    const deactivated = await requestWorkflow(app, "/active-workflow", {
      method: "PUT",
      userId: "caller",
      body: { workflow: workflow(), activate: false },
    });

    expect(await activated.json()).toMatchObject({ active: true });
    expect(await deactivated.json()).toMatchObject({ active: false });
    expect(callsOf(service.deployWorkflow)[0]?.[2]).toEqual({
      activate: true,
    });
    expect(callsOf(service.deployWorkflow)[1]?.[2]).toEqual({
      activate: false,
    });
    expect(service.activateWorkflow).not.toHaveBeenCalled();
    expect(service.deactivateWorkflow).not.toHaveBeenCalled();
  });

  test("generates inactive by default and preserves an existing workflow's state", async () => {
    const { app, service } = createHarness(
      createWorkflowService(
        { caller: ["inactive-workflow"] },
        { inactiveWorkflowIds: ["inactive-workflow"] },
      ),
    );

    const created = await requestWorkflow(app, "/generate", {
      method: "POST",
      userId: "caller",
      body: { prompt: "Send a daily recap" },
    });
    const updated = await requestWorkflow(app, "/generate", {
      method: "POST",
      userId: "caller",
      body: {
        prompt: "Change the recap",
        workflowId: "inactive-workflow",
      },
    });

    expect(created.status).toBe(200);
    expect(await created.json()).toMatchObject({ active: false });
    expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({
      id: "inactive-workflow",
      active: false,
    });
    expect(callsOf(service.deployWorkflow)[0]?.[2]).toEqual({
      activate: undefined,
    });
    expect(callsOf(service.deployWorkflow)[1]?.[2]).toEqual({
      activate: undefined,
    });
    expect(service.deactivateWorkflow).not.toHaveBeenCalled();
    expect(service.activateWorkflow).not.toHaveBeenCalled();
  });

  test("fails observably when deployment returns no verifiable workflow id", async () => {
    const { app, service } = createHarness(
      createWorkflowService({}, { omitDeployId: true }),
    );

    const response = await requestWorkflow(app, "", {
      method: "POST",
      userId: "caller",
      body: { workflow: workflow() },
    });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      success: false,
      code: "workflow_deployment_id_missing",
      error: "Workflow deployment returned no verifiable workflow id",
    });
    expect(service.deployWorkflow).toHaveBeenCalledTimes(1);
    expect(service.listWorkflows).not.toHaveBeenCalled();
    expect(service.getWorkflow).not.toHaveBeenCalled();
  });
});

describe("workflow clarification contracts", () => {
  const clarificationDraft = {
    ...workflow(),
    nodes: [
      {
        id: "send",
        name: "Send",
        type: "workflows-nodes-base.set",
        parameters: {},
      },
    ],
    _meta: {
      requiresClarification: [
        {
          kind: "value",
          question: "Which value?",
          paramPath: "nodes[0].parameters.value",
        },
      ],
    },
  };

  test("applies the UI clarification payload and deploys the new workflow inactive", async () => {
    const { app, service } = createHarness();
    const response = await requestWorkflow(app, "/resolve-clarification", {
      method: "POST",
      userId: "caller",
      body: {
        draft: structuredClone(clarificationDraft),
        resolutions: [
          { paramPath: "nodes[0].parameters.value", value: "approved" },
        ],
        name: "Resolved workflow",
      },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      id: "created-1",
      name: "Resolved workflow",
      active: false,
    });
    const deployed = callsOf(service.deployWorkflow)[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(deployed.name).toBe("Resolved workflow");
    expect(deployed).not.toHaveProperty("_meta.requiresClarification");
    expect(deployed).toHaveProperty("nodes.0.parameters.value", "approved");
    expect(callsOf(service.deployWorkflow)[0]?.[1]).toBe("caller");
    expect(callsOf(service.deployWorkflow)[0]?.[2]).toEqual({
      activate: undefined,
    });
    expect(service.deactivateWorkflow).not.toHaveBeenCalled();
  });

  test("returns remaining clarifications and the scoped connector catalog without deploying", async () => {
    const draft = structuredClone(clarificationDraft);
    draft._meta.requiresClarification.push({
      kind: "target_channel",
      platform: "discord",
      question: "Which channel?",
      paramPath: "nodes[0].parameters.channelId",
    });
    const service = createWorkflowService();
    const catalog = {
      listGroups: mock(async (opts?: { platform?: string }) => [
        {
          platform: opts?.platform ?? "unknown",
          groupId: "guild-1",
          groupName: "Guild",
          targets: [],
        },
      ]),
    };
    const { app } = createHarness(service, catalog);

    const response = await requestWorkflow(app, "/resolve-clarification", {
      method: "POST",
      userId: "caller",
      body: {
        draft,
        resolutions: [
          { paramPath: "nodes[0].parameters.value", value: "approved" },
        ],
      },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: "needs_clarification",
      clarifications: [{ platform: "discord" }],
      catalog: [{ platform: "discord", groupId: "guild-1" }],
    });
    expect(service.deployWorkflow).not.toHaveBeenCalled();
    expect(catalog.listGroups).toHaveBeenCalledWith({ platform: "discord" });
  });

  test("records and prunes a free-form clarification before deployment", async () => {
    const { app, service } = createHarness();
    const response = await requestWorkflow(app, "/resolve-clarification", {
      method: "POST",
      userId: "caller",
      body: {
        draft: {
          ...workflow(),
          _meta: { requiresClarification: ["Describe the value"] },
        },
        resolutions: [{ paramPath: "", value: "Use the approved value" }],
      },
    });

    expect(response.status).toBe(200);
    const deployed = callsOf(service.deployWorkflow)[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(deployed).not.toHaveProperty("_meta.requiresClarification");
    expect(deployed).toHaveProperty("_meta.userNotes", [
      "Use the approved value",
    ]);
  });

  test("rejects malformed and mismatched clarification requests before deployment", async () => {
    const { app, service } = createHarness();
    const malformed = await requestWorkflow(app, "/resolve-clarification", {
      method: "POST",
      userId: "caller",
      body: { draft: workflow() },
    });
    const mismatched = await requestWorkflow(app, "/resolve-clarification", {
      method: "POST",
      userId: "caller",
      body: {
        draft: { ...workflow("draft-id"), id: "draft-id" },
        workflowId: "body-id",
        resolutions: [],
      },
    });

    expect(malformed.status).toBe(400);
    expect(mismatched.status).toBe(400);
    expect(await mismatched.json()).toEqual({
      error: "workflowId does not match draft id",
    });
    expect(service.deployWorkflow).not.toHaveBeenCalled();
  });

  test("does not reveal whether a clarification target is foreign or missing", async () => {
    const { app, service } = createHarness(
      createWorkflowService({ victim: ["victim-workflow"] }),
    );
    const attempt = (workflowId: string) =>
      requestWorkflow(app, "/resolve-clarification", {
        method: "POST",
        userId: "attacker",
        body: {
          draft: { ...structuredClone(clarificationDraft), id: workflowId },
          workflowId,
          resolutions: [
            { paramPath: "nodes[0].parameters.value", value: "stolen" },
          ],
        },
      });

    const foreign = await attempt("victim-workflow");
    const missing = await attempt("missing-workflow");

    expect(foreign.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(await foreign.json()).toEqual(await missing.json());
    expect(service.deployWorkflow).not.toHaveBeenCalled();
  });

  test("requires the trusted forwarded principal", async () => {
    const { app, useRuntime } = createHarness();
    const response = await requestWorkflow(app, "/resolve-clarification", {
      method: "POST",
      body: {
        userId: "spoofed-user",
        draft: structuredClone(clarificationDraft),
        resolutions: [],
      },
    });

    expect(response.status).toBe(401);
    expect(useRuntime).not.toHaveBeenCalled();
  });
});

describe("workflow run and history ownership", () => {
  test("allows an owner to run and inspect executions and revisions", async () => {
    const { app, service } = createHarness(
      createWorkflowService(
        { caller: ["owned-workflow"] },
        {
          executionWorkflowIds: {
            "owned-execution": "owned-workflow",
          },
        },
      ),
    );

    const run = await requestWorkflow(app, "/owned-workflow/run", {
      method: "POST",
      userId: "caller",
    });
    const executions = await requestWorkflow(
      app,
      "/owned-workflow/executions?limit=999",
      { userId: "caller" },
    );
    const execution = await requestWorkflow(
      app,
      "/executions/owned-execution",
      {
        userId: "caller",
      },
    );
    const revisions = await requestWorkflow(
      app,
      "/owned-workflow/revisions?limit=999",
      { userId: "caller" },
    );
    const restore = await requestWorkflow(
      app,
      "/owned-workflow/revisions/version-1/restore",
      { method: "POST", userId: "caller" },
    );

    expect(run.status).toBe(200);
    expect(executions.status).toBe(200);
    expect(execution.status).toBe(200);
    expect(revisions.status).toBe(200);
    expect(restore.status).toBe(200);
    expect(service.runWorkflow).toHaveBeenCalledWith(
      "owned-workflow",
      {
        mode: "manual",
        throwOnError: false,
      },
      "caller",
    );
    expect(service.listExecutions).toHaveBeenCalledWith(
      {
        workflowId: "owned-workflow",
        limit: 50,
      },
      "caller",
    );
    expect(service.getExecutionDetail).toHaveBeenCalledWith(
      "owned-execution",
      "caller",
    );
    expect(service.listWorkflowRevisions).toHaveBeenCalledWith(
      "owned-workflow",
      50,
      "caller",
    );
    expect(service.restoreWorkflowRevision).toHaveBeenCalledWith(
      "owned-workflow",
      "version-1",
      "caller",
    );
  });

  test("denies run and workflow-scoped history for a foreign workflow", async () => {
    const { app, service } = createHarness(
      createWorkflowService({ victim: ["victim-workflow"] }),
    );
    const attempts = [
      { method: "POST" as const, path: "/victim-workflow/run" },
      { method: "GET" as const, path: "/victim-workflow/executions" },
      { method: "GET" as const, path: "/victim-workflow/revisions" },
      {
        method: "POST" as const,
        path: "/victim-workflow/revisions/version-1/restore",
      },
    ];

    for (const attempt of attempts) {
      const response = await requestWorkflow(app, attempt.path, {
        method: attempt.method,
        userId: "attacker",
      });
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({
        success: false,
        code: "workflow_not_found",
        error: "Workflow not found",
      });
    }

    expect(service.runWorkflow).not.toHaveBeenCalled();
    expect(service.listExecutions).not.toHaveBeenCalled();
    expect(service.listWorkflowRevisions).not.toHaveBeenCalled();
    expect(service.restoreWorkflowRevision).not.toHaveBeenCalled();
  });

  test("does not reveal whether an execution is missing or belongs to another user", async () => {
    const { app } = createHarness(
      createWorkflowService(
        { victim: ["victim-workflow"] },
        {
          executionWorkflowIds: {
            "victim-execution": "victim-workflow",
          },
        },
      ),
    );

    const foreign = await requestWorkflow(app, "/executions/victim-execution", {
      userId: "attacker",
    });
    const missing = await requestWorkflow(
      app,
      "/executions/missing-execution",
      {
        userId: "attacker",
      },
    );

    expect(foreign.status).toBe(404);
    expect(missing.status).toBe(404);
    const foreignBody = await foreign.json();
    const missingBody = await missing.json();
    expect(foreignBody).toEqual(missingBody);
    expect(foreignBody).not.toHaveProperty("workflowId");
  });

  test("returns a typed missing revision without invoking a restore fallback", async () => {
    const { app } = createHarness(
      createWorkflowService({ caller: ["owned-workflow"] }),
    );
    const response = await requestWorkflow(
      app,
      "/owned-workflow/revisions/missing-version/restore",
      { method: "POST", userId: "caller" },
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      success: false,
      code: "workflow_revision_not_found",
      error: "Workflow revision not found",
    });
  });
});

describe("workflow evaluation sample ownership", () => {
  test("returns the owned workflow suite with a bounded limit", async () => {
    const { app, service } = createHarness(
      createWorkflowService({ caller: ["owned-workflow"] }),
    );

    const response = await requestWorkflow(
      app,
      "/owned-workflow/evaluation-samples?limit=999",
      { userId: "caller" },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      workflowId: "owned-workflow",
      optimizer: { engine: "smithers-gepa" },
    });
    expect(service.getWorkflowEvaluationSuite).toHaveBeenCalledWith(
      "owned-workflow",
      50,
      "caller",
    );
  });

  test("does not reveal whether an evaluation suite target is foreign or missing", async () => {
    const { app, service } = createHarness(
      createWorkflowService({ victim: ["victim-workflow"] }),
    );

    const foreign = await requestWorkflow(
      app,
      "/victim-workflow/evaluation-samples",
      { userId: "attacker" },
    );
    const missing = await requestWorkflow(
      app,
      "/missing-workflow/evaluation-samples",
      { userId: "attacker" },
    );

    expect(foreign.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(await foreign.json()).toEqual(await missing.json());
    expect(service.getWorkflowEvaluationSuite).not.toHaveBeenCalled();
  });

  test("requires the trusted forwarded principal", async () => {
    const { app, useRuntime } = createHarness();
    const response = await requestWorkflow(
      app,
      "/owned-workflow/evaluation-samples",
    );

    expect(response.status).toBe(401);
    expect(useRuntime).not.toHaveBeenCalled();
  });
});
