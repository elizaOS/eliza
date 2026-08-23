/**
 * Exercises the real Hono agent-create handler's `autoProvision` boundary
 * while replacing its authentication, billing, and persistence collaborators.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import type { AppEnv } from "@/types/cloud-worker-env";

mock.module("@/lib/utils/logger", () => ({
  logger: {
    info: mock(() => undefined),
    warn: mock(() => undefined),
    error: mock(() => undefined),
  },
}));

const ORG_A = "11111111-1111-4111-8111-111111111111";
const ENV = { NODE_ENV: "test" } as unknown as AppEnv["Bindings"];

const checkAgentCreditGate = mock(async () => ({
  allowed: false,
  balance: 0,
  error: "insufficient",
}));
const createAgent = mock(async () => ({
  agent: {
    id: "agent-1",
    agent_name: "keep-offline",
    status: "pending",
    created_at: "2026-01-01T00:00:00.000Z",
    execution_tier: "dedicated-always",
  },
  idempotent: true,
}));
const listAgents = mock(async () => [] as Array<Record<string, unknown>>);
const getActiveAgentLifecycleJobsForOrg = mock(
  async () => [] as Array<Record<string, unknown>>,
);

mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireUserOrApiKeyWithOrg: async () => ({
    id: "user-1",
    organization_id: ORG_A,
  }),
}));
mock.module("@/lib/services/agent-billing-gate", () => ({
  checkAgentCreditGate,
}));
mock.module("@/lib/services/agent-billing-gate-402", () => ({
  insufficientCredits402: () => ({ error: "insufficient credits" }),
}));
mock.module("@/lib/services/eliza-sandbox", () => ({
  AgentImageNotAllowedError: class AgentImageNotAllowedError extends Error {},
  AgentQuotaExceededError: class AgentQuotaExceededError extends Error {},
  elizaSandboxService: { createAgent, listAgents },
}));
mock.module("@/db/repositories/characters", () => ({
  userCharactersRepository: {
    findByIdInOrganizationForWrite: mock(async () => null),
    findByIdsInOrganization: mock(async () => []),
  },
}));
mock.module("@/db/repositories/agent-sandboxes", () => ({
  agentSandboxesRepository: { delete: mock(async () => undefined) },
}));
mock.module("@/lib/services/eliza-agent-config", () => ({
  readPersonalElizaCutover: () => undefined,
  stripReservedElizaConfigKeys: (config: unknown) => config ?? {},
  withReusedElizaCharacterOwnership: (config: unknown) => config,
}));
mock.module("@/lib/services/eliza-managed-launch", () => ({
  prepareManagedElizaEnvironment: mock(async () => ({
    changed: false,
    environmentVars: {},
  })),
}));
mock.module("@/lib/services/provisioning-jobs", () => ({
  provisioningJobService: {
    enqueueAgentProvision: mock(async () => ({ id: "job-1" })),
    getActiveAgentLifecycleJobsForOrg,
    triggerImmediate: mock(async () => undefined),
  },
}));
mock.module("@/lib/services/provisioning-worker-health", () => ({
  checkProvisioningWorkerHealth: mock(async () => ({ ok: true })),
  provisioningWorkerFailureBody: () => ({ error: "worker" }),
}));
mock.module("@/lib/config/containers-env", () => ({
  containersEnv: { publicBaseDomain: () => null },
}));
mock.module("@/lib/eliza-agent-web-ui", () => ({
  getElizaAgentPublicWebUiUrl: () => "https://example.test",
}));
mock.module("@/lib/constants/agent-sandbox-quota", () => ({
  getMaxNonTerminalAgentsForOrg: () => 3,
}));
mock.module("@/lib/services/shared-runtime/agent-tier", () => ({
  getAgentTier: (input: { alwaysOn?: boolean; dockerImage?: string }) =>
    input.dockerImage
      ? "custom"
      : input.alwaysOn
        ? "dedicated-always"
        : "shared",
  tierProvisionsEagerly: (tier: string) =>
    tier === "dedicated-always" || tier === "custom",
}));
mock.module("@/lib/api/cloud-worker-errors", () => ({
  ApiError: class ApiError extends Error {},
  NotFoundError: class NotFoundError extends Error {},
  ValidationError: (message: string) => {
    const error = new Error(message);
    error.name = "ValidationError";
    return error;
  },
}));

const { default: agentsRoute } = await import("./route");

function buildApp() {
  const app = new Hono<AppEnv>();
  app.route("/api/v1/eliza/agents", agentsRoute);
  return app;
}

function post(query = "") {
  return buildApp().request(
    `/api/v1/eliza/agents${query}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentName: "keep-offline", alwaysOn: true }),
    },
    ENV,
  );
}

function get() {
  return buildApp().request("/api/v1/eliza/agents", {}, ENV);
}

test("GET reconnects an agent row to its newest active lifecycle job", async () => {
  listAgents.mockImplementationOnce(async () => [
    {
      id: "agent-1",
      agent_name: "Ada",
      status: "provisioning",
      database_status: "provisioning",
      last_backup_at: null,
      last_heartbeat_at: null,
      error_message: null,
      created_at: new Date("2026-08-21T00:00:00.000Z"),
      updated_at: new Date("2026-08-21T00:01:00.000Z"),
      character_id: null,
      agent_config: {},
      docker_image: null,
      execution_tier: "dedicated-always",
    },
  ]);
  getActiveAgentLifecycleJobsForOrg.mockImplementationOnce(async () => [
    {
      id: "job-1",
      type: "agent_provision",
      status: "in_progress",
      agent_id: "agent-1",
      attempts: 1,
      max_attempts: 3,
      estimated_completion_at: new Date("2026-08-21T00:05:00.000Z"),
      scheduled_for: new Date("2026-08-21T00:00:00.000Z"),
      started_at: new Date("2026-08-21T00:00:05.000Z"),
      created_at: new Date("2026-08-21T00:00:00.000Z"),
      updated_at: new Date("2026-08-21T00:01:00.000Z"),
    },
  ]);

  const response = await get();
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    data: Array<{ activeJob: { id: string; attempts: number } | null }>;
  };
  expect(body.data[0]?.activeJob).toMatchObject({ id: "job-1", attempts: 1 });
});

describe("POST /api/v1/eliza/agents autoProvision identity", () => {
  beforeEach(() => {
    checkAgentCreditGate.mockClear();
    createAgent.mockClear();
  });

  test.each(["", "?autoProvision=", "?autoProvision=true"])(
    "accepts %s as eager-provision (credit gate runs)",
    async (query) => {
      const response = await post(query);
      expect(response.status).toBe(402);
      expect(checkAgentCreditGate).toHaveBeenCalledTimes(1);
      expect(createAgent).not.toHaveBeenCalled();
    },
  );

  test("accepts autoProvision=false as skip the credit gate", async () => {
    const response = await post("?autoProvision=false");
    expect(response.status).toBe(200);
    expect(checkAgentCreditGate).not.toHaveBeenCalled();
    expect(createAgent).toHaveBeenCalledTimes(1);
  });

  test.each(["FALSE", "TRUE", "0", "1", "no", "yes", "foo"])(
    "rejects autoProvision=%s before credit gate and create",
    async (token) => {
      const response = await post(
        `?autoProvision=${encodeURIComponent(token)}`,
      );
      expect(response.status).toBe(400);
      const responseBody = (await response.json()) as unknown;
      expect(responseBody).toEqual({
        success: false,
        error: "Invalid autoProvision",
        message: 'autoProvision must be "true" or "false".',
      });
      expect(checkAgentCreditGate).not.toHaveBeenCalled();
      expect(createAgent).not.toHaveBeenCalled();
    },
  );

  test.each([
    "?autoProvision=false&autoProvision=true",
    "?autoProvision=false&autoProvision=false",
  ])(
    "rejects duplicate autoProvision values before side effects",
    async (query) => {
      const response = await post(query);
      expect(response.status).toBe(400);
      expect(checkAgentCreditGate).not.toHaveBeenCalled();
      expect(createAgent).not.toHaveBeenCalled();
    },
  );
});
