/**
 * Verifies that agent DELETE requests preserve synchronous cleanup for
 * container-free shared agents while routing sandbox-backed shared agents,
 * dedicated agents, and failed sync teardown through the delete-wins queue.
 * Mocked-service Hono boundary suite; the real-database branch coverage lives
 * in eliza-agents-delete-sandbox-branch.pglite.test.ts.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

const requireUserOrApiKeyWithOrg = mock(async () => ({
  id: "user-1",
  organization_id: "org-1",
}));

const getAgent = mock(async () => sharedAgent());
const getAgentForWrite = mock(async () => sharedAgent());
type DeleteAgentResultShape =
  | { success: true; deletedSandbox: Record<string, unknown> }
  | { success: false; error: string };

const deleteAgent = mock(
  async (): Promise<DeleteAgentResultShape> => ({
    success: false,
    error: "Failed to delete sandbox",
  }),
);
type CancelAgentDeletionResult =
  | { success: true }
  | { success: false; error: string };

const cancelAgentDeletion = mock(
  async (): Promise<CancelAgentDeletionResult> => ({ success: true }),
);
type EnqueueAgentDeleteOnceResult = {
  created: boolean;
  job: {
    id: string;
    status: string;
    data?: Record<string, unknown>;
  };
};
const enqueueAgentDeleteOnce = mock(
  async (): Promise<EnqueueAgentDeleteOnceResult> => ({
    created: true,
    job: { id: "delete-job-1", status: "pending" },
  }),
);
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
  elizaSandboxService: {
    getAgent,
    getAgentForWrite,
    deleteAgent,
    cancelAgentDeletion,
  },
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

const DEPLOY_COMMIT = "a".repeat(40);

function sharedAgent(overrides: Record<string, unknown> = {}) {
  return {
    id: "agent-1",
    organization_id: "org-1",
    user_id: "user-1",
    status: "running",
    execution_tier: "shared",
    sandbox_id: "sandbox-agent-1",
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

async function deleteRequest(
  body?: Record<string, unknown> | string,
  deployCommit = DEPLOY_COMMIT,
) {
  return app.fetch(
    new Request("https://api.example.test/api/v1/eliza/agents/agent-1", {
      method: "DELETE",
      ...(body !== undefined
        ? {
            headers: { "content-type": "application/json" },
            body: typeof body === "string" ? body : JSON.stringify(body),
          }
        : {}),
    }),
    { ELIZA_DEPLOY_COMMIT: deployCommit },
  );
}

async function patchRequest(body: Record<string, unknown>) {
  return app.fetch(
    new Request("https://api.example.test/api/v1/eliza/agents/agent-1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

describe("agent deletion lifecycle", () => {
  beforeEach(() => {
    requireUserOrApiKeyWithOrg.mockClear();
    getAgent.mockReset();
    getAgent.mockResolvedValue(sharedAgent());
    getAgentForWrite.mockReset();
    getAgentForWrite.mockResolvedValue(sharedAgent());
    deleteAgent.mockReset();
    deleteAgent.mockResolvedValue({
      success: false,
      error: "Failed to delete sandbox",
    });
    cancelAgentDeletion.mockReset();
    cancelAgentDeletion.mockResolvedValue({ success: true });
    enqueueAgentDeleteOnce.mockClear();
    enqueueAgentDeleteOnce.mockResolvedValue({
      created: true,
      job: { id: "delete-job-1", status: "pending" },
    });
    triggerImmediate.mockClear();
    loggerWarn.mockClear();
    loggerInfo.mockClear();
  });

  test("exposes authenticated cancellation of a queued deletion", async () => {
    getAgentForWrite.mockResolvedValueOnce(
      sharedAgent({
        status: "deletion_pending",
        execution_tier: "dedicated-always",
      }),
    );

    const response = await patchRequest({ action: "cancel_deletion" });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: {
        agentId: "agent-1",
        action: "cancel_deletion",
        status: "running",
      },
    });
    expect(cancelAgentDeletion).toHaveBeenCalledWith("agent-1", "org-1");
    expect(enqueueAgentDeleteOnce).not.toHaveBeenCalled();
  });

  test("surfaces a non-reversible deletion cancellation as a conflict", async () => {
    cancelAgentDeletion.mockResolvedValueOnce({
      success: false,
      error: "Agent deletion is already executing",
    });

    const response = await patchRequest({ action: "cancel_deletion" });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: "Agent deletion is already executing",
    });
  });

  test("routes a sandbox-backed shared delete straight to the async job without a sync attempt", async () => {
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
    expect(deleteAgent).not.toHaveBeenCalled();
    expect(enqueueAgentDeleteOnce).toHaveBeenCalledWith({
      agentId: "agent-1",
      organizationId: "org-1",
      userId: "user-1",
      authorization: "user_request",
    });
    expect(triggerImmediate).toHaveBeenCalledTimes(1);
  });

  test("persists an explicit state-loss acknowledgement on the async delete job", async () => {
    enqueueAgentDeleteOnce.mockResolvedValueOnce({
      created: false,
      job: {
        id: "delete-job-1",
        status: "pending",
        data: {
          stateLossAcknowledged: true,
          stateLossAcknowledgedByUserId: "user-1",
          stateLossAcknowledgedAt: "2026-08-21T04:00:00.000Z",
        },
      },
    });
    const response = await deleteRequest({ stateLossAcknowledged: true });

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: {
        jobId: "delete-job-1",
        stateLossAcknowledged: true,
        stateLossAcknowledgedByUserId: "user-1",
        stateLossAcknowledgedAt: "2026-08-21T04:00:00.000Z",
      },
    });
    expect(enqueueAgentDeleteOnce).toHaveBeenCalledWith({
      agentId: "agent-1",
      organizationId: "org-1",
      userId: "user-1",
      authorization: "user_request",
      stateLossAcknowledged: true,
    });
  });

  test("fails closed instead of claiming a waiver when reuse did not persist authority", async () => {
    enqueueAgentDeleteOnce.mockResolvedValueOnce({
      created: false,
      job: { id: "delete-job-1", status: "pending", data: {} },
    });

    const response = await deleteRequest({ stateLossAcknowledged: true });

    expect(response.status).toBe(500);
  });

  test("fails closed when durable authority has no acknowledging actor", async () => {
    enqueueAgentDeleteOnce.mockResolvedValueOnce({
      created: false,
      job: {
        id: "legacy-delete-job",
        status: "in_progress",
        data: { stateLossAcknowledged: true },
      },
    });

    const response = await deleteRequest({ stateLossAcknowledged: false });

    expect(response.status).toBe(500);
  });

  test("fails closed when durable authority provenance is malformed", async () => {
    enqueueAgentDeleteOnce.mockResolvedValueOnce({
      created: false,
      job: {
        id: "malformed-delete-job",
        status: "in_progress",
        data: {
          stateLossAcknowledged: true,
          stateLossAcknowledgedByUserId: "",
          stateLossAcknowledgedAt: "not-an-iso-timestamp",
        },
      },
    });

    const response = await deleteRequest({ stateLossAcknowledged: false });

    expect(response.status).toBe(500);
  });

  test("does not infer the waiver when stateLossAcknowledged is false", async () => {
    const response = await deleteRequest({ stateLossAcknowledged: false });

    expect(response.status).toBe(202);
    expect(enqueueAgentDeleteOnce).toHaveBeenCalledWith({
      agentId: "agent-1",
      organizationId: "org-1",
      userId: "user-1",
      authorization: "user_request",
    });
  });

  test("rejects partial conditional identity even when the waiver is explicit", async () => {
    const response = await deleteRequest({
      expectedAgentName: "Canary Agent",
      stateLossAcknowledged: true,
    });

    expect(response.status).toBe(400);
    expect(enqueueAgentDeleteOnce).not.toHaveBeenCalled();
  });

  test("keeps the synchronous fast path for a sandbox-less shared delete", async () => {
    getAgent.mockResolvedValueOnce(sharedAgent({ sandbox_id: null }));
    deleteAgent.mockResolvedValueOnce({
      success: true,
      deletedSandbox: sharedAgent({ sandbox_id: null }),
    });

    const response = await deleteRequest();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      deleted: true,
      source: "shared_runtime",
      data: {
        agentId: "agent-1",
        status: "deleted",
        executionTier: "shared",
      },
    });
    expect(deleteAgent).toHaveBeenCalledWith("agent-1", "org-1", {
      authorization: "user_request",
    });
    expect(enqueueAgentDeleteOnce).not.toHaveBeenCalled();
  });

  test("queues an async delete instead of returning 500 when sandbox-less shared sync teardown fails", async () => {
    getAgent.mockResolvedValueOnce(sharedAgent({ sandbox_id: null }));

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
    expect(deleteAgent).toHaveBeenCalledWith("agent-1", "org-1", {
      authorization: "user_request",
    });
    expect(enqueueAgentDeleteOnce).toHaveBeenCalledWith({
      agentId: "agent-1",
      organizationId: "org-1",
      userId: "user-1",
      authorization: "user_request",
    });
    expect(triggerImmediate).toHaveBeenCalledTimes(1);
    expect(loggerWarn).toHaveBeenCalledWith(
      expect.stringContaining("falling back to async delete job"),
      expect.objectContaining({ agentId: "agent-1", orgId: "org-1" }),
    );
  });

  test("preserves the normal provisioning conflict without an identity precondition", async () => {
    getAgent.mockResolvedValueOnce(
      sharedAgent({
        status: "provisioning",
        execution_tier: "dedicated-always",
      }),
    );

    const response = await deleteRequest();

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: "Agent provisioning is in progress",
    });
    expect(enqueueAgentDeleteOnce).not.toHaveBeenCalled();
  });

  test("treats a whitespace-only body as the legacy no-body delete", async () => {
    getAgent.mockResolvedValueOnce(
      sharedAgent({
        status: "provisioning",
        execution_tier: "dedicated-always",
      }),
    );

    const response = await deleteRequest(" \n\t ");

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: "Agent provisioning is in progress",
    });
    expect(enqueueAgentDeleteOnce).not.toHaveBeenCalled();
  });

  test("lets the delete-wins queue retire an exact conditionally matched provisioning agent", async () => {
    getAgent.mockResolvedValueOnce(
      sharedAgent({
        status: "provisioning",
        execution_tier: "dedicated-always",
      }),
    );

    const response = await deleteRequest({
      expectedAgentName: "Canary Agent",
      expectedCreatedAt: "2026-07-07T08:00:00.000Z",
      expectedExecutionTier: "dedicated-always",
    });

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
    expect(deleteAgent).not.toHaveBeenCalled();
    expect(enqueueAgentDeleteOnce).toHaveBeenCalledWith({
      agentId: "agent-1",
      organizationId: "org-1",
      userId: "user-1",
      authorization: "user_request",
      expectedIdentity: {
        agentName: "Canary Agent",
        createdAt: "2026-07-07T08:00:00.000Z",
        executionTier: "dedicated-always",
      },
    });
    expect(triggerImmediate).toHaveBeenCalledTimes(1);
  });

  test("rejects a conditional delete when the serving deploy changed before deletion", async () => {
    const response = await deleteRequest({
      expectedAgentName: "Canary Agent",
      expectedCreatedAt: "2026-07-07T08:00:00.000Z",
      expectedExecutionTier: "dedicated-always",
      expectedDeployCommit: "b".repeat(40),
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: "Conditional delete deploy mismatch",
    });
    expect(getAgent).not.toHaveBeenCalled();
    expect(deleteAgent).not.toHaveBeenCalled();
    expect(enqueueAgentDeleteOnce).not.toHaveBeenCalled();
  });

  test("accepts a conditional delete bound to the serving deploy", async () => {
    getAgent.mockResolvedValueOnce(
      sharedAgent({
        status: "provisioning",
        execution_tier: "dedicated-always",
      }),
    );

    const response = await deleteRequest({
      expectedAgentName: "Canary Agent",
      expectedCreatedAt: "2026-07-07T08:00:00.000Z",
      expectedExecutionTier: "dedicated-always",
      expectedDeployCommit: DEPLOY_COMMIT,
    });

    expect(response.status).toBe(202);
    expect(enqueueAgentDeleteOnce).toHaveBeenCalledTimes(1);
  });

  test("rejects an invalid conditional delete before queueing", async () => {
    const response = await deleteRequest({
      expectedAgentName: "Canary Agent",
      expectedCreatedAt: "not-a-timestamp",
      expectedExecutionTier: "dedicated-always",
    });

    expect(response.status).toBe(400);
    expect(enqueueAgentDeleteOnce).not.toHaveBeenCalled();
  });

  test("rejects a non-boolean state-loss acknowledgement", async () => {
    const response = await deleteRequest({ stateLossAcknowledged: "true" });

    expect(response.status).toBe(400);
    expect(enqueueAgentDeleteOnce).not.toHaveBeenCalled();
  });

  test("still returns terminal sync errors without queueing a doomed delete", async () => {
    getAgent.mockResolvedValueOnce(sharedAgent({ sandbox_id: null }));
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
});
