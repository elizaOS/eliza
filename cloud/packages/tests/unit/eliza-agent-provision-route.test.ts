/**
 * Unit tests for POST /api/v1/eliza/agents/[agentId]/provision.
 *
 * This is the API contract used by the app startup flow when a Cloud
 * agent exists but has no live bridge URL yet.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { Hono } from "hono";

const TEST_USER = { id: "u1", organization_id: "o1" };
const TEST_AGENT_ID = "11111111-1111-4111-8111-111111111111";
const UPDATED_AT = new Date("2026-01-01T00:00:00.000Z");

interface MockSandbox {
  id: string;
  agent_name: string | null;
  status: "pending" | "provisioning" | "running" | "stopped" | "disconnected" | "error";
  bridge_url: string | null;
  health_url: string | null;
  updated_at: Date;
}

interface MockJob {
  id: string;
  status: "pending" | "running" | "completed" | "failed";
  estimated_completion_at: Date;
}

interface MockState {
  sandbox: MockSandbox | null;
  creditGate: { allowed: boolean; balance: number; error?: string };
  enqueueResult: { job: MockJob; created: boolean };
  enqueueError: Error | null;
  provisionResult: {
    success: boolean;
    error?: string;
    bridgeUrl?: string;
    healthUrl?: string;
    sandboxRecord?: MockSandbox;
  };
  safeUrlError: Error | null;
  workerHealth:
    | { ok: true; required: boolean; url?: string }
    | {
        ok: false;
        required: true;
        status: 502 | 503;
        code:
          | "PROVISIONING_WORKER_NOT_CONFIGURED"
          | "PROVISIONING_WORKER_UNHEALTHY"
          | "PROVISIONING_WORKER_UNREACHABLE";
        error: string;
      };
  creditChecks: string[];
  enqueueCalls: Array<{
    agentId: string;
    organizationId: string;
    userId: string;
    agentName: string;
    webhookUrl?: string;
    expectedUpdatedAt?: Date | string | null;
  }>;
  getAgentCalls: Array<{ agentId: string; organizationId: string }>;
  provisionCalls: Array<{ agentId: string; organizationId: string }>;
  safeUrlCalls: string[];
}

function makeSandbox(overrides: Partial<MockSandbox> = {}): MockSandbox {
  return {
    id: TEST_AGENT_ID,
    agent_name: "test-agent",
    status: "stopped",
    bridge_url: null,
    health_url: null,
    updated_at: UPDATED_AT,
    ...overrides,
  };
}

function makeJob(overrides: Partial<MockJob> = {}): MockJob {
  return {
    id: "job-1",
    status: "pending",
    estimated_completion_at: new Date("2026-01-01T00:01:30.000Z"),
    ...overrides,
  };
}

function makeState(overrides: Partial<MockState> = {}): MockState {
  return {
    sandbox: makeSandbox(),
    creditGate: { allowed: true, balance: 25 },
    enqueueResult: { job: makeJob(), created: true },
    enqueueError: null,
    provisionResult: {
      success: true,
      bridgeUrl: "https://bridge.example.com",
      healthUrl: "https://health.example.com",
      sandboxRecord: makeSandbox({
        status: "running",
        bridge_url: "https://bridge.example.com",
        health_url: "https://health.example.com",
      }),
    },
    safeUrlError: null,
    workerHealth: { ok: true, required: false },
    creditChecks: [],
    enqueueCalls: [],
    getAgentCalls: [],
    provisionCalls: [],
    safeUrlCalls: [],
    ...overrides,
  };
}

function installMocks(state: MockState): void {
  mock.module("@/lib/auth", () => ({
    requireAuthOrApiKeyWithOrg: async () => ({ user: TEST_USER }),
  }));

  mock.module("@/lib/constants/agent-pricing", () => ({
    AGENT_PRICING: {
      RUNNING_HOURLY_RATE: 0.01,
      IDLE_HOURLY_RATE: 0.0025,
      DAILY_RUNNING_COST: 0.24,
      DAILY_IDLE_COST: 0.06,
      MINIMUM_DEPOSIT: 0.1,
      LOW_CREDIT_WARNING: 2,
      GRACE_PERIOD_HOURS: 48,
    },
  }));

  mock.module("@/lib/security/outbound-url", () => ({
    assertSafeOutboundUrl: async (url: string) => {
      state.safeUrlCalls.push(url);
      if (state.safeUrlError) {
        throw state.safeUrlError;
      }
    },
  }));

  mock.module("@/lib/services/agent-billing-gate", () => ({
    checkAgentCreditGate: async (organizationId: string) => {
      state.creditChecks.push(organizationId);
      return state.creditGate;
    },
  }));

  mock.module("@/lib/services/eliza-sandbox", () => ({
    elizaSandboxService: {
      getAgentForWrite: async (agentId: string, organizationId: string) => {
        state.getAgentCalls.push({ agentId, organizationId });
        return state.sandbox;
      },
      provision: async (agentId: string, organizationId: string) => {
        state.provisionCalls.push({ agentId, organizationId });
        return state.provisionResult;
      },
    },
  }));

  mock.module("@/lib/services/provisioning-jobs", () => ({
    provisioningJobService: {
      enqueueAgentProvisionOnce: async (params: MockState["enqueueCalls"][number]) => {
        state.enqueueCalls.push(params);
        if (state.enqueueError) {
          throw state.enqueueError;
        }
        return state.enqueueResult;
      },
      triggerImmediate: async () => undefined,
    },
  }));

  mock.module("@/lib/services/provisioning-worker-health", () => ({
    checkProvisioningWorkerHealth: async () => state.workerHealth,
    provisioningWorkerFailureBody: (health: Extract<MockState["workerHealth"], { ok: false }>) => ({
      success: false,
      code: health.code,
      error: health.error,
      retryable: true,
    }),
  }));

  mock.module("@/lib/services/proxy/cors", () => ({
    applyCorsHeaders: (response: Response) => response,
    handleCorsOptions: () => new Response(null, { status: 204 }),
  }));

  mock.module("@/lib/api/errors", () => ({
    errorToResponse: (error: unknown) =>
      Response.json(
        { success: false, error: error instanceof Error ? error.message : String(error) },
        { status: 500 },
      ),
  }));

  mock.module("@/lib/utils/logger", () => ({
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  }));
}

async function loadProvisionRoute(): Promise<Hono> {
  const { Hono } = await import("hono");
  const mod = await import(
    new URL(
      `../../../apps/api/v1/eliza/agents/[agentId]/provision/route.ts?test=${Date.now()}-${Math.random()}`,
      import.meta.url,
    ).href
  );
  const inner = mod.default as Hono;
  const parent = new Hono();
  parent.route("/api/v1/eliza/agents/:agentId/provision", inner);
  return parent;
}

async function buildProvisionRequest(
  app: Hono,
  opts: { sync?: boolean; headers?: HeadersInit } = {},
): Promise<Response> {
  const query = opts.sync ? "?sync=true" : "";
  const response = app.request(
    `https://elizacloud.ai/api/v1/eliza/agents/${TEST_AGENT_ID}/provision${query}`,
    {
      method: "POST",
      headers: {
        Authorization: "Bearer eliza_test_key",
        "X-Api-Key": "eliza_test_key",
        ...opts.headers,
      },
    },
  );
  return Promise.resolve(response);
}

function restoreOptionalEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

describe("eliza agent provision route", () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalAllowSync = process.env.ALLOW_AGENT_SYNC_PROVISIONING;
  const originalControlPlaneUrl = process.env.CONTAINER_CONTROL_PLANE_URL;
  const originalRequireProvisioningWorker = process.env.REQUIRE_PROVISIONING_WORKER;

  beforeEach(() => {
    mock.restore();
    process.env.NODE_ENV = "test";
    restoreOptionalEnv("ALLOW_AGENT_SYNC_PROVISIONING", originalAllowSync);
    restoreOptionalEnv("CONTAINER_CONTROL_PLANE_URL", originalControlPlaneUrl);
    restoreOptionalEnv("REQUIRE_PROVISIONING_WORKER", originalRequireProvisioningWorker);
  });

  afterEach(() => {
    mock.restore();
    restoreOptionalEnv("NODE_ENV", originalNodeEnv);
    restoreOptionalEnv("ALLOW_AGENT_SYNC_PROVISIONING", originalAllowSync);
    restoreOptionalEnv("CONTAINER_CONTROL_PLANE_URL", originalControlPlaneUrl);
    restoreOptionalEnv("REQUIRE_PROVISIONING_WORKER", originalRequireProvisioningWorker);
  });

  test("returns existing connection details when the agent is already running", async () => {
    const state = makeState({
      sandbox: makeSandbox({
        status: "running",
        bridge_url: "https://bridge.example.com",
        health_url: "https://health.example.com",
      }),
    });
    installMocks(state);

    const app = await loadProvisionRoute();
    const res = await buildProvisionRequest(app);

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success: boolean;
      data: { id: string; agentName: string; status: string; bridgeUrl: string; healthUrl: string };
    };
    expect(body).toEqual({
      success: true,
      data: {
        id: TEST_AGENT_ID,
        agentName: "test-agent",
        status: "running",
        bridgeUrl: "https://bridge.example.com",
        healthUrl: "https://health.example.com",
      },
    });
    expect(state.creditChecks).toEqual([]);
    expect(state.enqueueCalls).toEqual([]);
  });

  test("enqueues an async provisioning job for a stopped agent", async () => {
    const state = makeState();
    installMocks(state);

    const app = await loadProvisionRoute();
    const res = await buildProvisionRequest(app);

    expect(res.status).toBe(202);
    const body = (await res.json()) as {
      success: boolean;
      created: boolean;
      alreadyInProgress: boolean;
      data: { jobId: string; agentId: string; status: string; estimatedCompletionAt: string };
      polling: { endpoint: string; intervalMs: number; expectedDurationMs: number };
    };
    expect(body.success).toBe(true);
    expect(body.created).toBe(true);
    expect(body.alreadyInProgress).toBe(false);
    expect(body.data).toEqual({
      jobId: "job-1",
      agentId: TEST_AGENT_ID,
      status: "pending",
      estimatedCompletionAt: "2026-01-01T00:01:30.000Z",
    });
    expect(body.polling).toEqual({
      endpoint: "/api/v1/jobs/job-1",
      intervalMs: 5000,
      expectedDurationMs: 90000,
    });
    expect(state.creditChecks).toEqual(["o1"]);
    expect(state.enqueueCalls).toEqual([
      {
        agentId: TEST_AGENT_ID,
        organizationId: "o1",
        userId: "u1",
        agentName: "test-agent",
        webhookUrl: undefined,
        expectedUpdatedAt: UPDATED_AT,
      },
    ]);
    expect(state.provisionCalls).toEqual([]);
  });

  test("returns 409 with the existing job when provisioning is already in progress", async () => {
    const state = makeState({
      enqueueResult: { job: makeJob({ id: "job-existing", status: "running" }), created: false },
    });
    installMocks(state);

    const app = await loadProvisionRoute();
    const res = await buildProvisionRequest(app);

    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      success: boolean;
      created: boolean;
      alreadyInProgress: boolean;
      data: { jobId: string; status: string };
    };
    expect(body.success).toBe(true);
    expect(body.created).toBe(false);
    expect(body.alreadyInProgress).toBe(true);
    expect(body.data.jobId).toBe("job-existing");
    expect(body.data.status).toBe("running");
    expect(state.enqueueCalls).toHaveLength(1);
  });

  test("returns a safe diagnostic code when enqueueing fails unexpectedly", async () => {
    const state = makeState({
      enqueueError: new Error("SQL_HEAVY_PAYLOAD_STORAGE=r2 but no storage is configured"),
    });
    installMocks(state);

    const app = await loadProvisionRoute();
    const res = await buildProvisionRequest(app);

    expect(res.status).toBe(500);
    const body = (await res.json()) as {
      success: boolean;
      code: string;
      error: string;
      failureId: string;
      retryable: boolean;
    };
    expect(body).toEqual({
      success: false,
      code: "provision_enqueue_failed",
      error: "Failed to start provisioning",
      failureId: expect.any(String),
      retryable: true,
    });
    expect(body.error).not.toContain("SQL_HEAVY_PAYLOAD_STORAGE");
    expect(state.enqueueCalls).toHaveLength(1);
  });

  test("fails closed in production when the provisioning worker is not configured", async () => {
    process.env.NODE_ENV = "production";
    delete process.env.CONTAINER_CONTROL_PLANE_URL;
    const state = makeState({
      workerHealth: {
        ok: false,
        required: true,
        status: 503,
        code: "PROVISIONING_WORKER_NOT_CONFIGURED",
        error:
          "Agent provisioning worker is not configured. Set CONTAINER_CONTROL_PLANE_URL before accepting provisioning requests.",
      },
    });
    installMocks(state);

    const app = await loadProvisionRoute();
    const res = await buildProvisionRequest(app);

    expect(res.status).toBe(503);
    const body = (await res.json()) as {
      success: boolean;
      code: string;
      error: string;
      retryable: boolean;
    };
    expect(body).toEqual({
      success: false,
      code: "PROVISIONING_WORKER_NOT_CONFIGURED",
      error:
        "Agent provisioning worker is not configured. Set CONTAINER_CONTROL_PLANE_URL before accepting provisioning requests.",
      retryable: true,
    });
    expect(state.creditChecks).toEqual(["o1"]);
    expect(state.enqueueCalls).toEqual([]);
  });

  test("returns 402 and skips enqueueing when credits are insufficient", async () => {
    const state = makeState({
      creditGate: {
        allowed: false,
        balance: 0.05,
        error: "Insufficient credits",
      },
    });
    installMocks(state);

    const app = await loadProvisionRoute();
    const res = await buildProvisionRequest(app);

    expect(res.status).toBe(402);
    const body = (await res.json()) as {
      success: boolean;
      error: string;
      requiredBalance: number;
      currentBalance: number;
    };
    expect(body).toEqual({
      success: false,
      error: "Insufficient credits",
      requiredBalance: 0.1,
      currentBalance: 0.05,
    });
    expect(state.creditChecks).toEqual(["o1"]);
    expect(state.enqueueCalls).toEqual([]);
  });

  test("rejects unsafe webhook URLs before enqueueing", async () => {
    const state = makeState({
      safeUrlError: new Error("Invalid webhook URL"),
    });
    installMocks(state);

    const app = await loadProvisionRoute();
    const res = await buildProvisionRequest(app, {
      headers: { "x-webhook-url": "http://127.0.0.1/hook" },
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { success: boolean; error: string };
    expect(body).toEqual({ success: false, error: "Invalid webhook URL" });
    expect(state.safeUrlCalls).toEqual(["http://127.0.0.1/hook"]);
    expect(state.enqueueCalls).toEqual([]);
  });

  test("returns 404 when the agent does not exist", async () => {
    const state = makeState({ sandbox: null });
    installMocks(state);

    const app = await loadProvisionRoute();
    const res = await buildProvisionRequest(app);

    expect(res.status).toBe(404);
    const body = (await res.json()) as { success: boolean; error: string };
    expect(body).toEqual({ success: false, error: "Agent not found" });
    expect(state.creditChecks).toEqual([]);
    expect(state.enqueueCalls).toEqual([]);
  });

  test("supports the sync fallback outside production", async () => {
    process.env.NODE_ENV = "test";
    const state = makeState();
    installMocks(state);

    const app = await loadProvisionRoute();
    const res = await buildProvisionRequest(app, { sync: true });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success: boolean;
      data: { id: string; agentName: string; status: string; bridgeUrl: string; healthUrl: string };
    };
    expect(body).toEqual({
      success: true,
      data: {
        id: TEST_AGENT_ID,
        agentName: "test-agent",
        status: "running",
        bridgeUrl: "https://bridge.example.com",
        healthUrl: "https://health.example.com",
      },
    });
    expect(state.creditChecks).toEqual(["o1"]);
    expect(state.provisionCalls).toEqual([{ agentId: TEST_AGENT_ID, organizationId: "o1" }]);
    expect(state.enqueueCalls).toEqual([]);
  });
});
