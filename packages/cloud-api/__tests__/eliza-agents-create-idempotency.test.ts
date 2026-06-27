/**
 * POST /api/v1/eliza/agents — create-vs-reuse idempotency at the route layer.
 *
 * When elizaSandboxService.createAgent reports `idempotent: true` (the org
 * already had a non-terminal agent), the route must:
 *   - return 200 with the existing agent (created:false), NOT a fresh-create code,
 *   - NOT enqueue a second provisioning job,
 *   - NOT run the managed-env / orphan-cleanup create path.
 * The happy create path (idempotent:false) still enqueues and returns 202.
 *
 * Mocks only the module boundaries the handler imports — the route logic itself
 * is real.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

const requireUserOrApiKeyWithOrg = mock(async () => ({
  id: "user-1",
  organization_id: "org-1",
}));

const createAgent = mock();
const updateAgentEnvironment = mock(async () => undefined);
const listAgents = mock(async () => []);

const enqueueAgentProvision = mock(async () => ({
  id: "job-1",
  status: "pending",
  estimated_completion_at: new Date("2026-06-24T00:01:30.000Z"),
}));
const triggerImmediate = mock(async () => undefined);

const checkAgentCreditGate = mock(async () => ({
  allowed: true,
  balance: 100,
}));
const checkProvisioningWorkerHealth = mock(async () => ({ ok: true }));
const prepareManagedElizaEnvironment = mock(async () => ({
  changed: false,
  environmentVars: {},
}));

const loggerInfo = mock(() => undefined);
const loggerWarn = mock(() => undefined);
const loggerError = mock(() => undefined);

const claimWarmContainer = mock(async () => null);
const listByOrganization = mock(async () => []);

mock.module("@/db/repositories/agent-sandboxes", () => ({
  agentSandboxesRepository: { claimWarmContainer, listByOrganization },
}));

mock.module("@/db/repositories/characters", () => ({
  userCharactersRepository: {
    findByIdInOrganizationForWrite: mock(async () => undefined),
    findByIdsInOrganization: mock(async () => []),
  },
}));

mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireUserOrApiKeyWithOrg,
}));

mock.module("@/lib/services/eliza-sandbox", () => ({
  elizaSandboxService: { createAgent, updateAgentEnvironment, listAgents },
}));

mock.module("@/lib/services/provisioning-jobs", () => ({
  provisioningJobService: { enqueueAgentProvision, triggerImmediate },
}));

mock.module("@/lib/services/agent-billing-gate", () => ({
  checkAgentCreditGate,
}));

mock.module("@/lib/services/provisioning-worker-health", () => ({
  checkProvisioningWorkerHealth,
  provisioningWorkerFailureBody: (h: { code?: string }) => ({
    success: false,
    code: h.code ?? "worker_unavailable",
  }),
}));

mock.module("@/lib/services/eliza-managed-launch", () => ({
  prepareManagedElizaEnvironment,
}));

mock.module("@/lib/utils/logger", () => ({
  logger: { info: loggerInfo, warn: loggerWarn, error: loggerError },
}));

const { default: agentsRoute } = await import("../v1/eliza/agents/route");

const app = new Hono();
app.route("/api/v1/eliza/agents", agentsRoute);

function pendingAgent() {
  return {
    id: "e06bb509-6c52-4c33-a9f7-66addc43e8c8",
    agent_name: "alpha",
    organization_id: "org-1",
    status: "provisioning",
    execution_tier: "custom",
    created_at: new Date("2026-06-24T00:00:00.000Z"),
    agent_config: {},
    character_id: null,
  };
}

async function postCreate(body: unknown) {
  return app.fetch(
    new Request("https://api.example.test/api/v1/eliza/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

describe("POST /api/v1/eliza/agents — reuse idempotency", () => {
  beforeEach(() => {
    requireUserOrApiKeyWithOrg.mockClear();
    createAgent.mockReset();
    updateAgentEnvironment.mockClear();
    enqueueAgentProvision.mockClear();
    triggerImmediate.mockClear();
    checkAgentCreditGate.mockClear();
    checkProvisioningWorkerHealth.mockClear();
    prepareManagedElizaEnvironment.mockClear();
    loggerInfo.mockClear();
  });

  test("(d) reuse → 200 with the existing agent, no second provision job", async () => {
    const agent = pendingAgent();
    createAgent.mockResolvedValue({ agent, idempotent: true });

    const res = await postCreate({
      agentName: "alpha",
      dockerImage: "ghcr.io/example/agent:latest",
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      success: boolean;
      created: boolean;
      data: { id: string; agentId: string };
    };
    expect(json.success).toBe(true);
    expect(json.created).toBe(false);
    expect(json.data.id).toBe(agent.id);
    expect(json.data.agentId).toBe(agent.id);

    // The whole point: a reused agent is already provisioned / in flight, so we
    // never enqueue a second job and never touch the managed-env create path.
    expect(enqueueAgentProvision).not.toHaveBeenCalled();
    expect(triggerImmediate).not.toHaveBeenCalled();
    expect(prepareManagedElizaEnvironment).not.toHaveBeenCalled();
  });

  test("fresh create (idempotent:false) still enqueues a job and returns 202", async () => {
    const agent = { ...pendingAgent(), status: "pending" };
    createAgent.mockResolvedValue({ agent, idempotent: false });

    const res = await postCreate({
      agentName: "alpha",
      dockerImage: "ghcr.io/example/agent:latest",
    });

    expect(res.status).toBe(202);
    const json = (await res.json()) as {
      success: boolean;
      data: { jobId: string };
    };
    expect(json.success).toBe(true);
    expect(json.data.jobId).toBe("job-1");
    expect(enqueueAgentProvision).toHaveBeenCalledTimes(1);
  });

  test("forceCreate:true bypasses the reuse guard → createAgent called with reuseExistingNonTerminal:false (mints a SEPARATE agent)", async () => {
    // The org already has a non-terminal agent (the shared bridge). With
    // forceCreate the route must NOT let createAgent reuse it — the dedicated
    // handoff target has to be a distinct record, else dedicatedId === sharedId.
    const agent = { ...pendingAgent(), id: "dedicated-fresh", status: "pending" };
    createAgent.mockResolvedValue({ agent, idempotent: false });

    const res = await postCreate({
      agentName: "alpha",
      dockerImage: "ghcr.io/example/agent:latest",
      forceCreate: true,
    });

    expect(res.status).toBe(202);
    expect(createAgent).toHaveBeenCalledTimes(1);
    const passed = createAgent.mock.calls[0]?.[0] as {
      reuseExistingNonTerminal?: boolean;
    };
    expect(passed.reuseExistingNonTerminal).toBe(false);
    // A fresh create still provisions normally.
    expect(enqueueAgentProvision).toHaveBeenCalledTimes(1);
  });

  test("default (no forceCreate) still reuses → createAgent called with reuseExistingNonTerminal:true (byte-identical to before)", async () => {
    const agent = pendingAgent();
    createAgent.mockResolvedValue({ agent, idempotent: true });

    const res = await postCreate({
      agentName: "alpha",
      dockerImage: "ghcr.io/example/agent:latest",
    });

    expect(res.status).toBe(200);
    expect(createAgent).toHaveBeenCalledTimes(1);
    const passed = createAgent.mock.calls[0]?.[0] as {
      reuseExistingNonTerminal?: boolean;
    };
    expect(passed.reuseExistingNonTerminal).toBe(true);
  });

  test("forceCreate:false (explicit) is treated as the default → reuseExistingNonTerminal:true", async () => {
    const agent = pendingAgent();
    createAgent.mockResolvedValue({ agent, idempotent: true });

    await postCreate({
      agentName: "alpha",
      dockerImage: "ghcr.io/example/agent:latest",
      forceCreate: false,
    });

    const passed = createAgent.mock.calls[0]?.[0] as {
      reuseExistingNonTerminal?: boolean;
    };
    expect(passed.reuseExistingNonTerminal).toBe(true);
  });
});
