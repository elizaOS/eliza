// Exercises cloud API v1 agents agentid resume route.test behavior with deterministic Worker route fixtures.
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

const requireServiceKey = mock(async () => ({
  organizationId: "service-org",
  userId: "service-user",
}));
const getAgentById = mock(
  async (): Promise<{
    id: string;
    organization_id: string;
    status: string;
    execution_tier: unknown;
  }> => ({
    id: "cloud-agent-1",
    organization_id: "agent-org",
    status: "stopped",
    execution_tier: "dedicated-lazy",
  }),
);
const getAgentForWrite = mock(
  async (): Promise<{
    id: string;
    organization_id: string;
    status: string;
  } | null> => ({
    id: "cloud-agent-1",
    organization_id: "agent-org",
    status: "stopped",
  }),
);
const provision = mock(async () => ({
  success: true,
  sandboxRecord: { status: "running" },
}));
const executeResume = mock(
  async (): Promise<{
    success: boolean;
    containerStarted: boolean;
    reprovisioned: boolean;
    error?: string;
  }> => ({
    success: true,
    containerStarted: true,
    reprovisioned: true,
  }),
);
const reactivateSandboxBillingAfterFunding = mock(async () => undefined);
const settleAccruedBillingBeforeLifecycle = mock(async () => ({
  status: "already_billed_recently" as const,
}));
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
    settleAccruedBillingBeforeLifecycle,
  },
}));

mock.module("@/lib/services/agent-billing-gate", () => ({
  checkAgentCreditGate,
}));

mock.module("@/lib/services/eliza-sandbox", () => ({
  AgentQuotaExceededError,
  elizaSandboxService: {
    executeResume,
    getAgentById,
    getAgentForWrite,
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
    getAgentById.mockResolvedValue({
      id: "cloud-agent-1",
      organization_id: "agent-org",
      status: "stopped",
      execution_tier: "dedicated-lazy",
    });
    getAgentForWrite.mockClear();
    getAgentForWrite.mockResolvedValue({
      id: "cloud-agent-1",
      organization_id: "agent-org",
      status: "stopped",
    });
    executeResume.mockClear();
    executeResume.mockResolvedValue({
      success: true,
      containerStarted: true,
      reprovisioned: true,
    });
    provision.mockClear();
    reactivateSandboxBillingAfterFunding.mockClear();
    settleAccruedBillingBeforeLifecycle.mockClear();
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
    expect(executeResume).not.toHaveBeenCalled();
    expect(provision).not.toHaveBeenCalled();
    expect(settleAccruedBillingBeforeLifecycle).not.toHaveBeenCalled();
    expect(reactivateSandboxBillingAfterFunding).not.toHaveBeenCalled();
  });

  for (const [label, executionTier] of [
    ["shared", "shared"],
    ["unknown", "future-container-tier"],
    ["corrupt", { tier: "custom" }],
    ["missing", undefined],
  ] as const) {
    test(`rejects ${label} tier before credit, billing, or provision`, async () => {
      getAgentById.mockResolvedValueOnce({
        id: "cloud-agent-1",
        organization_id: "agent-org",
        status: "stopped",
        execution_tier: executionTier,
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

      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toMatchObject({
        success: false,
        status: "stopped",
        error:
          "Sandbox provisioning requires an explicit container-backed execution tier",
      });
      expect(checkAgentCreditGate).not.toHaveBeenCalled();
      expect(executeResume).not.toHaveBeenCalled();
      expect(settleAccruedBillingBeforeLifecycle).not.toHaveBeenCalled();
      expect(provision).not.toHaveBeenCalled();
      expect(reactivateSandboxBillingAfterFunding).not.toHaveBeenCalled();
    });
  }

  test("delegates funded service-key resume to the authoritative lifecycle service", async () => {
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
    expect(executeResume).toHaveBeenCalledWith("cloud-agent-1", "agent-org");
    expect(getAgentForWrite).not.toHaveBeenCalled();
    expect(provision).not.toHaveBeenCalled();
    expect(settleAccruedBillingBeforeLifecycle).not.toHaveBeenCalled();
    expect(reactivateSandboxBillingAfterFunding).not.toHaveBeenCalled();
  });

  test("preserves the insufficient-settlement response from executeResume", async () => {
    checkAgentCreditGate.mockResolvedValueOnce({
      allowed: true,
      balance: 5,
      error: "",
    });
    executeResume.mockResolvedValueOnce({
      success: false,
      containerStarted: false,
      reprovisioned: false,
      error: "Insufficient credits to settle accrued agent compute charges",
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

    expect(response.status).toBe(402);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      status: "stopped",
      error: "Insufficient credits to settle accrued agent compute charges",
    });
    expect(executeResume).toHaveBeenCalledWith("cloud-agent-1", "agent-org");
    expect(getAgentForWrite).not.toHaveBeenCalled();
    expect(provision).not.toHaveBeenCalled();
    expect(settleAccruedBillingBeforeLifecycle).not.toHaveBeenCalled();
  });

  test("reports the authoritative primary status after resume mutates then fails", async () => {
    checkAgentCreditGate.mockResolvedValueOnce({
      allowed: true,
      balance: 5,
      error: "",
    });
    executeResume.mockResolvedValueOnce({
      success: false,
      containerStarted: false,
      reprovisioned: true,
      error: "Provisioning failed after lifecycle mutation",
    });
    getAgentForWrite.mockResolvedValueOnce({
      id: "cloud-agent-1",
      organization_id: "agent-org",
      status: "error",
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

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      status: "error",
      error: "Provisioning failed after lifecycle mutation",
    });
    expect(getAgentForWrite).toHaveBeenCalledWith("cloud-agent-1", "agent-org");
  });
});
