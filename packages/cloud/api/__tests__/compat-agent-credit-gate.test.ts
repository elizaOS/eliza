// Exercises cloud API tests compat agent credit gate.test behavior with deterministic Worker route fixtures.
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

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

const getAgent = mock(async () => ({
  id: "agent-1",
  organization_id: "org-1",
}));

const getAgentForWrite = mock(
  async (): Promise<{
    id: string;
    organization_id: string;
    status: string;
  } | null> => ({
    id: "agent-1",
    organization_id: "org-1",
    status: "stopped",
  }),
);

const defaultWritableAgent = {
  id: "agent-1",
  organization_id: "org-1",
  status: "stopped",
};

const provision = mock(async () => ({
  success: true,
  sandboxRecord: { status: "running" },
}));

const snapshot = mock(async () => undefined);

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
    maxNonTerminalAgents?: number;
  }) => ({
    agent: createdSandboxRow,
    idempotent: false,
  }),
);

// launch/route.ts calls launchManagedElizaAgent (which itself wraps provision),
// not elizaSandboxService.provision directly — mock it at that seam.
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
  AgentQuotaExceededError,
  elizaSandboxService: {
    getAgent,
    getAgentForWrite,
    provision,
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
    getAgent.mockClear();
    getAgent.mockResolvedValue({
      id: "agent-1",
      organization_id: "org-1",
    });
    getAgentForWrite.mockClear();
    getAgentForWrite.mockResolvedValue(defaultWritableAgent);
    provision.mockClear();
    snapshot.mockClear();
    launchManagedElizaAgent.mockClear();
    prepareManagedElizaEnvironment.mockClear();
  });

  test("blocks compat resume before provisioning when the org has insufficient credits", async () => {
    const response = await app.fetch(
      new Request("https://api.example.test/api/compat/agents/agent-1/resume", {
        method: "POST",
      }),
    );

    expect(response.status).toBe(402);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: "Insufficient credits",
    });
    expect(getAgentForWrite).toHaveBeenCalledWith("agent-1", "org-1");
    expect(checkAgentCreditGate).toHaveBeenCalledWith("org-1");
    expect(provision).not.toHaveBeenCalled();
  });

  test("blocks compat restart before snapshot/provision when the org has insufficient credits", async () => {
    const response = await app.fetch(
      new Request(
        "https://api.example.test/api/compat/agents/agent-1/restart",
        {
          method: "POST",
        },
      ),
    );

    expect(response.status).toBe(402);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: "Insufficient credits",
    });
    expect(getAgent).toHaveBeenCalledWith("agent-1", "org-1");
    expect(checkAgentCreditGate).toHaveBeenCalledWith("org-1");
    expect(snapshot).not.toHaveBeenCalled();
    expect(provision).not.toHaveBeenCalled();
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

  test("does not check credits when the compat agent lookup fails", async () => {
    getAgentForWrite.mockResolvedValueOnce(null);

    const response = await app.fetch(
      new Request("https://api.example.test/api/compat/agents/missing/resume", {
        method: "POST",
      }),
    );

    expect(response.status).toBe(404);
    expect(checkAgentCreditGate).not.toHaveBeenCalled();
    expect(provision).not.toHaveBeenCalled();
  });

  test("allows funded compat resume and restart to reach sandbox operations", async () => {
    checkAgentCreditGate.mockResolvedValue({
      allowed: true,
      balance: 5,
      error: "",
    });

    const resumeResponse = await app.fetch(
      new Request("https://api.example.test/api/compat/agents/agent-1/resume", {
        method: "POST",
      }),
    );
    const restartResponse = await app.fetch(
      new Request(
        "https://api.example.test/api/compat/agents/agent-1/restart",
        {
          method: "POST",
        },
      ),
    );

    expect(resumeResponse.status).toBe(200);
    expect(restartResponse.status).toBe(200);
    expect(provision).toHaveBeenCalledWith("agent-1", "org-1");
    expect(snapshot).toHaveBeenCalledWith("agent-1", "org-1");
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
      maxNonTerminalAgents: 20,
    });
    // Compat stays multi-agent-per-org: the reuse guard must remain OFF.
    expect(
      (createAgent.mock.calls[0]?.[0] as Record<string, unknown>)
        .reuseExistingNonTerminal,
    ).toBeUndefined();
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
    expect(
      (createAgent.mock.calls[0]?.[0] as Record<string, unknown>)
        .maxNonTerminalAgents,
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
    expect(
      (createAgent.mock.calls[0]?.[0] as Record<string, unknown>)
        .maxNonTerminalAgents,
    ).toBeUndefined();
  });
});
