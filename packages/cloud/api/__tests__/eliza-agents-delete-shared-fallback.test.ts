/**
 * Route-level contract for DELETE /api/v1/eliza/agents/:agentId shared-tier
 * dispatch, with the sandbox service and job queue mocked: a sandboxed shared
 * agent skips the impossible Worker-side sync teardown and goes straight to
 * the async agent_delete job (#15802); a sandbox-less shared agent still
 * attempts the sync delete and falls back to the async job on a
 * non-terminal failure (#15286). Real-PGlite coverage of the same contract
 * lives in eliza-agents-delete-async-fallback.test.ts.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

const requireUserOrApiKeyWithOrg = mock(async () => ({
  id: "user-1",
  organization_id: "org-1",
}));

const getAgent = mock(async () => sharedAgent());
const deleteAgent = mock(async () => ({
  success: false,
  error: "Failed to delete sandbox",
}));
const enqueueAgentDeleteOnce = mock(async () => ({
  created: true,
  job: { id: "delete-job-1", status: "pending" },
}));
const triggerImmediate = mock(async () => undefined);

const loggerInfo = mock(() => undefined);
const loggerWarn = mock(() => undefined);
const loggerError = mock(() => undefined);

mock.module("@/db/client", () => ({
  db: { query: { agentServerWallets: { findFirst: mock(async () => null) } } },
}));

mock.module("@/db/repositories/characters", () => ({
  userCharactersRepository: {
    findByIdInOrganization: mock(async () => null),
    delete: mock(async () => undefined),
  },
}));

mock.module("@/db/schemas/agent-server-wallets", () => ({
  agentServerWallets: { character_id: "character_id" },
}));

mock.module("@/lib/api/cloud-worker-errors", () => ({
  failureResponse: (
    c: { json: (body: unknown, status?: number) => Response },
    error: unknown,
  ) =>
    c.json(
      {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      },
      500,
    ),
}));

mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireUserOrApiKeyWithOrg,
}));

mock.module("@/lib/config/containers-env", () => ({
  containersEnv: { publicBaseDomain: () => "agents.example.test" },
}));

mock.module("@/lib/eliza-agent-web-ui", () => ({
  getElizaAgentPublicWebUiUrl: mock(() => null),
}));

mock.module("@/lib/services/admin", () => ({
  adminService: {
    getAdminStatusForUser: mock(async () => ({ isAdmin: false })),
  },
}));

mock.module("@/lib/services/eliza-sandbox", () => ({
  elizaSandboxService: { getAgent, deleteAgent },
}));

mock.module("@/lib/services/provisioning-jobs", () => ({
  provisioningJobService: { enqueueAgentDeleteOnce, triggerImmediate },
}));

mock.module("@/lib/services/steward-client", () => ({
  getStewardAgent: mock(async () => null),
}));

mock.module("@/lib/utils/logger", () => ({
  logger: {
    info: loggerInfo,
    warn: loggerWarn,
    error: loggerError,
    debug: mock(() => undefined),
  },
}));

const { default: agentRoute } = await import(
  "../v1/eliza/agents/[agentId]/route"
);

const app = new Hono();
app.route("/api/v1/eliza/agents/:agentId", agentRoute);

// Default shape is the sandbox-less Tier-0 shared agent — the only shared
// shape the route still deletes synchronously. Sandboxed cases override
// `sandbox_id` explicitly.
function sharedAgent(overrides: Record<string, unknown> = {}) {
  return {
    id: "agent-1",
    organization_id: "org-1",
    user_id: "user-1",
    status: "running",
    execution_tier: "shared",
    sandbox_id: null,
    node_id: null,
    container_name: null,
    headscale_ip: null,
    bridge_port: null,
    web_ui_port: null,
    docker_image: "ghcr.io/elizaos/eliza-agent:sha-519b5d8",
    bridge_url: null,
    health_url: null,
    character_id: null,
    agent_config: {},
    created_at: new Date("2026-07-07T08:00:00.000Z"),
    updated_at: new Date("2026-07-07T08:00:00.000Z"),
    deleted_at: null,
    ...overrides,
  };
}

async function deleteRequest() {
  return app.fetch(
    new Request("https://api.example.test/api/v1/eliza/agents/agent-1", {
      method: "DELETE",
    }),
  );
}

describe("DELETE /api/v1/eliza/agents/:agentId shared-runtime fallback", () => {
  beforeEach(() => {
    requireUserOrApiKeyWithOrg.mockClear();
    getAgent.mockReset();
    getAgent.mockResolvedValue(sharedAgent());
    deleteAgent.mockReset();
    deleteAgent.mockResolvedValue({
      success: false,
      error: "Failed to delete sandbox",
    });
    enqueueAgentDeleteOnce.mockClear();
    enqueueAgentDeleteOnce.mockResolvedValue({
      created: true,
      job: { id: "delete-job-1", status: "pending" },
    });
    triggerImmediate.mockClear();
    loggerWarn.mockClear();
    loggerInfo.mockClear();
  });

  test("queues an async delete instead of returning 500 when shared sync teardown fails", async () => {
    const response = await deleteRequest();

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      created: true,
      data: {
        jobId: "delete-job-1",
        agentId: "agent-1",
        status: "pending",
      },
    });
    expect(deleteAgent).toHaveBeenCalledWith("agent-1", "org-1");
    expect(enqueueAgentDeleteOnce).toHaveBeenCalledWith({
      agentId: "agent-1",
      organizationId: "org-1",
      userId: "user-1",
    });
    expect(triggerImmediate).toHaveBeenCalledTimes(1);
    expect(loggerWarn).toHaveBeenCalledWith(
      expect.stringContaining("falling back to async delete job"),
      expect.objectContaining({ agentId: "agent-1", orgId: "org-1" }),
    );
  });

  test("still returns terminal sync errors without queueing a doomed delete", async () => {
    deleteAgent.mockResolvedValueOnce({
      success: false,
      error: "Agent provisioning is in progress",
    });

    const response = await deleteRequest();

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: "Agent provisioning is in progress",
    });
    expect(enqueueAgentDeleteOnce).not.toHaveBeenCalled();
  });

  test("sandboxed shared agent skips the impossible sync teardown and goes straight to the async job", async () => {
    getAgent.mockResolvedValue(sharedAgent({ sandbox_id: "sandbox-agent-1" }));

    const response = await deleteRequest();

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      created: true,
      data: {
        jobId: "delete-job-1",
        agentId: "agent-1",
        status: "pending",
      },
    });
    // The Worker cannot SSH (ssh2 is stubbed in workerd) — the sync delete
    // must never even be attempted for a shared agent with a container.
    expect(deleteAgent).not.toHaveBeenCalled();
    expect(enqueueAgentDeleteOnce).toHaveBeenCalledWith({
      agentId: "agent-1",
      organizationId: "org-1",
      userId: "user-1",
    });
    expect(triggerImmediate).toHaveBeenCalledTimes(1);
  });
});
