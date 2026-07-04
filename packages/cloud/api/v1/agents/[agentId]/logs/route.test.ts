// Exercises cloud API v1 agents agentid logs route.test behavior with deterministic Worker route fixtures.
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

const requireServiceKey = mock(async () => ({
  organizationId: "service-org",
  userId: "service-user",
}));
const validateServiceKey = mock(async () => ({
  organizationId: "service-org",
  userId: "service-user",
}));
const getAgentById = mock(
  async (): Promise<{
    id: string;
    organization_id: string;
    user_id: string;
    status: string;
  } | null> => ({
    id: "cloud-agent-1",
    organization_id: "agent-wallet-org",
    user_id: "agent-wallet-user",
    status: "running",
  }),
);
const enqueueAgentLogsOnce = mock(async () => ({
  created: true,
  job: {
    id: "logs-job-1",
    status: "pending",
  },
}));
const triggerImmediate = mock(async () => undefined);

mock.module("@/lib/auth/service-key-hono-worker", () => ({
  requireServiceKey,
  validateServiceKey,
}));

mock.module("@/lib/services/eliza-sandbox", () => ({
  elizaSandboxService: {
    getAgentById,
  },
}));

mock.module("@/lib/services/provisioning-jobs", () => ({
  provisioningJobService: {
    enqueueAgentLogsOnce,
    triggerImmediate,
  },
}));

mock.module("@/lib/utils/logger", () => ({
  logger: {
    info: mock(() => undefined),
    warn: mock(() => undefined),
    error: mock(() => undefined),
    debug: mock(() => undefined),
  },
}));

const { default: logsRoute } = await import("./route");

describe("service agent logs route", () => {
  const app = new Hono();
  app.route("/api/v1/agents/:agentId/logs", logsRoute);

  beforeEach(() => {
    requireServiceKey.mockClear();
    validateServiceKey.mockClear();
    getAgentById.mockClear();
    getAgentById.mockResolvedValue({
      id: "cloud-agent-1",
      organization_id: "agent-wallet-org",
      user_id: "agent-wallet-user",
      status: "running",
    });
    enqueueAgentLogsOnce.mockClear();
    enqueueAgentLogsOnce.mockResolvedValue({
      created: true,
      job: {
        id: "logs-job-1",
        status: "pending",
      },
    });
    triggerImmediate.mockClear();
  });

  test("enqueues logs under the agent owner org and user", async () => {
    const response = await app.fetch(
      new Request(
        "https://api.example.test/api/v1/agents/cloud-agent-1/logs?tail=10",
        {
          method: "GET",
          headers: { "X-Service-Key": "svc" },
        },
      ),
      { WAIFU_SERVICE_KEY: "svc" },
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: {
        agentId: "cloud-agent-1",
        jobId: "logs-job-1",
        tail: 10,
        agentStatus: "running",
      },
    });
    expect(enqueueAgentLogsOnce).toHaveBeenCalledWith({
      agentId: "cloud-agent-1",
      organizationId: "agent-wallet-org",
      userId: "agent-wallet-user",
      tail: 10,
    });
  });

  test("returns 404 before enqueueing when the agent id is unknown", async () => {
    getAgentById.mockResolvedValueOnce(null);

    const response = await app.fetch(
      new Request("https://api.example.test/api/v1/agents/missing-agent/logs", {
        method: "GET",
        headers: { "X-Service-Key": "svc" },
      }),
      { WAIFU_SERVICE_KEY: "svc" },
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: "Agent not found",
    });
    expect(enqueueAgentLogsOnce).not.toHaveBeenCalled();
  });
});
