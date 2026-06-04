import { beforeEach, describe, expect, mock, test } from "bun:test";

const requireUserOrApiKeyWithOrg = mock(async () => ({
  id: "user-1",
  organization_id: "org-1",
}));
const checkProvisioningWorkerHealth = mock(async () => ({ ok: true }));
const createCodingContainerAgent = mock(async () => ({
  idempotent: true,
  agent: {
    id: "fc649701-7443-42e4-aefe-a5e4882eee9e",
    status: "running",
    bridge_url: "http://100.64.0.2:3000",
    health_url: "http://100.64.0.2:3000/health",
    headscale_ip: "100.64.0.2",
    created_at: new Date("2026-06-04T08:47:41.232Z"),
  },
}));
const updateAgentEnvironment = mock(async () => undefined);
const enqueueAgentProvisionOnce = mock(async () => ({
  job: {
    id: "job-1",
  },
}));
const getJobForOrg = mock(async () => undefined);
const triggerImmediate = mock(async () => undefined);

mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireUserOrApiKeyWithOrg,
}));

mock.module("@/lib/eliza-agent-web-ui", () => ({
  getElizaAgentPublicWebUiUrl: (sandbox: { id: string }) =>
    `https://${sandbox.id}.waifu.fun`,
}));

mock.module("@/lib/services/eliza-sandbox", () => ({
  elizaSandboxService: {
    createCodingContainerAgent,
    getAgent: mock(async () => undefined),
    updateAgentEnvironment,
  },
}));

mock.module("@/lib/services/provisioning-jobs", () => ({
  provisioningJobService: {
    enqueueAgentProvisionOnce,
    getJobForOrg,
    triggerImmediate,
  },
}));

mock.module("@/lib/services/provisioning-worker-health", () => ({
  checkProvisioningWorkerHealth,
  provisioningWorkerFailureBody: () => ({
    success: false,
    error: "worker unavailable",
  }),
}));

mock.module("@/lib/utils/logger", () => ({
  logger: {
    debug: mock(() => undefined),
    error: mock(() => undefined),
    info: mock(() => undefined),
    warn: mock(() => undefined),
  },
}));

const { default: app } = await import("./route");

describe("coding containers route", () => {
  beforeEach(() => {
    requireUserOrApiKeyWithOrg.mockClear();
    checkProvisioningWorkerHealth.mockClear();
    createCodingContainerAgent.mockClear();
    updateAgentEnvironment.mockClear();
    enqueueAgentProvisionOnce.mockClear();
    getJobForOrg.mockClear();
    triggerImmediate.mockClear();
  });

  test("creates custom-image coding containers as custom execution-tier agents", async () => {
    const response = await app.fetch(
      new Request("https://api.example.test/", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-API-Key": "test-key",
        },
        body: JSON.stringify({
          agent: "claude",
          container: {
            name: "bnancy",
            image: "ghcr.io/dexploarer/bnancy:latest",
            environmentVars: {
              DISCORD_API_TOKEN: "token-ref",
            },
          },
          workspacePath: "/workspace/the-family",
          source: {
            sourceKind: "project",
            projectId: "the-family",
            rootPath: "/workspace/the-family",
          },
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(createCodingContainerAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        agentName: "bnancy",
        dockerImage: "ghcr.io/dexploarer/bnancy:latest",
        executionTier: "custom",
        organizationId: "org-1",
        userId: "user-1",
      }),
    );
    expect(await response.json()).toEqual(
      expect.objectContaining({
        idempotent: true,
        success: true,
      }),
    );
  });
});
