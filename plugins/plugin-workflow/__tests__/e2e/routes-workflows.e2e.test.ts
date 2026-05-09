/**
 * E2E Tests for Workflow Routes
 *
 * ⚠️ These tests make REAL HTTP calls to the n8n instance configured in .env
 * They will CREATE, MODIFY, and DELETE workflows on the real instance.
 *
 * Prerequisites:
 * - .env file with WORKFLOW_HOST and WORKFLOW_API_KEY
 * - Test n8n instance (not production!)
 *
 * Run with: bun test __tests__/e2e/routes-workflows.e2e.test.ts
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { workflowRoutes } from "../../src/routes/workflows";
import { createE2ERuntime } from "../helpers/e2eRuntime";
import { createSimpleWorkflowNoCredentials } from "../fixtures/workflows";
import type { RouteRequest, RouteResponse } from "@elizaos/core";

let runtime: ReturnType<typeof createE2ERuntime>["runtime"];
const testUserId = "e2e-test-user";
const createdWorkflowIds: string[] = [];
const hasN8n = Boolean(Bun.env.WORKFLOW_HOST && Bun.env.WORKFLOW_API_KEY);

beforeAll(() => {
  if (!hasN8n) {
    console.log("\n⚠️  Skipping e2e tests: WORKFLOW_HOST/WORKFLOW_API_KEY not set\n");
    return;
  }
  const setup = createE2ERuntime();
  runtime = setup.runtime;
  console.log(`\n🔗 Testing against: ${setup.n8nHost}\n`);
});

afterAll(async () => {
  if (!hasN8n) return;

  // Cleanup: delete all workflows created during tests
  console.log(
    `\n🧹 Cleaning up ${createdWorkflowIds.length} test workflows...`,
  );
  const deleteHandler = workflowRoutes.find(
    (r) => r.type === "DELETE" && r.path === "/workflows/:id",
  )!.handler!;

  for (const id of createdWorkflowIds) {
    try {
      const { res } = createTestResponse();
      await deleteHandler(
        { params: { id }, query: {}, body: undefined },
        res,
        runtime,
      );
      console.log(`  ✓ Deleted workflow ${id}`);
    } catch (err) {
      console.warn(`  ⚠️  Failed to delete workflow ${id}:`, err);
    }
  }
});

/** Helper to create test request */
function createTestRequest(
  overrides: Partial<RouteRequest> = {},
): RouteRequest {
  return {
    body: undefined,
    params: {},
    query: {},
    headers: {},
    method: "GET",
    ...overrides,
  };
}

/** Helper to create test response and capture result */
function createTestResponse() {
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

  return { res, getResponse: () => ({ status, body }) };
}

describe.skipIf(!hasN8n)("E2E: POST /workflows", () => {
  test("creates a real workflow on n8n instance", async () => {
    const handler = workflowRoutes.find(
      (r) => r.type === "POST" && r.path === "/workflows",
    )!.handler!;

    const workflow = createSimpleWorkflowNoCredentials({
      name: `E2E Test Workflow ${Date.now()}`,
    });

    const req = createTestRequest({
      body: { workflow, userId: testUserId },
      method: "POST",
    });

    const { res, getResponse } = createTestResponse();
    await handler(req, res, runtime);

    const { status, body } = getResponse();
    const data = body as {
      success: boolean;
      data: { id: string; name: string; active: boolean };
    };

    expect(status).toBe(200);
    expect(data.success).toBe(true);
    expect(data.data.id).toBeTruthy();
    expect(data.data.name).toContain("E2E Test Workflow");

    // Track for cleanup
    if (data.data.id) {
      createdWorkflowIds.push(data.data.id);
    }

    console.log(`  ✅ Created workflow: ${data.data.id}`);
  });

  test("returns 422 for invalid workflow", async () => {
    const handler = workflowRoutes.find(
      (r) => r.type === "POST" && r.path === "/workflows",
    )!.handler!;

    const invalidWorkflow = {
      name: "Invalid",
      nodes: [], // No nodes → invalid
      connections: {},
    };

    const req = createTestRequest({
      body: { workflow: invalidWorkflow, userId: testUserId },
      method: "POST",
    });

    const { res, getResponse } = createTestResponse();
    await handler(req, res, runtime);

    const { status, body } = getResponse();
    expect(status).toBe(422);
    expect((body as { error: string }).error).toBe("validation_failed");
  });
});

describe.skipIf(!hasN8n)("E2E: GET /workflows", () => {
  test("lists workflows from real n8n instance", async () => {
    const handler = workflowRoutes.find(
      (r) => r.type === "GET" && r.path === "/workflows",
    )!.handler!;

    const req = createTestRequest({ query: { userId: testUserId } });
    const { res, getResponse } = createTestResponse();

    await handler(req, res, runtime);

    const { status, body } = getResponse();
    const data = body as {
      success: boolean;
      data: Array<{ id: string; name: string }>;
    };

    expect(status).toBe(200);
    expect(data.success).toBe(true);
    expect(Array.isArray(data.data)).toBe(true);

    console.log(`  ℹ️  Found ${data.data.length} workflows on n8n instance`);
  });
});
