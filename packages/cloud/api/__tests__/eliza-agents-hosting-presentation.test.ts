/** Proves the real agents list route emits server-owned shared-hosting truth. */

import { describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

const requireUserOrApiKeyWithOrg = mock(async () => ({
  id: "user-1",
  organization_id: "org-1",
}));
const findByIdsInOrganization = mock(async () => []);
const getCreditBalanceResponse = mock(async () => ({ balance: 5 }));
const listAgents = mock(async () => [
  {
    id: "11111111-1111-4111-8111-111111111111",
    organization_id: "org-1",
    user_id: "user-1",
    character_id: null,
    agent_name: "Shared one",
    agent_config: {},
    status: "running" as const,
    database_status: "ready" as const,
    billing_status: "active" as const,
    execution_tier: "shared" as const,
    last_backup_at: null,
    last_heartbeat_at: null,
    error_message: null,
    created_at: new Date("2026-06-18T00:00:00.000Z"),
    updated_at: new Date("2026-08-12T00:00:00.000Z"),
    docker_image: null,
  },
  {
    id: "22222222-2222-4222-8222-222222222222",
    organization_id: "org-1",
    user_id: "user-1",
    character_id: null,
    agent_name: "Shared two",
    agent_config: {},
    status: "provisioning" as const,
    database_status: "none" as const,
    billing_status: "active" as const,
    execution_tier: "shared" as const,
    last_backup_at: null,
    last_heartbeat_at: null,
    error_message: null,
    created_at: new Date("2026-06-18T00:00:00.000Z"),
    updated_at: new Date("2026-08-12T00:00:00.000Z"),
    docker_image: null,
  },
]);

mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireUserOrApiKeyWithOrg,
}));
mock.module("@/db/repositories/characters", () => ({
  userCharactersRepository: {
    findByIdsInOrganization,
    findByIdInOrganizationForWrite: mock(async () => undefined),
  },
}));
mock.module("@/lib/services/credit-balance-response", () => ({
  getCreditBalanceResponse,
}));
mock.module("@/db/repositories/agent-sandboxes", () => ({
  agentSandboxesRepository: {},
}));

class AgentQuotaExceededError extends Error {}
class AgentImageNotAllowedError extends Error {}

mock.module("@/lib/services/eliza-sandbox", () => ({
  elizaSandboxService: { listAgents },
  AgentQuotaExceededError,
  AgentImageNotAllowedError,
}));
mock.module("@/lib/services/provisioning-jobs", () => ({
  provisioningJobService: {},
}));
mock.module("@/lib/services/agent-billing-gate", () => ({
  checkAgentCreditGate: mock(async () => ({ allowed: true, balance: 5 })),
}));
mock.module("@/lib/services/eliza-managed-launch", () => ({
  prepareManagedElizaEnvironment: mock(async () => ({
    changed: false,
    environmentVars: {},
  })),
}));
mock.module("@/lib/services/provisioning-worker-health", () => ({
  checkProvisioningWorkerHealth: mock(async () => ({ ok: true })),
  provisioningWorkerFailureBody: () => ({ success: false }),
}));

const { default: agentsRoute } = await import("../v1/eliza/agents/route");
const app = new Hono();
app.route("/api/v1/eliza/agents", agentsRoute);

describe("GET /api/v1/eliza/agents hosting presentation", () => {
  test("shared rows carry zero continuous hosting and never count as dedicated", async () => {
    const response = await app.request("/api/v1/eliza/agents");

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: Array<{ hostingCost: unknown }>;
      hostingSummary: Record<string, unknown>;
    };

    expect(body.data.map((agent) => agent.hostingCost)).toEqual([
      {
        rateClass: "shared-usage",
        hourlyRateUsd: 0,
        monthlyEstimateUsd: 0,
      },
      {
        rateClass: "shared-usage",
        hourlyRateUsd: 0,
        monthlyEstimateUsd: 0,
      },
    ]);
    expect(body.hostingSummary).toMatchObject({
      sharedCount: 2,
      dedicatedRunningCount: 0,
      dedicatedIdleCount: 0,
      hourlyHostingCostUsd: 0,
      monthlyHostingCostUsd: 0,
      creditBalanceUsd: 5,
      hoursRemaining: null,
      lowBalance: false,
    });
    expect(getCreditBalanceResponse).toHaveBeenCalledWith("org-1");
  });
});
