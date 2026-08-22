/** Exercises compat agent credit and placement gates with deterministic Worker fixtures. */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import { CONTAINER_BACKED_EXECUTION_TIERS } from "@/db/schemas/agent-sandboxes";

const requireCompatAuth = mock(async () => ({
  user: {
    id: "user-1",
    organization_id: "org-1",
  },
  authMethod: "standard" as const,
}));

const requireAuthOrApiKeyWithOrg = mock(async () => ({
  user: {
    id: "user-1",
    organization_id: "org-1",
  },
}));
const requireServiceKey = mock(() => ({
  organizationId: "org-1",
  userId: "user-1",
}));
type WaifuBridgeAuth = {
  user: {
    id: string;
    organization_id: string;
  };
} | null;
const authenticateWaifuBridge = mock(
  async (): Promise<WaifuBridgeAuth> => null,
);

// create route (compat/agents/route.ts) does its own inline compat auth via
// these seams instead of compat/_lib/auth.
const validateServiceKey = mock(async () => ({
  organizationId: "org-1",
  userId: "svc-user-1",
}));
const requireUserOrApiKeyWithOrg = mock(async () => ({
  id: "user-1",
  organization_id: "org-1",
}));

const checkAgentCreditGate = mock(async () => ({
  allowed: false,
  balance: 0,
  error: "Insufficient credits",
}));

type WritableAgentFixture = {
  id: string;
  organization_id: string;
  status: string;
  execution_tier: string;
  pool_status: string | null;
  deleted_at: Date | null;
  deletion_attempt_id: string | null;
};

const defaultWritableAgent: WritableAgentFixture = {
  id: "agent-1",
  organization_id: "org-1",
  status: "stopped",
  execution_tier: "dedicated-lazy",
  pool_status: null,
  deleted_at: null,
  deletion_attempt_id: null,
};

const getAgentForWrite = mock(
  async (
    _agentId: string,
    _organizationId: string,
  ): Promise<WritableAgentFixture | null> => defaultWritableAgent,
);

const lifecycleOperationOrder: string[] = [];

const executeResume = mock(async () => {
  lifecycleOperationOrder.push("resume");
  return { success: true };
});

const snapshot = mock(async () => {
  lifecycleOperationOrder.push("snapshot");
});

const executeRestart = mock(async () => {
  lifecycleOperationOrder.push("restart");
  return { success: true };
});

const createdSandboxRow = {
  id: "agent-new",
  agent_name: "Agent One",
  status: "pending",
  node_id: null,
  database_status: "pending",
  error_message: null,
  last_heartbeat_at: null,
  agent_config: {},
  created_at: "2026-07-02T00:00:00.000Z",
  updated_at: "2026-07-02T00:00:00.000Z",
};

const createAgent = mock(
  async (_params: {
    organizationId: string;
    userId: string;
    agentName: string;
    executionTier: "shared" | "dedicated-always";
    maxNonTerminalAgents?: number;
  }) => ({
    agent: createdSandboxRow,
    idempotent: false,
  }),
);

// launch/route.ts calls launchManagedElizaAgent, so mock it at that seam.
const launchManagedElizaAgent = mock(async () => ({
  agentId: "agent-1",
  agentName: "Agent One",
  appUrl: "https://app.example.test/launch/agent-1",
  launchSessionId: "sess-1",
  issuedAt: "2026-07-02T00:00:00.000Z",
  connection: { host: "agent-1.example.test" },
}));
const prepareManagedElizaEnvironment = mock(async () => ({
  changed: false,
  environmentVars: {},
}));

class AgentQuotaExceededError extends Error {
  readonly count: number;
  readonly max: number;
  constructor(count = 20, max = 20) {
    super(
      `Agent quota exceeded: your organization already has ${count} active agents (limit ${max}).`,
    );
    this.name = "AgentQuotaExceededError";
    this.count = count;
    this.max = max;
  }
}

class AgentImageNotAllowedError extends Error {
  readonly image: string;
  readonly reason: "not_allowlisted" | "not_digest_pinned";

  constructor(image: string, reason: "not_allowlisted" | "not_digest_pinned") {
    super(
      `Docker image '${image}' is not in the managed-agent image allowlist.`,
    );
    this.name = "AgentImageNotAllowedError";
    this.image = image;
    this.reason = reason;
  }
}

mock.module("../compat/_lib/auth", () => ({
  requireCompatAuth,
}));

mock.module("@/lib/auth/service-key-hono-worker", () => ({
  validateServiceKey,
}));

mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireUserOrApiKeyWithOrg,
}));

mock.module("@/lib/services/eliza-agent-config", () => ({
  stripReservedElizaConfigKeys: (config: Record<string, unknown> | undefined) =>
    config,
}));

mock.module("@/lib/services/provisioning-jobs", () => ({
  provisioningJobService: {
    enqueueAgentProvisionOnce: mock(async () => ({ job: { id: "job-1" } })),
  },
}));

mock.module("@/lib/services/provisioning-worker-health", () => ({
  checkProvisioningWorkerHealth: mock(async () => ({ ok: true })),
  provisioningWorkerFailureBody: () => ({
    success: false,
    error: "provisioning worker unavailable",
  }),
}));

mock.module("@/lib/auth", () => ({
  requireAuthOrApiKeyWithOrg,
}));

mock.module("@/lib/auth/service-key", () => ({
  ServiceKeyAuthError: class ServiceKeyAuthError extends Error {},
  requireServiceKey,
}));

mock.module("@/lib/auth/waifu-bridge", () => ({
  authenticateWaifuBridge,
}));

mock.module("@/lib/services/agent-billing-gate", () => ({
  checkAgentCreditGate,
}));

mock.module("@/lib/services/eliza-sandbox", () => ({
  AgentImageNotAllowedError,
  AgentQuotaExceededError,
  elizaSandboxService: {
    getAgentForWrite,
    executeResume,
    executeRestart,
    snapshot,
    createAgent,
  },
}));

mock.module("@/lib/services/eliza-managed-launch", () => ({
  launchManagedElizaAgent,
  prepareManagedElizaEnvironment,
  ManagedElizaLaunchError: class ManagedElizaLaunchError extends Error {
    status = 400;
  },
}));

mock.module("@/lib/utils/logger", () => ({
  logger: {
    info: mock(() => undefined),
    warn: mock(() => undefined),
    error: mock(() => undefined),
  },
}));

const { default: resumeRoute } = await import(
  "../compat/agents/[id]/resume/route"
);
const { default: restartRoute } = await import(
  "../compat/agents/[id]/restart/route"
);
const { default: launchRoute } = await import(
  "../compat/agents/[id]/launch/route"
);
const { default: agentsRoute } = await import("../compat/agents/route");

describe("compat agent resume/restart/launch credit gate", () => {
  const app = new Hono();
  app.route("/api/compat/agents/:id/resume", resumeRoute);
  app.route("/api/compat/agents/:id/restart", restartRoute);
  app.route("/api/compat/agents/:id/launch", launchRoute);

  const lifecycleRequest = (agentId: string, action: "resume" | "restart") =>
    new Request(
      `https://api.example.test/api/compat/agents/${agentId}/${action}`,
      { method: "POST" },
    );

  beforeEach(() => {
    requireCompatAuth.mockClear();
    requireAuthOrApiKeyWithOrg.mockClear();
    requireServiceKey.mockClear();
    authenticateWaifuBridge.mockClear();
    authenticateWaifuBridge.mockResolvedValue(null);
    checkAgentCreditGate.mockClear();
    checkAgentCreditGate.mockResolvedValue({
      allowed: false,
      balance: 0,
      error: "Insufficient credits",
    });
    getAgentForWrite.mockClear();
    getAgentForWrite.mockResolvedValue(defaultWritableAgent);
    executeResume.mockClear();
    executeRestart.mockClear();
    snapshot.mockClear();
    lifecycleOperationOrder.length = 0;
    launchManagedElizaAgent.mockClear();
    prepareManagedElizaEnvironment.mockClear();
  });

  test("blocks compat resume before execution when the org has insufficient credits", async () => {
    const response = await app.fetch(lifecycleRequest("agent-1", "resume"));

    expect(response.status).toBe(402);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: "Insufficient credits",
    });
    expect(getAgentForWrite).toHaveBeenCalledWith("agent-1", "org-1");
    expect(checkAgentCreditGate).toHaveBeenCalledWith("org-1");
    expect(executeResume).not.toHaveBeenCalled();
  });

  test("blocks compat restart before snapshot and execution when the org has insufficient credits", async () => {
    const response = await app.fetch(lifecycleRequest("agent-1", "restart"));

    expect(response.status).toBe(402);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: "Insufficient credits",
    });
    expect(getAgentForWrite).toHaveBeenCalledWith("agent-1", "org-1");
    expect(checkAgentCreditGate).toHaveBeenCalledWith("org-1");
    expect(snapshot).not.toHaveBeenCalled();
    expect(executeRestart).not.toHaveBeenCalled();
  });

  test("blocks compat launch before provisioning when the org has insufficient credits (elizaOS/eliza#11152)", async () => {
    const response = await app.fetch(
      new Request("https://api.example.test/api/compat/agents/agent-1/launch", {
        method: "POST",
      }),
    );

    expect(response.status).toBe(402);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: "Insufficient credits",
    });
    expect(checkAgentCreditGate).toHaveBeenCalledWith("org-1");
    expect(launchManagedElizaAgent).not.toHaveBeenCalled();
  });

  test("uses tenant-scoped primary lookups and performs no effects for missing or foreign agents", async () => {
    const cases = [
      {
        agentId: "missing-resume",
        action: "resume" as const,
        organizationId: "org-1",
      },
      {
        agentId: "foreign-resume",
        action: "resume" as const,
        organizationId: "org-foreign",
      },
      {
        agentId: "missing-restart",
        action: "restart" as const,
        organizationId: "org-1",
      },
      {
        agentId: "foreign-restart",
        action: "restart" as const,
        organizationId: "org-foreign",
      },
    ];

    for (const { agentId, action, organizationId } of cases) {
      requireCompatAuth.mockResolvedValueOnce({
        user: { id: "user-1", organization_id: organizationId },
        authMethod: "standard",
      });
      getAgentForWrite.mockResolvedValueOnce(null);

      const response = await app.fetch(lifecycleRequest(agentId, action));

      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toMatchObject({
        success: false,
        error: "Agent not found",
      });
    }

    expect(getAgentForWrite.mock.calls).toEqual(
      cases.map(({ agentId, organizationId }) => [agentId, organizationId]),
    );
    expect(checkAgentCreditGate).not.toHaveBeenCalled();
    expect(snapshot).not.toHaveBeenCalled();
    expect(executeResume).not.toHaveBeenCalled();
    expect(executeRestart).not.toHaveBeenCalled();
  });

  test("rejects ineligible lifecycle authority before credit or sandbox effects", async () => {
    const refusalCases: Array<{
      label: string;
      patch: Partial<WritableAgentFixture>;
      message: string;
    }> = [
      {
        label: "unknown-tier",
        patch: { execution_tier: "future-container-tier" },
        message: "requires a container-backed execution tier",
      },
      {
        label: "shared-tier",
        patch: { execution_tier: "shared" },
        message: "requires a container-backed execution tier",
      },
      {
        label: "pool-owned",
        patch: { pool_status: "unclaimed" },
        message: "cannot target pool-owned capacity",
      },
      {
        label: "deleted",
        patch: { deleted_at: new Date("2026-08-22T00:00:00.000Z") },
        message: "cannot target a deleted agent",
      },
      {
        label: "deletion-owned",
        patch: {
          deletion_attempt_id: "00000000-0000-4000-8000-000000000001",
        },
        message: "cannot start while agent deletion is in progress",
      },
    ];

    for (const action of ["resume", "restart"] as const) {
      for (const refusal of refusalCases) {
        const agentId = `${action}-${refusal.label}`;
        getAgentForWrite.mockResolvedValueOnce({
          ...defaultWritableAgent,
          id: agentId,
          status: "running",
          ...refusal.patch,
        });

        const response = await app.fetch(lifecycleRequest(agentId, action));

        expect(response.status).toBe(409);
        await expect(response.json()).resolves.toMatchObject({
          success: false,
          error: `Agent ${action} ${refusal.message}`,
        });
      }
    }

    expect(getAgentForWrite).toHaveBeenCalledTimes(10);
    expect(checkAgentCreditGate).not.toHaveBeenCalled();
    expect(snapshot).not.toHaveBeenCalled();
    expect(executeResume).not.toHaveBeenCalled();
    expect(executeRestart).not.toHaveBeenCalled();
  });

  test("allows every canonical container tier to reach resume and ordered restart operations", async () => {
    checkAgentCreditGate.mockResolvedValue({
      allowed: true,
      balance: 5,
      error: "",
    });

    for (const executionTier of CONTAINER_BACKED_EXECUTION_TIERS) {
      const agentId = `agent-${executionTier}`;
      getAgentForWrite.mockResolvedValueOnce({
        ...defaultWritableAgent,
        id: agentId,
        status: "stopped",
        execution_tier: executionTier,
      });
      const resumeResponse = await app.fetch(
        lifecycleRequest(agentId, "resume"),
      );

      getAgentForWrite.mockResolvedValueOnce({
        ...defaultWritableAgent,
        id: agentId,
        status: "running",
        execution_tier: executionTier,
      });
      const restartResponse = await app.fetch(
        lifecycleRequest(agentId, "restart"),
      );

      expect(resumeResponse.status).toBe(200);
      expect(restartResponse.status).toBe(200);
      expect(executeResume).toHaveBeenCalledWith(agentId, "org-1");
      expect(snapshot).toHaveBeenCalledWith(agentId, "org-1");
      expect(executeRestart).toHaveBeenCalledWith(agentId, "org-1");
    }

    expect(getAgentForWrite).toHaveBeenCalledTimes(6);
    expect(checkAgentCreditGate).toHaveBeenCalledTimes(6);
    expect(executeResume).toHaveBeenCalledTimes(3);
    expect(snapshot).toHaveBeenCalledTimes(3);
    expect(executeRestart).toHaveBeenCalledTimes(3);
    expect(lifecycleOperationOrder).toEqual(
      CONTAINER_BACKED_EXECUTION_TIERS.flatMap(() => [
        "resume",
        "snapshot",
        "restart",
      ]),
    );
  });

  test("allows funded compat launch to reach launchManagedElizaAgent", async () => {
    checkAgentCreditGate.mockResolvedValue({
      allowed: true,
      balance: 5,
      error: "",
    });

    const response = await app.fetch(
      new Request("https://api.example.test/api/compat/agents/agent-1/launch", {
        method: "POST",
      }),
    );

    expect(response.status).toBe(200);
    expect(checkAgentCreditGate).toHaveBeenCalledWith("org-1");
    expect(launchManagedElizaAgent).toHaveBeenCalledWith({
      agentId: "agent-1",
      organizationId: "org-1",
      userId: "user-1",
    });
  });
});

describe("compat agent create credit + quota gate (elizaOS/eliza#11678)", () => {
  const app = new Hono();
  app.route("/api/compat/agents", agentsRoute);

  const createRequest = (headers: Record<string, string> = {}) =>
    new Request("https://api.example.test/api/compat/agents", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ agentName: "Agent One" }),
    });

  beforeEach(() => {
    authenticateWaifuBridge.mockClear();
    authenticateWaifuBridge.mockResolvedValue(null);
    validateServiceKey.mockClear();
    validateServiceKey.mockResolvedValue({
      organizationId: "org-1",
      userId: "svc-user-1",
    });
    requireUserOrApiKeyWithOrg.mockClear();
    requireUserOrApiKeyWithOrg.mockResolvedValue({
      id: "user-1",
      organization_id: "org-1",
    });
    checkAgentCreditGate.mockClear();
    checkAgentCreditGate.mockResolvedValue({
      allowed: false,
      balance: 0,
      error: "Insufficient credits",
    });
    createAgent.mockClear();
    createAgent.mockResolvedValue({
      agent: createdSandboxRow,
      idempotent: false,
    });
  });

  test("blocks a standard-auth compat create with 402 before any row is minted when the org has insufficient credits", async () => {
    const response = await app.fetch(createRequest(), {});

    expect(response.status).toBe(402);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: "Insufficient credits",
    });
    expect(checkAgentCreditGate).toHaveBeenCalledWith("org-1");
    expect(createAgent).not.toHaveBeenCalled();
  });

  test("caps a funded standard-auth compat create with the balance-tiered maxNonTerminalAgents", async () => {
    checkAgentCreditGate.mockResolvedValue({
      allowed: true,
      balance: 5,
      error: "",
    });

    const response = await app.fetch(createRequest(), {});

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: { agentId: "agent-new" },
    });
    expect(checkAgentCreditGate).toHaveBeenCalledWith("org-1");
    expect(createAgent).toHaveBeenCalledTimes(1);
    // $5 balance → the 20-agent tier (getMaxNonTerminalAgentsForOrg).
    expect(createAgent.mock.calls[0]?.[0]).toMatchObject({
      organizationId: "org-1",
      userId: "user-1",
      agentName: "Agent One",
      executionTier: "shared",
      maxNonTerminalAgents: 20,
    });
    // Compat stays multi-agent-per-org: the reuse guard must remain OFF.
    const standardCreateCall = createAgent.mock.calls[0];
    expect(standardCreateCall).toBeDefined();
    if (!standardCreateCall) {
      throw new Error("Expected the standard-auth agent creation call");
    }
    expect(
      (standardCreateCall[0] as Record<string, unknown>)
        .reuseExistingNonTerminal,
    ).toBeUndefined();
  });

  test("uses an explicit Dedicated tier before compat auto-provision enqueues compute", async () => {
    checkAgentCreditGate.mockResolvedValue({
      allowed: true,
      balance: 5,
      error: "",
    });

    const response = await app.fetch(createRequest(), {
      WAIFU_AUTO_PROVISION: "true",
    });

    expect(response.status).toBe(202);
    expect(createAgent).toHaveBeenCalledTimes(1);
    expect(createAgent.mock.calls[0]?.[0]).toMatchObject({
      executionTier: "dedicated-always",
    });
  });

  test("maps AgentQuotaExceededError from a standard-auth create to 429", async () => {
    checkAgentCreditGate.mockResolvedValue({
      allowed: true,
      balance: 5,
      error: "",
    });
    createAgent.mockImplementationOnce(async () => {
      throw new AgentQuotaExceededError(20, 20);
    });

    const response = await app.fetch(createRequest(), {});

    expect(response.status).toBe(429);
    const body = (await response.json()) as { success: boolean; error: string };
    expect(body.success).toBe(false);
    expect(body.error).toContain("Agent quota exceeded");
  });

  test("does not gate or cap trusted service-key (S2S) creates", async () => {
    const response = await app.fetch(
      createRequest({ "X-Service-Key": "svc-key" }),
      {},
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: { agentId: "agent-new" },
    });
    expect(validateServiceKey).toHaveBeenCalled();
    expect(checkAgentCreditGate).not.toHaveBeenCalled();
    expect(createAgent).toHaveBeenCalledTimes(1);
    const serviceKeyCreateCall = createAgent.mock.calls[0];
    expect(serviceKeyCreateCall).toBeDefined();
    if (!serviceKeyCreateCall) {
      throw new Error("Expected the service-key agent creation call");
    }
    expect(
      (serviceKeyCreateCall[0] as Record<string, unknown>).maxNonTerminalAgents,
    ).toBeUndefined();
    expect(requireUserOrApiKeyWithOrg).not.toHaveBeenCalled();
  });

  test("does not gate or cap trusted service-jwt (waifu-bridge S2S) creates", async () => {
    authenticateWaifuBridge.mockResolvedValue({
      user: { id: "waifu-user-1", organization_id: "org-1" },
    });

    const response = await app.fetch(
      createRequest({ Authorization: "Bearer waifu-jwt" }),
      {},
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: { agentId: "agent-new" },
    });
    expect(authenticateWaifuBridge).toHaveBeenCalled();
    // Trusted bridge path: no credit gate, no quota cap (waifu-core must not break).
    expect(checkAgentCreditGate).not.toHaveBeenCalled();
    expect(createAgent).toHaveBeenCalledTimes(1);
    const serviceJwtCreateCall = createAgent.mock.calls[0];
    expect(serviceJwtCreateCall).toBeDefined();
    if (!serviceJwtCreateCall) {
      throw new Error("Expected the service-JWT agent creation call");
    }
    expect(
      (serviceJwtCreateCall[0] as Record<string, unknown>).maxNonTerminalAgents,
    ).toBeUndefined();
  });
});
