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
import { createHash } from "node:crypto";
import * as authActual from "@/lib/auth";
import * as redisFactoryActual from "@/lib/cache/redis-factory";
import * as billingGateActual from "@/lib/services/agent-billing-gate";
import * as elizaSandboxActual from "@/lib/services/eliza-sandbox";
import * as provisioningJobsActual from "@/lib/services/provisioning-jobs";
import * as workerHealthActual from "@/lib/services/provisioning-worker-health";
import type { AppContext } from "@/types/cloud-worker-env";

const MANAGED_AGENT_ID = "00000000-0000-4000-8000-0000000000a1";
const RUNTIME_AGENT_ID = "00000000-0000-4000-8000-0000000000b2";
const OTHER_RUNTIME_AGENT_ID = "00000000-0000-4000-8000-0000000000b3";
const GENERATION = "00000000-0000-4000-8000-0000000000c3";
const PUBLICATION_ID = "00000000-0000-4000-8000-0000000000d4";
const MANAGED_SERVER_NAME = `sandbox-${GENERATION}`;
const MANAGED_SERVER_URL = "https://sandbox.internal:3000/";
const ACTIVATION_SNAPSHOT_SENTINEL = "activation-routing-snapshot:v1";
const ACTIVATION_MISSING_SENTINEL = "activation-routing-missing:v1";
const ACTIVATION_VALUE_PREFIX = "activation-routing:v1:";
const ROUTING_VALUE_SNAPSHOT_SENTINEL = "agent-server-routing-value:v1";
const ROUTING_VALUE_MISSING_SENTINEL = "agent-server-routing-missing:v1";
const ROUTING_VALUE_PREFIX = "agent-server-routing:v1:";

const requireAuth = mock(async () => ({
  user: { id: "user-1", organization_id: "org-1" },
}));
type AgentExecutionTier =
  | "shared"
  | "dedicated-lazy"
  | "dedicated-always"
  | "custom";
type AgentFixture = {
  id: string;
  character_id?: string | null;
  execution_tier: AgentExecutionTier;
  status?: string;
  bridge_url?: string | null;
  health_url?: string | null;
};
const getAgent = mock<
  (_agentId: string, _organizationId: string) => Promise<AgentFixture | null>
>(async () => ({ id: MANAGED_AGENT_ID, execution_tier: "shared" }));
const buildRedisClient = mock((_env: unknown) => null as unknown);
const evalRedisReadOnly = mock(
  async (
    redis: {
      evalRo?: (
        script: string,
        keys: string[],
        args: Array<string | number>,
      ) => Promise<unknown>;
    },
    scripts: { upstashRedis: string },
    keys: string[],
    args: Array<string | number>,
  ) => {
    if (!redis.evalRo)
      throw new Error("read-only Redis evaluation unavailable");
    return redis.evalRo(scripts.upstashRedis, keys, args);
  },
);
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
  evalRedisReadOnly,
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
  evalRedisReadOnly.mockClear();
  getAgent.mockImplementation(async () => ({
    id: MANAGED_AGENT_ID,
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
    `https://api.example.test/api/v1/eliza/agents/${MANAGED_AGENT_ID}/workflows`,
    { headers },
  );
}

function managedRoutingValues(
  runtimeAgentId: string = RUNTIME_AGENT_ID,
): Map<string, string> {
  const endpoint = {
    version: 1,
    generation: GENERATION,
    kind: "dedicated-sandbox",
    serverName: MANAGED_SERVER_NAME,
    runtimeAgentId,
    registryUrl: MANAGED_SERVER_URL,
    bridgeUrl: "http://100.64.0.3:3000",
    healthUrl: "http://100.64.0.3:3000/health",
  };
  const endpointSha256 = createHash("sha256")
    .update(JSON.stringify(endpoint), "utf8")
    .digest("hex");
  return new Map([
    [
      `agent:${MANAGED_AGENT_ID}:routing-managed`,
      JSON.stringify({ version: 1, managed: true }),
    ],
    [
      `agent:${MANAGED_AGENT_ID}:registration-authority`,
      JSON.stringify({
        version: 1,
        state: "active",
        generation: GENERATION,
        publicationId: PUBLICATION_ID,
        endpointSha256,
      }),
    ],
    [
      `agent:${MANAGED_AGENT_ID}:activation-route`,
      JSON.stringify({
        version: 1,
        kind: "dedicated-sandbox",
        generation: GENERATION,
        publicationId: PUBLICATION_ID,
        endpointSha256,
        endpoint,
      }),
    ],
    [`server:${MANAGED_SERVER_NAME}:url`, MANAGED_SERVER_URL],
  ]);
}

function installRoutingRedis(values = managedRoutingValues()) {
  const evalRo = mock(
    async (_script: string, keys: string[], args: Array<string | number>) => {
      if (args.length !== 0) throw new Error("unexpected routing script args");
      if (keys.length === 3) {
        return [
          ACTIVATION_SNAPSHOT_SENTINEL,
          ...keys.map((key) =>
            values.has(key)
              ? `${ACTIVATION_VALUE_PREFIX}${values.get(key)}`
              : ACTIVATION_MISSING_SENTINEL,
          ),
        ];
      }
      if (keys.length === 1) {
        const key = keys[0];
        return [
          ROUTING_VALUE_SNAPSHOT_SENTINEL,
          key !== undefined && values.has(key)
            ? `${ROUTING_VALUE_PREFIX}${values.get(key)}`
            : ROUTING_VALUE_MISSING_SENTINEL,
        ];
      }
      throw new Error("unexpected routing key count");
    },
  );
  const evalWrite = mock(async () => {
    throw new Error("mutating EVAL must not be used for workflow routing");
  });
  const get = mock(async () => {
    throw new Error(
      "auto-deserializing GET must not be used for workflow routing",
    );
  });
  buildRedisClient.mockImplementation(
    () => ({ evalRo, eval: evalWrite, get }) as unknown,
  );
  return { evalRo, evalWrite, get, values };
}

describe("workflow capability responses", () => {
  test("returns an explicit, non-automatic upgrade path for shared agents", async () => {
    const routingRedis = installRoutingRedis();
    const fetchRequest = mock(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        Response.json({ ok: true }),
    );
    globalThis.fetch = fetchRequest as unknown as typeof fetch;

    const response = await handleWorkflowProxyRequest(
      workflowRequest(),
      MANAGED_AGENT_ID,
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
        endpoint: `/api/v1/eliza/agents/${MANAGED_AGENT_ID}/upgrade-tier`,
      },
    });
    expect(buildRedisClient).not.toHaveBeenCalled();
    expect(routingRedis.evalRo).not.toHaveBeenCalled();
    expect(fetchRequest).not.toHaveBeenCalled();
  });

  test("distinguishes a dedicated runtime outage from an upgrade requirement", async () => {
    getAgent.mockImplementation(async () => ({
      id: MANAGED_AGENT_ID,
      execution_tier: "dedicated-always" as const,
    }));

    const response = await handleWorkflowProxyRequest(
      workflowRequest(),
      MANAGED_AGENT_ID,
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
      id: MANAGED_AGENT_ID,
      execution_tier: "dedicated-lazy" as const,
      status: "sleeping",
      bridge_url: null,
      health_url: null,
    }));

    const response = await handleWorkflowProxyRequest(
      workflowRequest(),
      MANAGED_AGENT_ID,
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
      agentId: MANAGED_AGENT_ID,
      organizationId: "org-1",
      userId: "user-1",
    });
    expect(triggerImmediate).toHaveBeenCalledTimes(1);
  });

  test("ignores a stale live assignment when a dedicated-lazy agent is stopped", async () => {
    getAgent.mockImplementation(async () => ({
      id: MANAGED_AGENT_ID,
      execution_tier: "dedicated-lazy" as const,
      status: "stopped",
      bridge_url: "https://stale-bridge.example.test",
      health_url: "https://stale-health.example.test",
    }));
    const routingRedis = installRoutingRedis();
    const fetchRequest = mock(async () => Response.json({ ok: true }));
    globalThis.fetch = fetchRequest as unknown as typeof fetch;

    const response = await handleWorkflowProxyRequest(
      workflowRequest(),
      MANAGED_AGENT_ID,
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
    expect(routingRedis.evalRo).not.toHaveBeenCalled();
    expect(fetchRequest).not.toHaveBeenCalled();
  });

  test("does not let a stale sleeping assignment bypass the credit gate", async () => {
    getAgent.mockImplementation(async () => ({
      id: MANAGED_AGENT_ID,
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
    const routingRedis = installRoutingRedis();
    const fetchRequest = mock(async () => Response.json({ ok: true }));
    globalThis.fetch = fetchRequest as unknown as typeof fetch;

    const response = await handleWorkflowProxyRequest(
      workflowRequest(),
      MANAGED_AGENT_ID,
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
    expect(routingRedis.evalRo).not.toHaveBeenCalled();
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

describe("workflow routing authority", () => {
  test("fails before Redis when the sandbox has no canonical runtime identity", async () => {
    getAgent.mockImplementation(async () => ({
      id: MANAGED_AGENT_ID,
      character_id: null,
      execution_tier: "dedicated-always" as const,
    }));
    const fetchRequest = mock(async () => Response.json({ ok: true }));
    globalThis.fetch = fetchRequest as unknown as typeof fetch;

    const response = await handleWorkflowProxyRequest(
      workflowRequest(),
      MANAGED_AGENT_ID,
      "",
      context({ AGENT_SERVER_SHARED_SECRET: "server-secret" }),
    );

    expect(response.status).toBe(503);
    expect(buildRedisClient).not.toHaveBeenCalled();
    expect(fetchRequest).not.toHaveBeenCalled();
  });

  test("rejects a managed endpoint bound to another runtime before heartbeat or fetch", async () => {
    getAgent.mockImplementation(async () => ({
      id: MANAGED_AGENT_ID,
      character_id: RUNTIME_AGENT_ID,
      execution_tier: "dedicated-always" as const,
    }));
    const routingRedis = installRoutingRedis(
      managedRoutingValues(OTHER_RUNTIME_AGENT_ID),
    );
    const fetchRequest = mock(async () => Response.json({ ok: true }));
    globalThis.fetch = fetchRequest as unknown as typeof fetch;

    const response = await handleWorkflowProxyRequest(
      workflowRequest(),
      MANAGED_AGENT_ID,
      "",
      context({ AGENT_SERVER_SHARED_SECRET: "server-secret" }),
    );

    expect(response.status).toBe(503);
    expect(routingRedis.evalRo).toHaveBeenCalledTimes(1);
    expect(routingRedis.evalRo.mock.calls[0]?.[1]).toEqual([
      `agent:${MANAGED_AGENT_ID}:routing-managed`,
      `agent:${MANAGED_AGENT_ID}:registration-authority`,
      `agent:${MANAGED_AGENT_ID}:activation-route`,
    ]);
    expect(routingRedis.get).not.toHaveBeenCalled();
    expect(fetchRequest).not.toHaveBeenCalled();
  });

  test("never consults legacy routing after a managed authority is revoked", async () => {
    getAgent.mockImplementation(async () => ({
      id: MANAGED_AGENT_ID,
      character_id: RUNTIME_AGENT_ID,
      execution_tier: "dedicated-always" as const,
    }));
    const values = managedRoutingValues();
    values.set(
      `agent:${MANAGED_AGENT_ID}:registration-authority`,
      JSON.stringify({
        version: 1,
        state: "revoked",
        generation: GENERATION,
        publicationId: null,
        endpointSha256: null,
      }),
    );
    values.delete(`agent:${MANAGED_AGENT_ID}:activation-route`);
    values.set(`agent:${RUNTIME_AGENT_ID}:server`, "stale-server");
    values.set("server:stale-server:url", "https://stale.internal:3000");
    const routingRedis = installRoutingRedis(values);
    const fetchRequest = mock(async () => Response.json({ ok: true }));
    globalThis.fetch = fetchRequest as unknown as typeof fetch;

    const response = await handleWorkflowProxyRequest(
      workflowRequest(),
      MANAGED_AGENT_ID,
      "",
      context({ AGENT_SERVER_SHARED_SECRET: "server-secret" }),
    );

    expect(response.status).toBe(503);
    const readKeys = routingRedis.evalRo.mock.calls.flatMap((call) => call[1]);
    expect(readKeys).not.toContain(`agent:${RUNTIME_AGENT_ID}:server`);
    expect(readKeys).not.toContain("server:stale-server:url");
    expect(fetchRequest).not.toHaveBeenCalled();
  });

  test("keeps literal null distinct from a missing legacy pointer", async () => {
    getAgent.mockImplementation(async () => ({
      id: MANAGED_AGENT_ID,
      character_id: RUNTIME_AGENT_ID,
      execution_tier: "dedicated-always" as const,
    }));
    const routingRedis = installRoutingRedis(
      new Map([[`agent:${RUNTIME_AGENT_ID}:server`, "null"]]),
    );
    const fetchRequest = mock(async () => Response.json({ ok: true }));
    globalThis.fetch = fetchRequest as unknown as typeof fetch;

    const response = await handleWorkflowProxyRequest(
      workflowRequest(),
      MANAGED_AGENT_ID,
      "",
      context({ AGENT_SERVER_SHARED_SECRET: "server-secret" }),
    );

    expect(response.status).toBe(503);
    const readKeys = routingRedis.evalRo.mock.calls.flatMap((call) => call[1]);
    expect(readKeys).toContain(`agent:${RUNTIME_AGENT_ID}:server`);
    expect(readKeys).not.toContain(`agent:${MANAGED_AGENT_ID}:server`);
    expect(readKeys).not.toContain("server:null:url");
    expect(routingRedis.get).not.toHaveBeenCalled();
    expect(fetchRequest).not.toHaveBeenCalled();
  });

  test("fails closed when read-only Redis evaluation is unavailable", async () => {
    getAgent.mockImplementation(async () => ({
      id: MANAGED_AGENT_ID,
      character_id: RUNTIME_AGENT_ID,
      execution_tier: "dedicated-always" as const,
    }));
    const routingRedis = installRoutingRedis();
    routingRedis.evalRo.mockImplementation(async () => {
      throw new Error("Redis unavailable");
    });
    const fetchRequest = mock(async () => Response.json({ ok: true }));
    globalThis.fetch = fetchRequest as unknown as typeof fetch;

    const response = await handleWorkflowProxyRequest(
      workflowRequest(),
      MANAGED_AGENT_ID,
      "",
      context({ AGENT_SERVER_SHARED_SECRET: "server-secret" }),
    );

    expect(response.status).toBe(503);
    expect(routingRedis.evalRo).toHaveBeenCalledTimes(1);
    expect(routingRedis.evalWrite).not.toHaveBeenCalled();
    expect(routingRedis.get).not.toHaveBeenCalled();
    expect(fetchRequest).not.toHaveBeenCalled();
  });

  test("uses only the runtime identity for an unmanaged legacy pointer", async () => {
    getAgent.mockImplementation(async () => ({
      id: MANAGED_AGENT_ID,
      character_id: RUNTIME_AGENT_ID,
      execution_tier: "dedicated-always" as const,
    }));
    const legacyServerUrl = "https://legacy-agent.internal:3000";
    const routingRedis = installRoutingRedis(
      new Map([
        [`agent:${RUNTIME_AGENT_ID}:server`, "legacy-agent"],
        ["server:legacy-agent:url", legacyServerUrl],
      ]),
    );
    const fetchRequest = mock(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        Response.json({ ok: true }),
    );
    globalThis.fetch = fetchRequest as unknown as typeof fetch;

    const response = await handleWorkflowProxyRequest(
      workflowRequest(),
      MANAGED_AGENT_ID,
      "generate",
      context({ AGENT_SERVER_SHARED_SECRET: "server-secret" }),
    );

    expect(response.status).toBe(200);
    const readKeys = routingRedis.evalRo.mock.calls.flatMap((call) => call[1]);
    expect(readKeys).toContain(`agent:${RUNTIME_AGENT_ID}:server`);
    expect(readKeys).not.toContain(`agent:${MANAGED_AGENT_ID}:server`);
    expect(String(fetchRequest.mock.calls[0]?.[0])).toBe(
      `${legacyServerUrl}/agents/${RUNTIME_AGENT_ID}/workflows/generate`,
    );
    expect(routingRedis.evalWrite).not.toHaveBeenCalled();
    expect(routingRedis.get).not.toHaveBeenCalled();
  });
});

describe("workflow principal forwarding", () => {
  test("overwrites caller identity headers with the authenticated principal", async () => {
    getAgent.mockImplementation(async () => ({
      id: MANAGED_AGENT_ID,
      character_id: RUNTIME_AGENT_ID,
      execution_tier: "dedicated-always" as const,
    }));
    const routingRedis = installRoutingRedis();
    const fetchRequest = mock(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        Response.json({ ok: true }),
    );
    globalThis.fetch = fetchRequest as unknown as typeof fetch;

    const response = await handleWorkflowProxyRequest(
      new Request(
        `https://api.example.test/api/v1/eliza/agents/${MANAGED_AGENT_ID}/workflows/resolve-clarification`,
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
      MANAGED_AGENT_ID,
      "resolve-clarification",
      context({ AGENT_SERVER_SHARED_SECRET: "server-secret" }),
    );

    expect(response.status).toBe(200);
    expect(fetchRequest).toHaveBeenCalledTimes(1);
    const call = fetchRequest.mock.calls as unknown as Array<
      [RequestInfo | URL, RequestInit]
    >;
    expect(String(call[0]?.[0])).toBe(
      `${MANAGED_SERVER_URL}agents/${RUNTIME_AGENT_ID}/workflows/resolve-clarification`,
    );
    expect(routingRedis.evalRo).toHaveBeenCalledTimes(3);
    expect(routingRedis.evalWrite).not.toHaveBeenCalled();
    expect(routingRedis.get).not.toHaveBeenCalled();
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
      id: MANAGED_AGENT_ID,
      character_id: RUNTIME_AGENT_ID,
      execution_tier: "dedicated-always" as const,
    }));
    const routingRedis = installRoutingRedis();
    const fetchRequest = mock(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        Response.json({ workflowId: "workflow-1" }),
    );
    globalThis.fetch = fetchRequest as unknown as typeof fetch;

    const response = await handleWorkflowProxyRequest(
      new Request(
        `https://api.example.test/api/v1/eliza/agents/${MANAGED_AGENT_ID}/workflows/workflow-1/evaluation-samples?limit=7`,
      ),
      MANAGED_AGENT_ID,
      "workflow-1/evaluation-samples",
      context({ AGENT_SERVER_SHARED_SECRET: "server-secret" }),
    );

    expect(response.status).toBe(200);
    const call = fetchRequest.mock.calls as unknown as Array<
      [RequestInfo | URL, RequestInit]
    >;
    expect(String(call[0]?.[0])).toBe(
      `${MANAGED_SERVER_URL}agents/${RUNTIME_AGENT_ID}/workflows/workflow-1/evaluation-samples?limit=7`,
    );
    expect(routingRedis.evalRo).toHaveBeenCalledTimes(3);
    expect(routingRedis.evalWrite).not.toHaveBeenCalled();
    expect(routingRedis.get).not.toHaveBeenCalled();
    expect(call[0]?.[1].method).toBe("GET");
    expect(call[0]?.[1].body).toBeUndefined();
    const forwardedHeaders = new Headers(call[0]?.[1].headers);
    expect(forwardedHeaders.get("x-eliza-user-id")).toBe("user-1");
    expect(forwardedHeaders.get("x-eliza-organization-id")).toBe("org-1");
  });
});
