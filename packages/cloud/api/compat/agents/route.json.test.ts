/** Exercises malformed request input with deterministic route collaborators. */
import { describe, expect, mock, test } from "bun:test";

const createAgent = mock(async () => ({
  agent: {
    id: "agent-1",
    agent_name: "demo",
    lifecycle_revision: 1,
    organization_id: "org-1",
  },
}));

mock.module("@/lib/auth/service-key-hono-worker", () => ({
  validateServiceKey: async () => null,
}));

mock.module("@/lib/auth/waifu-bridge", () => ({
  authenticateWaifuBridge: async () => null,
}));

mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireUserOrApiKeyWithOrg: async () => ({
    id: "user-1",
    organization_id: "org-1",
  }),
}));

mock.module("@/lib/services/agent-billing-gate", () => ({
  checkAgentCreditGate: async () => ({ allowed: true, balance: 100 }),
}));

mock.module("@/lib/constants/agent-sandbox-quota", () => ({
  getMaxNonTerminalAgentsForOrg: () => 10,
}));

mock.module("@/lib/services/eliza-agent-config", () => ({
  stripReservedElizaConfigKeys: (config: unknown) => config,
}));

mock.module("@/lib/services/eliza-sandbox", () => ({
  AgentImageNotAllowedError: class AgentImageNotAllowedError extends Error {},
  AgentQuotaExceededError: class AgentQuotaExceededError extends Error {},
  elizaSandboxService: { createAgent },
}));

mock.module("@/lib/services/provisioning-jobs", () => ({
  provisioningJobService: {
    enqueueAgentProvisionOnce: async () => ({ job: { id: "job-1" } }),
  },
}));

mock.module("@/lib/services/provisioning-worker-health", () => ({
  checkProvisioningWorkerHealth: async () => ({ ok: true }),
  provisioningWorkerFailureBody: () => ({ error: "unused" }),
}));

mock.module("@/lib/api/compat-envelope", () => ({
  envelope: (data: unknown) => ({ success: true, data }),
  errorEnvelope: (error: string) => ({ success: false, error }),
  toCompatAgent: (agent: unknown) => agent,
  toCompatCreateResult: (agent: { id: string }) => ({ id: agent.id }),
}));

mock.module("@/lib/utils/logger", () => ({
  logger: {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  },
}));

const { default: app } = await import("./route");

const env = { WAIFU_AUTO_PROVISION: "false" };

describe("POST /api/compat/agents malformed JSON", () => {
  test("returns 400 instead of 500 and never creates an agent", async () => {
    const response = await app.request(
      "/",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{",
      },
      env,
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "Invalid JSON body",
    });
    expect(createAgent).not.toHaveBeenCalled();
  });

  test("canonical JSON still creates an agent", async () => {
    const response = await app.request(
      "/",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agentName: "demo" }),
      },
      env,
    );
    expect(response.status).toBe(201);
    expect(createAgent).toHaveBeenCalled();
  });
});
