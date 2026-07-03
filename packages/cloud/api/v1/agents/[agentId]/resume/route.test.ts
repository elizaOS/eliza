import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

const requireServiceKey = mock(async () => ({
  organizationId: "service-org",
  userId: "service-user",
}));
const getAgentById = mock(async () => ({
  id: "cloud-agent-1",
  organization_id: "agent-org",
}));
const provision = mock(async () => ({
  success: true,
  sandboxRecord: { status: "running" },
}));
const reactivateSandboxBillingAfterFunding = mock(async () => undefined);
const checkAgentCreditGate = mock(async () => ({
  allowed: false,
  balance: 0,
  error: "Insufficient credits",
}));

class AgentQuotaExceededError extends Error {}

mock.module("@/lib/auth/service-key-hono-worker", () => ({
  requireServiceKey,
}));

mock.module("@/db/repositories/agent-billing", () => ({
  agentBillingRepository: {
    reactivateSandboxBillingAfterFunding,
  },
}));

mock.module("@/lib/services/agent-billing-gate", () => ({
  checkAgentCreditGate,
}));

mock.module("@/lib/services/eliza-sandbox", () => ({
  AgentQuotaExceededError,
  elizaSandboxService: {
    getAgentById,
    provision,
  },
}));

mock.module("@/lib/utils/logger", () => ({
  logger: {
    info: mock(() => undefined),
    warn: mock(() => undefined),
    error: mock(() => undefined),
  },
}));

const { default: resumeRoute } = await import("./route");

describe("service agent resume route", () => {
  const app = new Hono();
  app.route("/api/v1/agents/:agentId/resume", resumeRoute);

  beforeEach(() => {
    requireServiceKey.mockClear();
    getAgentById.mockClear();
    provision.mockClear();
    reactivateSandboxBillingAfterFunding.mockClear();
    checkAgentCreditGate.mockClear();
    checkAgentCreditGate.mockResolvedValue({
      allowed: false,
      balance: 0,
      error: "Insufficient credits",
    });
  });

  test("blocks service-key resume when the agent wallet org has insufficient credits", async () => {
    const response = await app.fetch(
      new Request(
        "https://api.example.test/api/v1/agents/cloud-agent-1/resume",
        {
          method: "POST",
          headers: { "X-Service-Key": "svc" },
        },
      ),
      { WAIFU_SERVICE_KEY: "svc" },
    );

    expect(response.status).toBe(402);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      code: "insufficient_credits",
      error: "Insufficient credits",
      requiredBalance: 0.1,
      currentBalance: 0,
    });
    expect(checkAgentCreditGate).toHaveBeenCalledWith("agent-org");
    expect(provision).not.toHaveBeenCalled();
    expect(reactivateSandboxBillingAfterFunding).not.toHaveBeenCalled();
  });

  test("reactivates billing after funded service-key resume provisions the agent", async () => {
    checkAgentCreditGate.mockResolvedValueOnce({
      allowed: true,
      balance: 5,
      error: "",
    });

    const response = await app.fetch(
      new Request(
        "https://api.example.test/api/v1/agents/cloud-agent-1/resume",
        {
          method: "POST",
          headers: { "X-Service-Key": "svc" },
        },
      ),
      { WAIFU_SERVICE_KEY: "svc" },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      status: "running",
    });
    expect(provision).toHaveBeenCalledWith("cloud-agent-1", "agent-org");
    expect(reactivateSandboxBillingAfterFunding).toHaveBeenCalledWith(
      "cloud-agent-1",
      expect.any(Date),
    );
  });
});
