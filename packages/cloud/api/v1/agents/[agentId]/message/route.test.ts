// Exercises cloud API v1 agents agentid message route.test behavior with deterministic Worker route fixtures.
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

const requireServiceKey = mock(async () => ({
  organizationId: "service-org",
  userId: "service-user",
}));
const getAgentById = mock(
  async (): Promise<{
    id: string;
    organization_id: string;
    user_id: string;
  } | null> => ({
    id: "cloud-agent-1",
    organization_id: "agent-wallet-org",
    user_id: "agent-wallet-user",
  }),
);
const enqueueAgentMessage = mock(async () => ({
  created: true,
  job: {
    id: "message-job-1",
    status: "pending",
  },
}));
const triggerImmediate = mock(async () => undefined);
const getJobForOrg = mock(async () => ({
  id: "message-job-1",
  status: "completed",
  result: {
    text: "hello back",
    reason: "ok",
  },
}));

mock.module("@/lib/auth/service-key-hono-worker", () => ({
  requireServiceKey,
}));

mock.module("@/lib/services/eliza-sandbox", () => ({
  elizaSandboxService: {
    getAgentById,
  },
}));

mock.module("@/lib/services/provisioning-jobs", () => ({
  provisioningJobService: {
    enqueueAgentMessage,
    getJobForOrg,
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

const { default: messageRoute } = await import("./route");

describe("service agent message route", () => {
  const app = new Hono();
  app.route("/api/v1/agents/:agentId/message", messageRoute);

  beforeEach(() => {
    requireServiceKey.mockClear();
    getAgentById.mockClear();
    getAgentById.mockResolvedValue({
      id: "cloud-agent-1",
      organization_id: "agent-wallet-org",
      user_id: "agent-wallet-user",
    });
    enqueueAgentMessage.mockClear();
    enqueueAgentMessage.mockResolvedValue({
      created: true,
      job: {
        id: "message-job-1",
        status: "pending",
      },
    });
    triggerImmediate.mockClear();
    getJobForOrg.mockClear();
    getJobForOrg.mockResolvedValue({
      id: "message-job-1",
      status: "completed",
      result: {
        text: "hello back",
        reason: "ok",
      },
    });
  });

  test("routes wallet-owned agents through the agent owner org and user", async () => {
    const response = await app.fetch(
      new Request(
        "https://api.example.test/api/v1/agents/cloud-agent-1/message",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Service-Key": "svc",
          },
          body: JSON.stringify({
            text: "hello",
            userId: "patron-user",
            sessionId: "session-1",
            roomId: "room-1",
          }),
        },
      ),
      { WAIFU_SERVICE_KEY: "svc" },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      text: "hello back",
      reason: "ok",
      jobId: "message-job-1",
    });

    expect(getAgentById).toHaveBeenCalledWith("cloud-agent-1");
    expect(enqueueAgentMessage).toHaveBeenCalledWith({
      agentId: "cloud-agent-1",
      organizationId: "agent-wallet-org",
      userId: "agent-wallet-user",
      text: "hello",
      senderId: "patron-user",
      sessionId: "session-1",
      roomId: "room-1",
    });
    expect(getJobForOrg).toHaveBeenCalledWith(
      "message-job-1",
      "agent-wallet-org",
    );
  });

  test("returns 404 before enqueueing when the agent id is unknown", async () => {
    getAgentById.mockResolvedValueOnce(null);

    const response = await app.fetch(
      new Request(
        "https://api.example.test/api/v1/agents/missing-agent/message",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Service-Key": "svc",
          },
          body: JSON.stringify({ text: "hello" }),
        },
      ),
      { WAIFU_SERVICE_KEY: "svc" },
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: "Agent not found",
    });
    expect(enqueueAgentMessage).not.toHaveBeenCalled();
    expect(getJobForOrg).not.toHaveBeenCalled();
  });
});
