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

mock.module("../../../_lib/auth", () => ({
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
  elizaSandboxService: {
    getAgent,
    getAgentForWrite,
    provision,
    snapshot,
  },
}));

mock.module("@/lib/utils/logger", () => ({
  logger: {
    info: mock(() => undefined),
    warn: mock(() => undefined),
    error: mock(() => undefined),
  },
}));

const { default: resumeRoute } = await import("./resume/route");
const { default: restartRoute } = await import("./restart/route");

describe("compat agent resume/restart credit gate", () => {
  const app = new Hono();
  app.route("/api/compat/agents/:id/resume", resumeRoute);
  app.route("/api/compat/agents/:id/restart", restartRoute);

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
});
