import { describe, test, expect, mock } from "bun:test";
import { workflowRoutes } from "../../../src/routes/workflows";
import { createMockRuntime } from "../../helpers/mockRuntime";
import { createMockService } from "../../helpers/mockService";
import {
  createValidWorkflow,
  createWorkflowResponse,
} from "../../fixtures/workflows";
import type { RouteRequest, RouteResponse } from "@elizaos/core";

function createRouteRequest(overrides?: Partial<RouteRequest>): RouteRequest {
  return {
    body: undefined,
    params: {},
    query: {},
    headers: {},
    method: "GET",
    ...overrides,
  };
}

function createRouteResponse(): {
  res: RouteResponse;
  getResult: () => { status: number; body: unknown };
} {
  let status = 200;
  let body: unknown;
  const res: RouteResponse = {
    status(code: number) {
      status = code;
      return res;
    },
    json(data: unknown) {
      body = data;
      return res;
    },
    send(data: unknown) {
      body = data;
      return res;
    },
    end() {
      return res;
    },
  };
  return { res, getResult: () => ({ status, body }) };
}

// Routes: [0]=GET /workflows, [1]=POST /workflows, [2]=GET /workflows/:id,
//         [3]=PUT /workflows/:id, [4]=DELETE /workflows/:id,
//         [5]=POST /workflows/:id/activate, [6]=POST /workflows/:id/deactivate
const listHandler = workflowRoutes[0].handler!;
const createHandler = workflowRoutes[1].handler!;
const getHandler = workflowRoutes[2].handler!;
const updateHandler = workflowRoutes[3].handler!;
const deleteHandler = workflowRoutes[4].handler!;
const activateHandler = workflowRoutes[5].handler!;
const deactivateHandler = workflowRoutes[6].handler!;

function runtimeWithService(serviceOverrides?: Record<string, unknown>) {
  const service = createMockService(serviceOverrides);
  return {
    runtime: createMockRuntime({ services: { workflow: service } }),
    service,
  };
}

describe("GET /workflows", () => {
  test("returns list of workflows", async () => {
    const { runtime } = runtimeWithService();
    const req = createRouteRequest();
    const { res, getResult } = createRouteResponse();

    await listHandler(req, res, runtime);

    const { body } = getResult();
    const data = body as { success: boolean; data: Array<{ id: string }> };
    expect(data.success).toBe(true);
    expect(data.data.length).toBe(2);
    expect(data.data[0].id).toBe("wf-001");
  });

  test("passes userId query param to service", async () => {
    const { runtime, service } = runtimeWithService();
    const req = createRouteRequest({ query: { userId: "user-42" } });
    const { res } = createRouteResponse();

    await listHandler(req, res, runtime);

    expect(
      (service.listWorkflows as ReturnType<typeof mock>).mock.calls[0][0],
    ).toBe("user-42");
  });
});

describe("POST /workflows", () => {
  test("creates workflow and returns result", async () => {
    const { runtime } = runtimeWithService();
    const workflow = createValidWorkflow();
    const req = createRouteRequest({
      body: { workflow, userId: "user-1" },
      method: "POST",
    });
    const { res, getResult } = createRouteResponse();

    await createHandler(req, res, runtime);

    const { body } = getResult();
    const data = body as { success: boolean; data: { id: string } };
    expect(data.success).toBe(true);
    expect(data.data.id).toBe("wf-001");
  });

  test("returns 400 when workflow is missing", async () => {
    const { runtime } = runtimeWithService();
    const req = createRouteRequest({
      body: { userId: "user-1" },
      method: "POST",
    });
    const { res, getResult } = createRouteResponse();

    await createHandler(req, res, runtime);

    expect(getResult().status).toBe(400);
  });

  test("returns 400 when userId is missing", async () => {
    const { runtime } = runtimeWithService();
    const req = createRouteRequest({
      body: { workflow: createValidWorkflow() },
      method: "POST",
    });
    const { res, getResult } = createRouteResponse();

    await createHandler(req, res, runtime);

    expect(getResult().status).toBe(400);
  });

  test("returns 422 for invalid workflow", async () => {
    const { runtime } = runtimeWithService();
    const req = createRouteRequest({
      body: {
        workflow: { name: "Bad", nodes: [], connections: {} },
        userId: "user-1",
      },
      method: "POST",
    });
    const { res, getResult } = createRouteResponse();

    await createHandler(req, res, runtime);

    const { status, body } = getResult();
    expect(status).toBe(422);
    expect((body as { error: string }).error).toBe("validation_failed");
  });

  test("returns missing_integrations when credentials are missing", async () => {
    const { runtime } = runtimeWithService({
      deployWorkflow: mock(() =>
        Promise.resolve({
          id: null,
          name: "Test",
          active: false,
          nodeCount: 2,
          missingCredentials: ["gmailOAuth2Api"],
        }),
      ),
    });
    const req = createRouteRequest({
      body: { workflow: createValidWorkflow(), userId: "user-1" },
      method: "POST",
    });
    const { res, getResult } = createRouteResponse();

    await createHandler(req, res, runtime);

    const { status, body } = getResult();
    expect(status).toBe(200);
    const data = body as {
      success: boolean;
      reason: string;
      missingIntegrations: string[];
    };
    expect(data.success).toBe(false);
    expect(data.reason).toBe("missing_integrations");
    expect(data.missingIntegrations).toContain("gmailOAuth2Api");
  });

  test("deactivates workflow when activate=false", async () => {
    const deactivateMock = mock(() => Promise.resolve());
    const { runtime } = runtimeWithService({
      deactivateWorkflow: deactivateMock,
    });
    const req = createRouteRequest({
      body: {
        workflow: createValidWorkflow(),
        userId: "user-1",
        activate: false,
      },
      method: "POST",
    });
    const { res, getResult } = createRouteResponse();

    await createHandler(req, res, runtime);

    const { body } = getResult();
    expect((body as { success: boolean }).success).toBe(true);
    expect(deactivateMock.mock.calls.length).toBe(1);
  });
});

describe("GET /workflows/:id", () => {
  test("returns workflow by id", async () => {
    const { runtime } = runtimeWithService();
    const req = createRouteRequest({ params: { id: "wf-001" } });
    const { res, getResult } = createRouteResponse();

    await getHandler(req, res, runtime);

    const { body } = getResult();
    const data = body as { success: boolean; data: { id: string } };
    expect(data.success).toBe(true);
    expect(data.data.id).toBe("wf-001");
  });

  test("returns 400 when id is missing", async () => {
    const { runtime } = runtimeWithService();
    const req = createRouteRequest({ params: {} });
    const { res, getResult } = createRouteResponse();

    await getHandler(req, res, runtime);

    expect(getResult().status).toBe(400);
  });
});

describe("PUT /workflows/:id", () => {
  test("updates workflow via deployWorkflow with id set", async () => {
    const deployMock = mock(() =>
      Promise.resolve({
        id: "wf-001",
        name: "Updated",
        active: true,
        nodeCount: 2,
        missingCredentials: [],
      }),
    );
    const { runtime } = runtimeWithService({ deployWorkflow: deployMock });
    const req = createRouteRequest({
      params: { id: "wf-001" },
      body: { workflow: createValidWorkflow(), userId: "user-1" },
      method: "PUT",
    });
    const { res, getResult } = createRouteResponse();

    await updateHandler(req, res, runtime);

    const { body } = getResult();
    expect((body as { success: boolean }).success).toBe(true);
    // Verify the workflow passed to deployWorkflow has the id set
    const calledWorkflow = deployMock.mock.calls[0][0] as { id?: string };
    expect(calledWorkflow.id).toBe("wf-001");
  });

  test("returns 400 when id is missing", async () => {
    const { runtime } = runtimeWithService();
    const req = createRouteRequest({
      params: {},
      body: { workflow: createValidWorkflow(), userId: "user-1" },
      method: "PUT",
    });
    const { res, getResult } = createRouteResponse();

    await updateHandler(req, res, runtime);

    expect(getResult().status).toBe(400);
  });

  test("returns 422 for invalid workflow", async () => {
    const { runtime } = runtimeWithService();
    const req = createRouteRequest({
      params: { id: "wf-001" },
      body: {
        workflow: { name: "Bad", nodes: [], connections: {} },
        userId: "user-1",
      },
      method: "PUT",
    });
    const { res, getResult } = createRouteResponse();

    await updateHandler(req, res, runtime);

    expect(getResult().status).toBe(422);
  });
});

describe("DELETE /workflows/:id", () => {
  test("deletes workflow and returns success", async () => {
    const deleteMock = mock(() => Promise.resolve());
    const { runtime } = runtimeWithService({ deleteWorkflow: deleteMock });
    const req = createRouteRequest({
      params: { id: "wf-001" },
      method: "DELETE",
    });
    const { res, getResult } = createRouteResponse();

    await deleteHandler(req, res, runtime);

    expect((getResult().body as { success: boolean }).success).toBe(true);
    expect(deleteMock.mock.calls[0][0]).toBe("wf-001");
  });

  test("returns 400 when id is missing", async () => {
    const { runtime } = runtimeWithService();
    const req = createRouteRequest({ params: {}, method: "DELETE" });
    const { res, getResult } = createRouteResponse();

    await deleteHandler(req, res, runtime);

    expect(getResult().status).toBe(400);
  });
});

describe("POST /workflows/:id/activate", () => {
  test("activates workflow", async () => {
    const activateMock = mock(() => Promise.resolve());
    const { runtime } = runtimeWithService({ activateWorkflow: activateMock });
    const req = createRouteRequest({
      params: { id: "wf-001" },
      method: "POST",
    });
    const { res, getResult } = createRouteResponse();

    await activateHandler(req, res, runtime);

    expect((getResult().body as { success: boolean }).success).toBe(true);
    expect(activateMock.mock.calls[0][0]).toBe("wf-001");
  });

  test("returns 400 when id is missing", async () => {
    const { runtime } = runtimeWithService();
    const req = createRouteRequest({ params: {}, method: "POST" });
    const { res, getResult } = createRouteResponse();

    await activateHandler(req, res, runtime);

    expect(getResult().status).toBe(400);
  });
});

describe("POST /workflows/:id/deactivate", () => {
  test("deactivates workflow", async () => {
    const deactivateMock = mock(() => Promise.resolve());
    const { runtime } = runtimeWithService({
      deactivateWorkflow: deactivateMock,
    });
    const req = createRouteRequest({
      params: { id: "wf-001" },
      method: "POST",
    });
    const { res, getResult } = createRouteResponse();

    await deactivateHandler(req, res, runtime);

    expect((getResult().body as { success: boolean }).success).toBe(true);
    expect(deactivateMock.mock.calls[0][0]).toBe("wf-001");
  });

  test("returns 400 when id is missing", async () => {
    const { runtime } = runtimeWithService();
    const req = createRouteRequest({ params: {}, method: "POST" });
    const { res, getResult } = createRouteResponse();

    await deactivateHandler(req, res, runtime);

    expect(getResult().status).toBe(400);
  });
});
