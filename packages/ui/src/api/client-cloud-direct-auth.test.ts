/**
 * Unit coverage for direct-cloud auth handling in the cloud client. Capacitor
 * HTTP mocked, no live cloud.
 */
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
    capacitorMocks.get.mockReset();
    capacitorMocks.post.mockReset();
    capacitorMocks.request.mockReset();
  });

  afterEach(() => {
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
    // The browser URL normalizes the configured www base to the apex host: the
    // opened window must never ride the www 308 edge (#15143 — the extra hop
    // is where mobile Safari attributed its "document.txt" download).
    expect(result).toEqual(
      expect.objectContaining({
        ok: true,
        apiBase: "https://api.elizacloud.ai",
        browserUrl: expect.stringMatching(
          /^https:\/\/elizacloud\.ai\/auth\/cli-login\?session=/,
        ),
      }),
    );
    expectNoLocalPersistOrStatusProbe();
  });

  it("creates staging CLI sessions through the staging API host and opens the staging web auth host", async () => {
    capacitorMocks.post.mockResolvedValue({ status: 200, data: {} });

    const client = new ElizaClient("https://staging.elizacloud.ai");
    const result = await client.cloudLoginDirect(
      "https://staging.elizacloud.ai",
    );

    expect(capacitorMocks.post).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://api-staging.elizacloud.ai/api/auth/cli-session",
        data: expect.objectContaining({ sessionId: expect.any(String) }),
      }),
    );
    expect(result).toEqual(
      expect.objectContaining({
        ok: true,
        apiBase: "https://api-staging.elizacloud.ai",
        browserUrl: expect.stringMatching(
          /^https:\/\/staging\.elizacloud\.ai\/auth\/cli-login\?session=/,
        ),
      }),
    );
  });

  it("maps staging API bases back to the staging web auth host", async () => {
    capacitorMocks.post.mockResolvedValue({ status: 200, data: {} });

    const client = new ElizaClient("https://api-staging.elizacloud.ai");
    const result = await client.cloudLoginDirect(
      "https://api-staging.elizacloud.ai",
    );

    expect(capacitorMocks.post).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://api-staging.elizacloud.ai/api/auth/cli-session",
      }),
    );
    expect(result).toEqual(
      expect.objectContaining({
        ok: true,
        apiBase: "https://api-staging.elizacloud.ai",
        browserUrl: expect.stringMatching(
          /^https:\/\/staging\.elizacloud\.ai\/auth\/cli-login\?session=/,
        ),
      }),
    );
  });

  it("keeps a staging dedicated agent login on the staging auth host, not the production apex", async () => {
    // Regression for the staging dedicated-ingress fix: a session whose agent
    // base is `<uuid>.staging.elizacloud.ai` belongs to the STAGING tenant.
    // Auth for it must ride the staging API/auth hosts — a hop to the
    // production apex would mint a production session that can never see the
    // staging agent.
    capacitorMocks.post.mockResolvedValue({ status: 200, data: {} });

    const client = new ElizaClient(
      "https://0b5fca39-8d55-4c96-a1a3-000000000000.staging.elizacloud.ai",
    );
    const result = await client.cloudLoginDirect(
      "https://staging.elizacloud.ai",
    );

    expect(capacitorMocks.post).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://api-staging.elizacloud.ai/api/auth/cli-session",
      }),
    );
    expect(result).toEqual(
      expect.objectContaining({
        ok: true,
        apiBase: "https://api-staging.elizacloud.ai",
        browserUrl: expect.stringMatching(
          /^https:\/\/staging\.elizacloud\.ai\/auth\/cli-login\?session=/,
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
        token: "cloud-session-token",
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
      token: "cloud-session-token",
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
            executionTier: "dedicated-always",
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
          execution_tier: "dedicated-always",
        }),
      ],
    });
    if (!result.success) throw new Error("Expected the agent list to load");
    const selected = await client.selectOrProvisionCloudAgent({
      cloudApiBase: "https://api.elizacloud.ai/api/v1",
      authToken: "cloud-api-key",
      name: "My Agent",
      knownAgents: result.data,
      preferSharedTier: true,
      preferStewardAgentAdapter: true,
    });
    expect(selected).toEqual(
      expect.objectContaining({
        agentId: "agent-1",
        apiBase: "https://agent-1.example.test",
        created: false,
      }),
    );
    expect(capacitorMocks.request).toHaveBeenCalledTimes(1);
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

  it("forwards forceCreate into the create POST body so the backend bypasses the reuse guard", async () => {
    capacitorMocks.request.mockResolvedValueOnce({
      status: 200,
      data: {
        success: true,
        data: { id: "dedicated-1", agentName: "My Agent", status: "pending" },
      },
    });

    const client = new ElizaClient(undefined, "cloud-api-key");
    await client.createCloudCompatAgent({
      agentName: "My Agent",
      forceCreate: true,
    });

    expect(capacitorMocks.request).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        url: "https://api.elizacloud.ai/api/v1/eliza/agents",
        method: "POST",
        data: expect.objectContaining({
          agentName: "My Agent",
          forceCreate: true,
        }),
      }),
    );
    expectNoLocalPersistOrStatusProbe();
  });

  it("omits forceCreate from the body by default (request byte-identical for every existing caller)", async () => {
    capacitorMocks.request.mockResolvedValueOnce({
      status: 200,
      data: {
        success: true,
        data: { id: "agent-1", agentName: "My Agent", status: "pending" },
      },
    });

    const client = new ElizaClient(undefined, "cloud-api-key");
    await client.createCloudCompatAgent({ agentName: "My Agent" });

    const body = capacitorMocks.request.mock.calls[0]?.[0]?.data as Record<
      string,
      unknown
    >;
    expect(body).not.toHaveProperty("forceCreate");
  });

  it("accepts an async-provisioning create response that returns agentId without id", async () => {
    // The cloud agent-create async branch (202) returns the new agent's id
    // under `agentId` only — no `id` field. The client must read it instead of
    // throwing "Eliza Cloud response missing data.id" (the new-user dedicated
    // onboarding crash).
    capacitorMocks.request.mockResolvedValueOnce({
      status: 202,
      data: {
        success: true,
        created: true,
        data: {
          agentId: "agent-async-1",
          agentName: "My Agent",
          status: "provisioning",
          jobId: "job-async-1",
        },
      },
    });

    const client = new ElizaClient(undefined, "cloud-api-key");
    const create = await client.createCloudCompatAgent({
      agentName: "My Agent",
    });

    expect(create).toEqual(
      expect.objectContaining({
        success: true,
        data: expect.objectContaining({
          agentId: "agent-async-1",
          status: "provisioning",
        }),
      }),
    );
    expectNoLocalPersistOrStatusProbe();
  });

  it("deletes Cloud agents directly on native", async () => {
    capacitorMocks.request.mockResolvedValueOnce({
      status: 200,
      data: {
        success: true,
        data: { message: "Agent delete complete" },
      },
    });

    const client = new ElizaClient(undefined, "cloud-api-key");
    const deleted = await client.deleteCloudCompatAgent("agent-1");

    expect(capacitorMocks.request).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://api.elizacloud.ai/api/v1/eliza/agents/agent-1",
        method: "DELETE",
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

  it("suspends Cloud agents through the direct Cloud API host on native", async () => {
    capacitorMocks.request.mockResolvedValue({
      status: 202,
      data: {
        success: true,
        data: {
          agentId: "agent-1",
          action: "suspend",
          jobId: "job-suspend",
          status: "queued",
          message: "Suspend job created.",
        },
      },
    });

    const client = new ElizaClient(undefined, "cloud-api-key");
    const result = await client.suspendCloudCompatAgent("agent-1");

    expect(capacitorMocks.request).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://api.elizacloud.ai/api/v1/eliza/agents/agent-1/suspend",
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer cloud-api-key",
        }),
      }),
    );
    expect(result).toEqual({
      success: true,
      data: {
        jobId: "job-suspend",
        status: "queued",
        message: "Suspend job created.",
      },
    });
    expectNoLocalPersistOrStatusProbe();
  });

  it("resumes Cloud agents through the direct Cloud API host on native", async () => {
    capacitorMocks.request.mockResolvedValue({
      status: 202,
      data: {
        success: true,
        data: {
          agentId: "agent-1",
          action: "resume",
          jobId: "job-resume",
          status: "queued",
          message: "Resume job created.",
        },
      },
    });

    const client = new ElizaClient(undefined, "cloud-api-key");
    const result = await client.resumeCloudCompatAgent("agent-1");

    expect(capacitorMocks.request).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://api.elizacloud.ai/api/v1/eliza/agents/agent-1/resume",
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer cloud-api-key",
        }),
      }),
    );
    expect(result).toEqual({
      success: true,
      data: {
        jobId: "job-resume",
        status: "queued",
        message: "Resume job created.",
      },
    });
    expectNoLocalPersistOrStatusProbe();
  });

  // Note: restart is intentionally NOT part of the direct-cloud ladder — the
  // cloud-api has no `/api/v1/eliza/agents/:id/restart` route, so
  // `restartCloudCompatAgent` stays on the legacy `/api/cloud/compat` proxy.

  it("surfaces the Cloud error body when a native suspend is rejected", async () => {
    capacitorMocks.request.mockResolvedValue({
      status: 404,
      data: { success: false, error: "Agent not found" },
    });

    const client = new ElizaClient(undefined, "cloud-api-key");

    await expect(client.suspendCloudCompatAgent("agent-1")).rejects.toThrow(
      "Cloud request failed (404): Agent not found",
    );
    expect(capacitorMocks.request).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://api.elizacloud.ai/api/v1/eliza/agents/agent-1/suspend",
        method: "POST",
      }),
    );
    expectNoLocalPersistOrStatusProbe();
  });

  it("returns the auth-missing result for native lifecycle calls with no Cloud token", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("native lifecycle must not fetch"));

    const client = new ElizaClient("http://localhost:31337");
    const result = await client.resumeCloudCompatAgent("agent-1");

    expect(result).toEqual({
      success: false,
      error: "Eliza Cloud login session is missing. Sign in again.",
      data: {
        jobId: "",
        status: "auth-missing",
        message: "Eliza Cloud login session is missing. Sign in again.",
      },
    });
    expect(capacitorMocks.request).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("threads the 202 jobId through a native direct delete", async () => {
    capacitorMocks.request.mockResolvedValue({
      status: 202,
      data: {
        success: true,
        data: {
          jobId: "job-delete",
          status: "deleting",
          message: "Delete job created.",
        },
      },
    });

    const client = new ElizaClient(undefined, "cloud-api-key");
    const result = await client.deleteCloudCompatAgent("agent-1");

    expect(result).toEqual({
      success: true,
      data: {
        jobId: "job-delete",
        status: "deleting",
        message: "Delete job created.",
      },
    });
    expectNoLocalPersistOrStatusProbe();
  });

  it("launches Cloud agents directly on native and returns the runtime token", async () => {
    capacitorMocks.request.mockResolvedValue({
      status: 200,
      data: {
        success: true,
        data: {
          agentId: "agent-1",
          agentName: "My Agent",
          appUrl: "https://app.elizacloud.ai/",
          launchSessionId: "launch-1",
          issuedAt: "2026-05-09T00:00:00.000Z",
          connection: {
            apiBase: "https://agent-1.elizacloud.ai",
            token: "agent-token",
          },
        },
      },
    });

    const client = new ElizaClient(undefined, "cloud-api-key");
    const launch = await client.launchCloudCompatAgent("agent-1");

    expect(capacitorMocks.request).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://api.elizacloud.ai/api/compat/agents/agent-1/launch",
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer cloud-api-key",
        }),
      }),
    );
    expect(launch).toEqual(
      expect.objectContaining({
        success: true,
        data: expect.objectContaining({
          connection: {
            apiBase: "https://agent-1.elizacloud.ai",
            token: "agent-token",
          },
        }),
      }),
    );
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
    client.setToken(poll.token ?? null);

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
    expect(provision.data?.jobId).toBe("job-dev");
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
          status: 409,
          data: {
            success: true,
            alreadyInProgress: true,
            data: { jobId: "sandbox-job" },
          },
        };
      }
      if (url === "https://api.elizacloud.ai/api/v1/jobs/sandbox-job") {
        return {
          status: 200,
          data: {
            success: true,
            data: {
              status: "completed",
              result: {
                bridgeUrl: "https://sandbox-agent.example.test",
                webUiUrl: "https://sandbox-agent.elizacloud.ai",
              },
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
      webUiUrl: "https://sandbox-agent.elizacloud.ai",
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
          alwaysOn: true,
          autoProvision: false,
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

  it("rejects shared-runtime Cloud agents by default", async () => {
    capacitorMocks.request.mockImplementation(async ({ url, method }) => {
      if (
        url === "https://api.elizacloud.ai/api/v1/eliza/agents" &&
        method === "POST"
      ) {
        return {
          status: 201,
          data: {
            success: true,
            source: "shared_runtime",
            data: {
              id: "shared-agent",
              executionTier: "shared",
            },
          },
        };
      }
      if (
        url ===
          "https://api.elizacloud.ai/api/v1/eliza/agents/shared-agent/provision" &&
        method === "POST"
      ) {
        return {
          status: 200,
          data: {
            success: true,
            source: "shared_runtime",
            data: {
              id: "shared-agent",
              executionTier: "shared",
            },
          },
        };
      }
      throw new Error(`Unexpected shared provision request: ${method} ${url}`);
    });

    const client = new ElizaClient("http://localhost:31337");
    await expect(
      client.provisionCloudSandbox({
        cloudApiBase: "https://www.elizacloud.ai",
        authToken: "dev-js-bearer",
        name: "Shared Agent",
        bio: ["Native package-mode test agent."],
      }),
    ).rejects.toThrow(/requires a dedicated sandbox/);
    expect(capacitorMocks.request).toHaveBeenCalledTimes(2);
    expectNoLocalPersistOrStatusProbe();
  });

  it("accepts shared-runtime Cloud agents only when explicitly opted in", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(
        new Error("native shared Cloud provisioning must not use fetch"),
      );
    capacitorMocks.request.mockImplementation(async ({ url, method }) => {
      if (
        url === "https://api.elizacloud.ai/api/v1/eliza/agents" &&
        method === "POST"
      ) {
        return {
          status: 201,
          data: {
            success: true,
            source: "shared_runtime",
            data: {
              id: "shared-agent",
              executionTier: "shared",
            },
          },
        };
      }
      if (
        url ===
          "https://api.elizacloud.ai/api/v1/eliza/agents/shared-agent/provision" &&
        method === "POST"
      ) {
        return {
          status: 200,
          data: {
            success: true,
            source: "shared_runtime",
            data: {
              id: "shared-agent",
              executionTier: "shared",
            },
          },
        };
      }
      throw new Error(`Unexpected shared provision request: ${method} ${url}`);
    });

    const client = new ElizaClient("http://localhost:31337");
    const result = await client.provisionCloudSandbox({
      cloudApiBase: "https://www.elizacloud.ai",
      authToken: "dev-js-bearer",
      name: "Shared Agent",
      bio: ["Native package-mode test agent."],
      allowSharedRuntime: true,
    });

    expect(result).toEqual({
      agentId: "shared-agent",
      bridgeUrl:
        "https://api.elizacloud.ai/api/v1/eliza/agents/shared-agent/bridge",
      webUiUrl: "https://api.elizacloud.ai/api/v1/eliza/agents/shared-agent",
      executionTier: "shared",
    });
    expect(result.bridgeUrl).toContain("/api/v1/eliza/agents/shared-agent/");
    expect(capacitorMocks.request).toHaveBeenCalledTimes(2);
    expect(fetchSpy).not.toHaveBeenCalled();
    expectNoLocalPersistOrStatusProbe();
  });
});
