/** Proves the real agents list route emits server-owned shared-hosting truth. */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import type { AgentBillingStatus } from "../../shared/src/db/schemas/agent-sandboxes";
import type {
  AgentDatabaseStatus,
  AgentExecutionTier,
  AgentSandboxStatus,
} from "../../shared/src/lib/types/cloud-api";
import { agentsResponseSchema } from "../../shared/src/types/agent-api-schema";

interface ListedAgent {
  id: string;
  organization_id: string;
  user_id: string;
  character_id: string | null;
  agent_name: string;
  agent_config: Record<string, unknown>;
  status: AgentSandboxStatus;
  database_status: AgentDatabaseStatus;
  billing_status: AgentBillingStatus;
  execution_tier: AgentExecutionTier;
  last_backup_at: Date | null;
  last_heartbeat_at: Date | null;
  error_message: string | null;
  created_at: Date;
  updated_at: Date;
  docker_image: string | null;
}

const requireUserOrApiKeyWithOrg = mock(async () => ({
  id: "user-1",
  organization_id: "org-1",
}));
const findByIdsInOrganization = mock(async () => []);
const getCreditBalanceResponse = mock(async () => ({ balance: 5 }));
const sharedAgents: readonly ListedAgent[] = [
  {
    id: "11111111-1111-4111-8111-111111111111",
    organization_id: "org-1",
    user_id: "user-1",
    character_id: null,
    agent_name: "Shared one",
    agent_config: {},
    status: "running",
    database_status: "ready",
    billing_status: "active",
    execution_tier: "shared",
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
    status: "provisioning",
    database_status: "none",
    billing_status: "active",
    execution_tier: "shared",
    last_backup_at: null,
    last_heartbeat_at: null,
    error_message: null,
    created_at: new Date("2026-06-18T00:00:00.000Z"),
    updated_at: new Date("2026-08-12T00:00:00.000Z"),
    docker_image: null,
  },
];
let listedAgents: readonly ListedAgent[] = sharedAgents;
const listAgents = mock(async () => listedAgents);

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
  beforeEach(() => {
    listedAgents = sharedAgents;
  });

  test("shared rows carry zero continuous hosting and never count as dedicated", async () => {
    const response = await app.request("/api/v1/eliza/agents");

    expect(response.status).toBe(200);
    const body = agentsResponseSchema.parse(await response.json());

    expect(body.data.map((agent) => agent.hostingCost)).toEqual([
      {
        pricingState: "known",
        rateClass: "shared-usage",
        hourlyRateUsd: 0,
        monthlyEstimateUsd: 0,
      },
      {
        pricingState: "known",
        rateClass: "shared-usage",
        hourlyRateUsd: 0,
        monthlyEstimateUsd: 0,
      },
    ]);
    expect(body.hostingSummary).toMatchObject({
      pricingState: "complete",
      sharedCount: 2,
      dedicatedRunningCount: 0,
      dedicatedIdleCount: 0,
      dedicatedDeactivatedCount: 0,
      unavailableDedicatedCount: 0,
      hourlyHostingCostUsd: 0,
      monthlyHostingCostUsd: 0,
      creditBalanceUsd: 5,
      hoursRemaining: null,
      lowBalance: false,
    });
    expect(getCreditBalanceResponse).toHaveBeenCalledWith("org-1");
  });

  test("mixed known and unavailable dedicated rows suppress the aggregate total", async () => {
    listedAgents = [
      sharedAgents[0],
      {
        ...sharedAgents[0],
        id: "33333333-3333-4333-8333-333333333333",
        agent_name: "Dedicated running",
        execution_tier: "dedicated-always",
      },
      {
        ...sharedAgents[1],
        id: "44444444-4444-4444-8444-444444444444",
        agent_name: "Dedicated provisioning",
        execution_tier: "dedicated-lazy",
      },
    ];

    const response = await app.request("/api/v1/eliza/agents");

    expect(response.status).toBe(200);
    const body = agentsResponseSchema.parse(await response.json());
    expect(body.data[2]?.hostingCost).toEqual({
      pricingState: "unavailable",
      rateClass: "unavailable",
      hourlyRateUsd: null,
      monthlyEstimateUsd: null,
    });
    expect(body.hostingSummary).toMatchObject({
      pricingState: "incomplete",
      sharedCount: 1,
      dedicatedRunningCount: 1,
      unavailableDedicatedCount: 1,
      hasDedicatedHosting: true,
      hourlyHostingCostUsd: null,
      monthlyHostingCostUsd: null,
      hoursRemaining: null,
      lowBalance: null,
    });
  });
});
