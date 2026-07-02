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
const authenticateWaifuBridge = mock(async () => null);

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

class AgentQuotaExceededError extends Error {}

mock.module("../compat/_lib/auth", () => ({
  requireCompatAuth,
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
