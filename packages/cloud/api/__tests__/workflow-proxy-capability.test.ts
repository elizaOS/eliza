/**
 * Exercises Cloud workflow capability responses and trusted principal forwarding.
 * External services are replaced with deterministic route-boundary fixtures.
 */
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import type { AgentExecutionTier } from "@elizaos/shared/contracts/cloud-agent-lifecycle";
import * as authActual from "@/lib/auth";
import * as redisFactoryActual from "@/lib/cache/redis-factory";
import * as billingGateActual from "@/lib/services/agent-billing-gate";
import * as elizaSandboxActual from "@/lib/services/eliza-sandbox";
import * as provisioningJobsActual from "@/lib/services/provisioning-jobs";
import * as workerHealthActual from "@/lib/services/provisioning-worker-health";
import type { AppContext } from "@/types/cloud-worker-env";

const requireAuth = mock(async () => ({
  user: { id: "user-1", organization_id: "org-1" },
}));
type AgentFixture = {
  id: string;
  execution_tier: AgentExecutionTier;
  status?: string;
  bridge_url?: string | null;
  health_url?: string | null;
};
const getAgent = mock<
  (_agentId: string, _organizationId: string) => Promise<AgentFixture | null>
>(async () => ({ id: "agent-1", execution_tier: "shared" }));
const buildRedisClient = mock((_env: unknown) => null as unknown);
const checkAgentCreditGate = mock(async (_organizationId: string) => ({
  allowed: true,
}));
const checkProvisioningWorkerHealth = mock(async () => ({ ok: true }));
const enqueueAgentWakeOnce = mock(async () => ({
  job: { id: "wake-job-1", status: "pending" },
  created: true,
}));
const triggerImmediate = mock(async (_env: unknown) => undefined);

mock.module("@/lib/auth", () => ({
  ...authActual,
  requireAuthOrApiKeyWithOrg: requireAuth,
}));

mock.module("@/lib/cache/redis-factory", () => ({
  ...redisFactoryActual,
  buildRedisClient,
}));

mock.module("@/lib/services/eliza-sandbox", () => ({
  ...elizaSandboxActual,
  elizaSandboxService: {
    ...elizaSandboxActual.elizaSandboxService,
    getAgent,
  },
}));

mock.module("@/lib/services/agent-billing-gate", () => ({
  ...billingGateActual,
  checkAgentCreditGate,
}));

mock.module("@/lib/services/provisioning-jobs", () => ({
  ...provisioningJobsActual,
  provisioningJobService: {
    ...provisioningJobsActual.provisioningJobService,
    enqueueAgentWakeOnce,
    triggerImmediate,
  },
}));

mock.module("@/lib/services/provisioning-worker-health", () => ({
  ...workerHealthActual,
  checkProvisioningWorkerHealth,
}));

const {
  handleWorkflowProxyRequest,
  workflowProxyTimeoutMs,
  workflowRuntimeUnavailableResponse,
} = await import("../v1/eliza/agents/[agentId]/workflows/_shared");

const originalFetch = globalThis.fetch;

beforeEach(() => {
  requireAuth.mockClear();
  getAgent.mockClear();
  checkAgentCreditGate.mockClear();
  checkProvisioningWorkerHealth.mockClear();
  enqueueAgentWakeOnce.mockClear();
  triggerImmediate.mockClear();
  buildRedisClient.mockReset();
  buildRedisClient.mockImplementation(() => null as unknown);
  getAgent.mockImplementation(async () => ({
    id: "agent-1",
    execution_tier: "shared" as const,
  }));
  checkAgentCreditGate.mockImplementation(async () => ({ allowed: true }));
  checkProvisioningWorkerHealth.mockImplementation(async () => ({ ok: true }));
  enqueueAgentWakeOnce.mockImplementation(async () => ({
    job: { id: "wake-job-1", status: "pending" },
    created: true,
  }));
  triggerImmediate.mockImplementation(async () => undefined);
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

afterAll(() => {
  mock.module("@/lib/auth", () => authActual);
  mock.module("@/lib/cache/redis-factory", () => redisFactoryActual);
  mock.module("@/lib/services/agent-billing-gate", () => billingGateActual);
  mock.module("@/lib/services/eliza-sandbox", () => elizaSandboxActual);
  mock.module("@/lib/services/provisioning-jobs", () => provisioningJobsActual);
  mock.module(
    "@/lib/services/provisioning-worker-health",
    () => workerHealthActual,
  );
});

function context(env: Record<string, unknown> = {}): AppContext {
  return { env } as unknown as AppContext;
}

function workflowRequest(headers?: HeadersInit): Request {
  return new Request(
    "https://api.example.test/api/v1/eliza/agents/agent-1/workflows",
    { headers },
  );
}

function installLiveRedisAssignment() {
  const redisGet = mock(async (key: string) => {
    if (key === "agent:agent-1:server") return "server-1";
    if (key === "server:server-1:url") return "https://agent-server.test";
    return null;
  });
  buildRedisClient.mockImplementation(() => ({ get: redisGet }) as unknown);
  return redisGet;
}

describe("workflow capability responses", () => {
  test("returns an explicit, non-automatic upgrade path for shared agents", async () => {
    const redisGet = installLiveRedisAssignment();
    const fetchRequest = mock(async () => Response.json({ ok: true }));
    globalThis.fetch = fetchRequest as unknown as typeof fetch;

    const response = await handleWorkflowProxyRequest(
      workflowRequest(),
      "agent-1",
      "",
      context(),
    );

    expect(response.status).toBe(409);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toEqual({
      success: false,
      code: "workflow_requires_dedicated",
      error:
        "Workflows require a dedicated agent runtime. Upgrade this agent before managing workflows.",
      capability: "workflows",
      currentExecutionTier: "shared",
      requiredExecutionTier: "dedicated-always",
      upgradeRequired: true,
      upgrade: {
        automatic: false,
        method: "POST",
        endpoint: "/api/v1/eliza/agents/agent-1/upgrade-tier",
      },
    });
    expect(buildRedisClient).not.toHaveBeenCalled();
    expect(redisGet).not.toHaveBeenCalled();
    expect(fetchRequest).not.toHaveBeenCalled();
  });

  test("distinguishes a dedicated runtime outage from an upgrade requirement", async () => {
    getAgent.mockImplementation(async () => ({
      id: "agent-1",
      execution_tier: "dedicated-always" as const,
    }));

    const response = await handleWorkflowProxyRequest(
      workflowRequest(),
      "agent-1",
      "",
      context(),
    );

    expect(response.status).toBe(503);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toEqual({
      success: false,
      code: "workflow_runtime_unavailable",
      error: "The agent workflow runtime is temporarily unavailable.",
      capability: "workflows",
      currentExecutionTier: "dedicated-always",
      upgradeRequired: false,
      retryable: true,
    });
  });

  test("credit-gates and enqueues a scale-to-zero agent wake on workflow use", async () => {
    getAgent.mockImplementation(async () => ({
      id: "agent-1",
      execution_tier: "dedicated-lazy" as const,
      status: "sleeping",
      bridge_url: null,
      health_url: null,
    }));

    const response = await handleWorkflowProxyRequest(
      workflowRequest(),
      "agent-1",
      "",
      context(),
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      success: false,
      code: "workflow_runtime_waking",
      currentExecutionTier: "dedicated-lazy",
      retryable: true,
      wake: {
        jobId: "wake-job-1",
        status: "pending",
        created: true,
      },
      polling: { endpoint: "/api/v1/jobs/wake-job-1", intervalMs: 5000 },
    });
    expect(checkAgentCreditGate).toHaveBeenCalledWith("org-1");
    expect(enqueueAgentWakeOnce).toHaveBeenCalledWith({
      agentId: "agent-1",
      organizationId: "org-1",
      userId: "user-1",
    });
    expect(triggerImmediate).toHaveBeenCalledTimes(1);
  });

  test("ignores a stale live assignment when a dedicated-lazy agent is stopped", async () => {
    getAgent.mockImplementation(async () => ({
      id: "agent-1",
      execution_tier: "dedicated-lazy" as const,
      status: "stopped",
      bridge_url: "https://stale-bridge.example.test",
      health_url: "https://stale-health.example.test",
    }));
    const redisGet = installLiveRedisAssignment();
    const fetchRequest = mock(async () => Response.json({ ok: true }));
    globalThis.fetch = fetchRequest as unknown as typeof fetch;

    const response = await handleWorkflowProxyRequest(
      workflowRequest(),
      "agent-1",
      "",
      context({ AGENT_SERVER_SHARED_SECRET: "server-secret" }),
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      code: "workflow_runtime_waking",
      currentExecutionTier: "dedicated-lazy",
      wake: { jobId: "wake-job-1" },
    });
    expect(checkAgentCreditGate).toHaveBeenCalledWith("org-1");
    expect(enqueueAgentWakeOnce).toHaveBeenCalledTimes(1);
    expect(buildRedisClient).not.toHaveBeenCalled();
    expect(redisGet).not.toHaveBeenCalled();
    expect(fetchRequest).not.toHaveBeenCalled();
  });

  test("does not let a stale sleeping assignment bypass the credit gate", async () => {
    getAgent.mockImplementation(async () => ({
      id: "agent-1",
      execution_tier: "dedicated-lazy" as const,
      status: "sleeping",
      bridge_url: null,
      health_url: null,
    }));
    checkAgentCreditGate.mockImplementation(async () => ({
      allowed: false,
      balance: 0,
      error: "Insufficient credits",
    }));
    const redisGet = installLiveRedisAssignment();
    const fetchRequest = mock(async () => Response.json({ ok: true }));
    globalThis.fetch = fetchRequest as unknown as typeof fetch;

    const response = await handleWorkflowProxyRequest(
      workflowRequest(),
      "agent-1",
      "",
      context(),
    );

    expect(response.status).toBe(402);
    expect(await response.json()).toMatchObject({
      success: false,
      code: "insufficient_credits",
      currentBalance: 0,
    });
    expect(enqueueAgentWakeOnce).not.toHaveBeenCalled();
    expect(triggerImmediate).not.toHaveBeenCalled();
    expect(buildRedisClient).not.toHaveBeenCalled();
    expect(redisGet).not.toHaveBeenCalled();
    expect(fetchRequest).not.toHaveBeenCalled();
  });

  test("encodes agent IDs in the upgrade endpoint", async () => {
    const response = workflowRuntimeUnavailableResponse("agent/id", "shared");
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      upgrade: {
        endpoint: "/api/v1/eliza/agents/agent%2Fid/upgrade-tier",
      },
    });
  });
});

describe("workflow proxy timeout budgets", () => {
  test("allows synchronous Smithers runs to reach their engine deadline", () => {
    expect(workflowProxyTimeoutMs("POST", "workflow-1/run")).toBe(10 * 60_000);
  });

  test("gives generation and clarification more room than ordinary API calls", () => {
    expect(workflowProxyTimeoutMs("POST", "generate")).toBe(5 * 60_000);
    expect(workflowProxyTimeoutMs("POST", "resolve-clarification")).toBe(
      5 * 60_000,
    );
    expect(workflowProxyTimeoutMs("POST", "workflow-1/activate")).toBe(120_000);
    expect(workflowProxyTimeoutMs("GET", "workflow-1/run")).toBe(120_000);
  });
});

describe("workflow principal forwarding", () => {
  test("overwrites caller identity headers with the authenticated principal", async () => {
    getAgent.mockImplementation(async () => ({
      id: "agent-1",
      execution_tier: "dedicated-always" as const,
    }));
    const redisGet = mock(async (key: string) => {
      if (key === "agent:agent-1:server") return "server-1";
      if (key === "server:server-1:url") return "https://agent-server.test";
      return null;
    });
    buildRedisClient.mockImplementation(() => ({ get: redisGet }) as unknown);
    const fetchRequest = mock(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        Response.json({ ok: true }),
    );
    globalThis.fetch = fetchRequest as unknown as typeof fetch;

    const response = await handleWorkflowProxyRequest(
      new Request(
        "https://api.example.test/api/v1/eliza/agents/agent-1/workflows/resolve-clarification",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-eliza-user-id": "spoofed-user",
            "x-eliza-organization-id": "spoofed-org",
          },
          body: JSON.stringify({ draft: {}, resolutions: [] }),
        },
      ),
      "agent-1",
      "resolve-clarification",
      context({ AGENT_SERVER_SHARED_SECRET: "server-secret" }),
    );

    expect(response.status).toBe(200);
    expect(fetchRequest).toHaveBeenCalledTimes(1);
    const call = fetchRequest.mock.calls as unknown as Array<
      [RequestInfo | URL, RequestInit]
    >;
    expect(String(call[0]?.[0])).toBe(
      "https://agent-server.test/agents/agent-1/workflows/resolve-clarification",
    );
    expect(call[0]?.[1].method).toBe("POST");
    expect(
      JSON.parse(new TextDecoder().decode(call[0]?.[1].body as ArrayBuffer)),
    ).toEqual({ draft: {}, resolutions: [] });
    const forwardedHeaders = new Headers(call[0]?.[1].headers);
    expect(forwardedHeaders.get("x-server-token")).toBe("server-secret");
    expect(forwardedHeaders.get("x-eliza-user-id")).toBe("user-1");
    expect(forwardedHeaders.get("x-eliza-organization-id")).toBe("org-1");
  });

  test("forwards the evaluation-samples suffix and query without a body", async () => {
    getAgent.mockImplementation(async () => ({
      id: "agent-1",
      execution_tier: "dedicated-always" as const,
    }));
    const redisGet = mock(async (key: string) => {
      if (key === "agent:agent-1:server") return "server-1";
      if (key === "server:server-1:url") return "https://agent-server.test";
      return null;
    });
    buildRedisClient.mockImplementation(() => ({ get: redisGet }) as unknown);
    const fetchRequest = mock(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        Response.json({ workflowId: "workflow-1" }),
    );
    globalThis.fetch = fetchRequest as unknown as typeof fetch;

    const response = await handleWorkflowProxyRequest(
      new Request(
        "https://api.example.test/api/v1/eliza/agents/agent-1/workflows/workflow-1/evaluation-samples?limit=7",
      ),
      "agent-1",
      "workflow-1/evaluation-samples",
      context({ AGENT_SERVER_SHARED_SECRET: "server-secret" }),
    );

    expect(response.status).toBe(200);
    const call = fetchRequest.mock.calls as unknown as Array<
      [RequestInfo | URL, RequestInit]
    >;
    expect(String(call[0]?.[0])).toBe(
      "https://agent-server.test/agents/agent-1/workflows/workflow-1/evaluation-samples?limit=7",
    );
    expect(call[0]?.[1].method).toBe("GET");
    expect(call[0]?.[1].body).toBeUndefined();
    const forwardedHeaders = new Headers(call[0]?.[1].headers);
    expect(forwardedHeaders.get("x-eliza-user-id")).toBe("user-1");
    expect(forwardedHeaders.get("x-eliza-organization-id")).toBe("org-1");
  });
});
