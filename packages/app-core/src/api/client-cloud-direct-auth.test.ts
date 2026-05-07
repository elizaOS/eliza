import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
import { setBootConfig } from "../config/boot-config";

function calledNativeUrls(): string[] {
  return [
    ...capacitorMocks.get.mock.calls,
    ...capacitorMocks.post.mock.calls,
    ...capacitorMocks.request.mock.calls,
  ]
    .map(([request]) => request?.url)
    .filter((url): url is string => typeof url === "string");
}

function expectNoLocalPersistOrStatusProbe(): void {
  for (const url of calledNativeUrls()) {
    expect(url).not.toContain("localhost");
    expect(url).not.toContain("/api/cloud/login/persist");
    expect(url).not.toBe("https://api.elizacloud.ai/api/status");
  }
}

describe("ElizaClient direct Cloud auth on native", () => {
  beforeEach(() => {
    setBootConfig({
      branding: {},
      cloudApiBase: "https://www.elizacloud.ai",
    });
    delete (globalThis as Record<string, unknown>).__ELIZA_CLOUD_AUTH_TOKEN__;
    capacitorMocks.get.mockReset();
    capacitorMocks.post.mockReset();
    capacitorMocks.request.mockReset();
  });

  afterEach(() => {
    delete (globalThis as Record<string, unknown>).__ELIZA_CLOUD_AUTH_TOKEN__;
    vi.useRealTimers();
    vi.restoreAllMocks();
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
    expectNoLocalPersistOrStatusProbe();
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
    expectNoLocalPersistOrStatusProbe();
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
    expectNoLocalPersistOrStatusProbe();
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
    expectNoLocalPersistOrStatusProbe();
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
    expectNoLocalPersistOrStatusProbe();
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
    expectNoLocalPersistOrStatusProbe();
  });

  it("gets pairing tokens and deletes Cloud agents directly on native", async () => {
    capacitorMocks.request
      .mockResolvedValueOnce({
        status: 200,
        data: {
          success: true,
          data: {
            token: "pair-token",
            redirectUrl: "https://agent.example.test/pair?token=pair-token",
            expiresIn: 60,
          },
        },
      })
      .mockResolvedValueOnce({
        status: 200,
        data: {
          success: true,
          data: { message: "Agent delete complete" },
        },
      });

    const client = new ElizaClient(undefined, "cloud-api-key");
    const pairing = await client.getCloudCompatPairingToken("agent-1");
    const deleted = await client.deleteCloudCompatAgent("agent-1");

    expect(capacitorMocks.request).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        url: "https://api.elizacloud.ai/api/v1/eliza/agents/agent-1/pairing-token",
        method: "POST",
      }),
    );
    expect(capacitorMocks.request).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        url: "https://api.elizacloud.ai/api/v1/eliza/agents/agent-1",
        method: "DELETE",
      }),
    );
    expect(pairing).toEqual(
      expect.objectContaining({
        success: true,
        data: expect.objectContaining({ token: "pair-token" }),
      }),
    );
    expect(deleted).toEqual({
      success: true,
      data: {
        jobId: "",
        status: "deleted",
        message: "Agent delete complete",
      },
    });
    expectNoLocalPersistOrStatusProbe();
  });

  it("fails hung native Cloud provisioning requests instead of waiting forever", async () => {
    vi.useFakeTimers();
    capacitorMocks.request.mockImplementation(
      () => new Promise(() => undefined),
    );

    const client = new ElizaClient(undefined, "cloud-api-key");
    const result = client.provisionCloudCompatAgent("agent-1");
    const expectation = expect(result).rejects.toThrow(
      "Eliza Cloud request timed out after 15s",
    );

    await vi.advanceTimersByTimeAsync(15_000);

    await expectation;
    expect(capacitorMocks.request).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://api.elizacloud.ai/api/v1/eliza/agents/agent-1/provision",
        method: "POST",
      }),
    );
    expectNoLocalPersistOrStatusProbe();
  });

  it("includes the Cloud error body when native direct provisioning is rejected", async () => {
    capacitorMocks.request.mockResolvedValue({
      status: 500,
      data: {
        success: false,
        error: "Failed to start provisioning",
        code: "provision_enqueue_failed",
      },
    });

    const client = new ElizaClient(undefined, "cloud-api-key");

    await expect(client.provisionCloudCompatAgent("agent-1")).rejects.toThrow(
      "Cloud request failed (500): Failed to start provisioning",
    );
    expect(capacitorMocks.request).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://api.elizacloud.ai/api/v1/eliza/agents/agent-1/provision",
        method: "POST",
      }),
    );
    expectNoLocalPersistOrStatusProbe();
  });

  it("accepts an existing native direct provisioning job even when Cloud returns 409", async () => {
    capacitorMocks.request.mockResolvedValue({
      status: 409,
      data: {
        success: true,
        alreadyInProgress: true,
        data: {
          jobId: "job-existing",
          status: "in_progress",
          agentId: "agent-1",
        },
      },
    });

    const client = new ElizaClient(undefined, "cloud-api-key");
    const result = await client.provisionCloudCompatAgent("agent-1");

    expect(result).toEqual(
      expect.objectContaining({
        success: true,
        alreadyInProgress: true,
        data: expect.objectContaining({ jobId: "job-existing" }),
      }),
    );
    expect(capacitorMocks.request).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://api.elizacloud.ai/api/v1/eliza/agents/agent-1/provision",
        method: "POST",
      }),
    );
    expectNoLocalPersistOrStatusProbe();
  });

  it("normalizes native direct provisioning job aliases from Cloud", async () => {
    capacitorMocks.request.mockResolvedValue({
      status: 202,
      data: {
        success: true,
        job_id: "job-top-level",
        state: "queued",
        polling: {
          interval_ms: "1500",
          expected_duration_ms: "90000",
        },
      },
    });

    const client = new ElizaClient(undefined, "cloud-api-key");
    const result = await client.provisionCloudCompatAgent("agent-1");

    expect(result).toEqual(
      expect.objectContaining({
        success: true,
        data: expect.objectContaining({
          agentId: "agent-1",
          jobId: "job-top-level",
          status: "queued",
        }),
        polling: expect.objectContaining({
          intervalMs: 1500,
          expectedDurationMs: 90_000,
        }),
      }),
    );
    expectNoLocalPersistOrStatusProbe();
  });

  it("does not fall back to localhost provisioning on native when the Cloud token is missing", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("native Cloud provisioning must not fetch"));

    const client = new ElizaClient("http://localhost:31337");
    const result = await client.provisionCloudCompatAgent("agent-1");

    expect(result).toEqual(
      expect.objectContaining({
        success: false,
        error: "Eliza Cloud login session is missing. Sign in again.",
      }),
    );
    expect(capacitorMocks.request).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
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
    expectNoLocalPersistOrStatusProbe();
  });

  it("normalizes native direct job status aliases from Cloud", async () => {
    capacitorMocks.request.mockResolvedValue({
      status: 200,
      data: {
        success: true,
        data: {
          job_id: "job-1",
          type: "agent_provision",
          state: "succeeded",
          data: { bridge_url: "https://agent-1.example.test" },
          retry_count: "2",
          created_at: "2026-05-05T00:00:00.000Z",
          completed_at: "2026-05-05T00:01:00.000Z",
        },
      },
    });

    const client = new ElizaClient(undefined, "cloud-api-key");
    const result = await client.getCloudCompatJobStatus("job-1");

    expect(result).toEqual(
      expect.objectContaining({
        success: true,
        data: expect.objectContaining({
          jobId: "job-1",
          status: "completed",
          retryCount: 2,
          data: { bridge_url: "https://agent-1.example.test" },
          completedAt: "2026-05-05T00:01:00.000Z",
        }),
      }),
    );
    expectNoLocalPersistOrStatusProbe();
  });

  it("uses an injected native dev bearer token for Cloud login and agent provisioning without localhost persistence", async () => {
    setBootConfig({
      branding: {},
      apiBase: "http://localhost:31337",
      cloudApiBase: "https://www.elizacloud.ai",
    });
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(
        new Error("native direct Cloud auth must not use fetch"),
      );

    capacitorMocks.post.mockResolvedValue({ status: 200, data: {} });
    capacitorMocks.get.mockResolvedValue({
      status: 200,
      data: {
        status: "authenticated",
        apiKey: "dev-js-bearer",
        organizationId: "org-dev",
        userId: "user-dev",
      },
    });
    capacitorMocks.request.mockImplementation(async ({ url, method }) => {
      if (url === "https://api.elizacloud.ai/api/v1/user") {
        return {
          status: 200,
          data: {
            success: true,
            data: { id: "user-dev", organization_id: "org-dev" },
          },
        };
      }
      if (
        url === "https://api.elizacloud.ai/api/v1/eliza/agents" &&
        method === "GET"
      ) {
        return { status: 200, data: { success: true, data: [] } };
      }
      if (
        url === "https://api.elizacloud.ai/api/v1/eliza/agents" &&
        method === "POST"
      ) {
        return {
          status: 200,
          data: {
            success: true,
            data: {
              id: "agent-dev",
              agentName: "Dev Agent",
              status: "pending",
            },
          },
        };
      }
      if (
        url ===
          "https://api.elizacloud.ai/api/v1/eliza/agents/agent-dev/provision" &&
        method === "POST"
      ) {
        return {
          status: 200,
          data: {
            success: true,
            data: { jobId: "job-dev", status: "queued", agentId: "agent-dev" },
          },
        };
      }
      if (url === "https://api.elizacloud.ai/api/v1/jobs/job-dev") {
        return {
          status: 200,
          data: {
            success: true,
            data: {
              id: "job-dev",
              type: "agent_provision",
              status: "completed",
              result: { bridgeUrl: "https://agent-dev.example.test" },
              createdAt: "2026-05-05T00:00:00.000Z",
              completedAt: "2026-05-05T00:01:00.000Z",
            },
          },
        };
      }
      throw new Error(`Unexpected native Cloud request: ${method} ${url}`);
    });

    const client = new ElizaClient("http://localhost:31337");
    const login = await client.cloudLoginDirect("https://www.elizacloud.ai");
    const poll = await client.cloudLoginPollDirect(
      login.apiBase ?? "https://api.elizacloud.ai",
      login.sessionId ?? "missing-session",
    );
    (globalThis as Record<string, unknown>).__ELIZA_CLOUD_AUTH_TOKEN__ =
      poll.token;

    const status = await client.getCloudStatus();
    const agents = await client.getCloudCompatAgents();
    const create = await client.createCloudCompatAgent({
      agentName: "Dev Agent",
    });
    const provision = await client.provisionCloudCompatAgent("agent-dev");
    const job = await client.getCloudCompatJobStatus("job-dev");

    expect(status).toEqual(
      expect.objectContaining({
        connected: true,
        userId: "user-dev",
        organizationId: "org-dev",
      }),
    );
    expect(agents).toEqual({ success: true, data: [] });
    expect(create.data.agentId).toBe("agent-dev");
    expect(provision.data.jobId).toBe("job-dev");
    expect(job.data).toEqual(
      expect.objectContaining({
        jobId: "job-dev",
        status: "completed",
      }),
    );

    expect(capacitorMocks.request).toHaveBeenCalledTimes(5);
    for (const [request] of capacitorMocks.request.mock.calls) {
      expect(request.headers).toEqual(
        expect.objectContaining({ Authorization: "Bearer dev-js-bearer" }),
      );
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(calledNativeUrls()).toEqual(
      expect.arrayContaining([
        "https://api.elizacloud.ai/api/auth/cli-session",
        expect.stringMatching(
          /^https:\/\/api\.elizacloud\.ai\/api\/auth\/cli-session\//,
        ),
        "https://api.elizacloud.ai/api/v1/user",
        "https://api.elizacloud.ai/api/v1/eliza/agents",
        "https://api.elizacloud.ai/api/v1/eliza/agents/agent-dev/provision",
        "https://api.elizacloud.ai/api/v1/jobs/job-dev",
      ]),
    );
    expectNoLocalPersistOrStatusProbe();
  });

  it("provisions Cloud sandboxes through native HTTP with an injected dev token", async () => {
    vi.useFakeTimers();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(
        new Error("native Cloud provisioning must not use fetch"),
      );
    capacitorMocks.request.mockImplementation(async ({ url, method }) => {
      if (
        url === "https://api.elizacloud.ai/api/v1/eliza/agents" &&
        method === "POST"
      ) {
        return {
          status: 200,
          data: { success: true, data: { id: "sandbox-agent" } },
        };
      }
      if (
        url ===
          "https://api.elizacloud.ai/api/v1/eliza/agents/sandbox-agent/provision" &&
        method === "POST"
      ) {
        return {
          status: 200,
          data: { success: true, data: { jobId: "sandbox-job" } },
        };
      }
      if (url === "https://api.elizacloud.ai/api/v1/jobs/sandbox-job") {
        return {
          status: 200,
          data: {
            success: true,
            data: {
              status: "completed",
              result: { bridgeUrl: "https://sandbox-agent.example.test" },
            },
          },
        };
      }
      throw new Error(`Unexpected sandbox request: ${method} ${url}`);
    });

    const client = new ElizaClient("http://localhost:31337");
    const resultPromise = client.provisionCloudSandbox({
      cloudApiBase: "https://www.elizacloud.ai",
      authToken: "dev-js-bearer",
      name: "Sandbox Agent",
      bio: ["Native package-mode test agent."],
    });

    await vi.waitFor(() =>
      expect(capacitorMocks.request).toHaveBeenCalledTimes(2),
    );
    await vi.advanceTimersByTimeAsync(2000);

    await expect(resultPromise).resolves.toEqual({
      agentId: "sandbox-agent",
      bridgeUrl: "https://sandbox-agent.example.test",
    });
    expect(capacitorMocks.request).toHaveBeenCalledTimes(3);
    expect(capacitorMocks.request).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        url: "https://api.elizacloud.ai/api/v1/eliza/agents",
        method: "POST",
        headers: expect.objectContaining({
          authorization: "Bearer dev-js-bearer",
        }),
        data: expect.objectContaining({
          agentName: "Sandbox Agent",
          agentConfig: { bio: ["Native package-mode test agent."] },
        }),
      }),
    );
    expect(capacitorMocks.request).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        url: "https://api.elizacloud.ai/api/v1/eliza/agents/sandbox-agent/provision",
        method: "POST",
        headers: expect.objectContaining({
          authorization: "Bearer dev-js-bearer",
        }),
      }),
    );
    expect(capacitorMocks.request).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        url: "https://api.elizacloud.ai/api/v1/jobs/sandbox-job",
        method: "GET",
        headers: expect.objectContaining({
          authorization: "Bearer dev-js-bearer",
        }),
      }),
    );
    expect(fetchSpy).not.toHaveBeenCalled();
    expectNoLocalPersistOrStatusProbe();
  });
});
