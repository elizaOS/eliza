import { beforeEach, describe, expect, it, vi } from "vitest";

const capacitorMocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  request: vi.fn(),
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    isNativePlatform: () => true,
  },
  CapacitorHttp: {
    get: capacitorMocks.get,
    post: capacitorMocks.post,
    request: capacitorMocks.request,
  },
}));

import { ElizaClient } from "./client-base";
import "./client-cloud";

describe("ElizaClient direct Cloud auth on native", () => {
  beforeEach(() => {
    capacitorMocks.get.mockReset();
    capacitorMocks.post.mockReset();
    capacitorMocks.request.mockReset();
  });

  it("creates native CLI sessions through the Cloud API host and opens the web auth host", async () => {
    capacitorMocks.post.mockResolvedValue({ status: 200, data: {} });

    const client = new ElizaClient("https://www.elizacloud.ai");
    const result = await client.cloudLoginDirect("https://www.elizacloud.ai");

    expect(capacitorMocks.post).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://api.elizacloud.ai/api/auth/cli-session",
        data: expect.objectContaining({ sessionId: expect.any(String) }),
      }),
    );
    expect(result).toEqual(
      expect.objectContaining({
        ok: true,
        apiBase: "https://api.elizacloud.ai",
        browserUrl: expect.stringMatching(
          /^https:\/\/www\.elizacloud\.ai\/auth\/cli-login\?session=/,
        ),
      }),
    );
  });

  it("polls native CLI sessions through the Cloud API host", async () => {
    capacitorMocks.get.mockResolvedValue({
      status: 200,
      data: {
        status: "authenticated",
        apiKey: "cloud-api-key",
        organizationId: "org-1",
        userId: "user-1",
      },
    });

    const client = new ElizaClient("https://www.elizacloud.ai");
    const result = await client.cloudLoginPollDirect(
      "https://www.elizacloud.ai",
      "mobile-session",
    );

    expect(capacitorMocks.get).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://api.elizacloud.ai/api/auth/cli-session/mobile-session",
      }),
    );
    expect(result).toEqual({
      status: "authenticated",
      organizationId: "org-1",
      token: "cloud-api-key",
      userId: "user-1",
    });
  });

  it("checks direct Cloud status through the Cloud API user endpoint", async () => {
    capacitorMocks.request.mockResolvedValue({
      status: 200,
      data: {
        success: true,
        data: { id: "user-1", organization_id: "org-1" },
      },
    });

    const client = new ElizaClient(undefined, "cloud-api-key");
    const result = await client.getCloudStatus();

    expect(capacitorMocks.request).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://api.elizacloud.ai/api/v1/user",
        headers: expect.objectContaining({
          Authorization: "Bearer cloud-api-key",
        }),
      }),
    );
    expect(result).toEqual(
      expect.objectContaining({
        connected: true,
        userId: "user-1",
        organizationId: "org-1",
      }),
    );
  });

  it("checks direct Cloud credits through the Cloud API credits endpoint", async () => {
    capacitorMocks.request.mockResolvedValue({
      status: 200,
      data: { balance: 12.5 },
    });

    const client = new ElizaClient(undefined, "cloud-api-key");
    const result = await client.getCloudCredits();

    expect(capacitorMocks.request).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://api.elizacloud.ai/api/v1/credits/balance",
        headers: expect.objectContaining({
          Authorization: "Bearer cloud-api-key",
        }),
      }),
    );
    expect(result).toEqual(
      expect.objectContaining({
        connected: true,
        balance: 12.5,
      }),
    );
  });

  it("lists Cloud agents directly on native without a runtime base URL", async () => {
    capacitorMocks.request.mockResolvedValue({
      status: 200,
      data: {
        success: true,
        data: [
          {
            id: "agent-1",
            agentName: "My Agent",
            status: "running",
            bridgeUrl: "https://agent-1.example.test",
          },
        ],
      },
    });

    const client = new ElizaClient(undefined, "cloud-api-key");
    const result = await client.getCloudCompatAgents();

    expect(capacitorMocks.request).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://api.elizacloud.ai/api/v1/eliza/agents",
        method: "GET",
        headers: expect.objectContaining({
          Authorization: "Bearer cloud-api-key",
        }),
      }),
    );
    expect(result).toEqual({
      success: true,
      data: [
        expect.objectContaining({
          agent_id: "agent-1",
          agent_name: "My Agent",
          status: "running",
          bridge_url: "https://agent-1.example.test",
        }),
      ],
    });
  });

  it("creates and provisions Cloud agents directly on native", async () => {
    capacitorMocks.request
      .mockResolvedValueOnce({
        status: 200,
        data: {
          success: true,
          data: { id: "agent-1", agentName: "My Agent", status: "pending" },
        },
      })
      .mockResolvedValueOnce({
        status: 200,
        data: {
          success: true,
          data: { jobId: "job-1", status: "queued", agentId: "agent-1" },
        },
      });

    const client = new ElizaClient(undefined, "cloud-api-key");
    const create = await client.createCloudCompatAgent({
      agentName: "My Agent",
    });
    const provision = await client.provisionCloudCompatAgent("agent-1");

    expect(capacitorMocks.request).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        url: "https://api.elizacloud.ai/api/v1/eliza/agents",
        method: "POST",
        data: expect.objectContaining({ agentName: "My Agent" }),
      }),
    );
    expect(capacitorMocks.request).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        url: "https://api.elizacloud.ai/api/v1/eliza/agents/agent-1/provision",
        method: "POST",
      }),
    );
    expect(create).toEqual(
      expect.objectContaining({
        success: true,
        data: expect.objectContaining({ agentId: "agent-1" }),
      }),
    );
    expect(provision).toEqual(
      expect.objectContaining({
        success: true,
        data: expect.objectContaining({ jobId: "job-1" }),
      }),
    );
  });

  it("polls direct Cloud provision jobs on native", async () => {
    capacitorMocks.request.mockResolvedValue({
      status: 200,
      data: {
        success: true,
        data: {
          id: "job-1",
          type: "agent_provision",
          status: "completed",
          createdAt: "2026-05-05T00:00:00.000Z",
          completedAt: "2026-05-05T00:01:00.000Z",
        },
      },
    });

    const client = new ElizaClient(undefined, "cloud-api-key");
    const result = await client.getCloudCompatJobStatus("job-1");

    expect(capacitorMocks.request).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://api.elizacloud.ai/api/v1/jobs/job-1",
        method: "GET",
      }),
    );
    expect(result).toEqual(
      expect.objectContaining({
        success: true,
        data: expect.objectContaining({
          jobId: "job-1",
          status: "completed",
        }),
      }),
    );
  });
});
