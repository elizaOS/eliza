// Exercises cloud API v1 agents agentid suspend route.test behavior with deterministic Worker route fixtures.
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
const enqueueAgentSuspendOnce = mock(async () => ({
  created: true,
  job: {
    id: "suspend-job-1",
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
    enqueueAgentSuspendOnce,
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

const { default: suspendRoute } = await import("./route");

describe("service agent suspend route", () => {
  const app = new Hono();
  app.route("/api/v1/agents/:agentId/suspend", suspendRoute);

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
    enqueueAgentSuspendOnce.mockClear();
    enqueueAgentSuspendOnce.mockResolvedValue({
      created: true,
      job: {
        id: "suspend-job-1",
        status: "pending",
      },
    });
    triggerImmediate.mockClear();
  });

  test("enqueues suspend under the agent owner org and user", async () => {
    const response = await app.fetch(
      new Request(
        "https://api.example.test/api/v1/agents/cloud-agent-1/suspend",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Service-Key": "svc",
          },
          body: JSON.stringify({ reason: "owner requested suspension" }),
        },
      ),
      { WAIFU_SERVICE_KEY: "svc" },
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: {
        agentId: "cloud-agent-1",
        action: "suspend",
        jobId: "suspend-job-1",
        previousStatus: "running",
      },
    });
    expect(enqueueAgentSuspendOnce).toHaveBeenCalledWith({
      agentId: "cloud-agent-1",
      organizationId: "agent-wallet-org",
      userId: "agent-wallet-user",
    });
  });

  test("returns an idempotent success without enqueueing when already stopped", async () => {
    getAgentById.mockResolvedValueOnce({
      id: "cloud-agent-1",
      organization_id: "agent-wallet-org",
      user_id: "agent-wallet-user",
      status: "stopped",
    });

    const response = await app.fetch(
      new Request(
        "https://api.example.test/api/v1/agents/cloud-agent-1/suspend",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Service-Key": "svc",
          },
          body: JSON.stringify({}),
        },
      ),
      { WAIFU_SERVICE_KEY: "svc" },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: {
        agentId: "cloud-agent-1",
        action: "suspend",
        previousStatus: "stopped",
      },
    });
    expect(enqueueAgentSuspendOnce).not.toHaveBeenCalled();
  });
});
