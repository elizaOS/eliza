/**
 * Unit coverage for the typed wake/provision failure surface (#18463): the
 * dedicated-agent wait must surface non-transient control-plane failures
 * (auth expiry, credits, missing row, conflict, worker outage) immediately as
 * `CloudAgentWakeError` with status + Retry-After + correlation ids, keep
 * retrying only transient errors, and follow a fresh create's provisioning
 * job to terminal instead of discarding its jobId. Mocked client, no live
 * cloud.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => false },
  CapacitorHttp: { get: vi.fn(), post: vi.fn(), request: vi.fn() },
}));

import { ElizaClient } from "./client-base";
import {
  CloudAgentWakeError,
  waitForCloudAgentRunning,
  waitForCloudProvisionJob,
} from "./client-cloud";
import type { CloudCompatAgent } from "./client-types-cloud";

function makeAgent(
  overrides: Partial<CloudCompatAgent> = {},
): CloudCompatAgent {
  return {
    agent_id: "agent-1",
    agent_name: "Eliza",
    node_id: null,
    container_id: null,
    headscale_ip: null,
    bridge_url: null,
    web_ui_url: "https://agent-1.example.test",
    status: "running",
    agent_config: {},
    created_at: "2026-08-01T00:00:00.000Z",
    updated_at: "2026-08-01T00:00:00.000Z",
    containerUrl: "",
    webUiUrl: "https://agent-1.example.test",
    database_status: "ok",
    error_message: null,
    last_heartbeat_at: null,
    execution_tier: "dedicated-always",
    ...overrides,
  };
}

/** Transport-shaped rejection: both ApiError and the direct-cloud throw carry `status`. */
function httpError(
  status: number,
  extras: Record<string, unknown> = {},
): Error {
  return Object.assign(new Error(`HTTP ${status} from cloud`), {
    status,
    ...extras,
  });
}

function fakeClient(mocks: Record<string, unknown>): ElizaClient {
  const client = Object.create(ElizaClient.prototype) as ElizaClient;
  Object.assign(client, mocks);
  return client;
}

const FAST = { pollIntervalMs: 1, timeoutMs: 60 };

describe("waitForCloudAgentRunning — typed non-transient failures", () => {
  it("surfaces a 402 resume rejection immediately with status and Retry-After", async () => {
    const client = fakeClient({
      resumeCloudCompatAgent: vi
        .fn()
        .mockRejectedValue(httpError(402, { retryAfter: 30 })),
      getCloudCompatAgent: vi.fn(),
    });
    const error = await waitForCloudAgentRunning(client, {
      agentId: "agent-1",
      ...FAST,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CloudAgentWakeError);
    const wake = error as CloudAgentWakeError;
    expect(wake.phase).toBe("resume");
    expect(wake.status).toBe(402);
    expect(wake.retryAfter).toBe(30);
    expect(wake.agentId).toBe("agent-1");
    expect(wake.message).toMatch(/HTTP 402/);
    expect(wake.message).toMatch(/about 30s/);
    // Never fell through to the six-minute poll.
    expect(client.getCloudCompatAgent).not.toHaveBeenCalled();
  });

  it("surfaces a 401 detail-poll rejection immediately instead of masking it until timeout", async () => {
    const client = fakeClient({
      resumeCloudCompatAgent: vi.fn(async () => ({ success: true })),
      getCloudCompatAgent: vi.fn().mockRejectedValue(httpError(401)),
    });
    const error = await waitForCloudAgentRunning(client, {
      agentId: "agent-1",
      ...FAST,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CloudAgentWakeError);
    const wake = error as CloudAgentWakeError;
    expect(wake.phase).toBe("status-poll");
    expect(wake.status).toBe(401);
    expect((wake.cause as Error).message).toMatch(/HTTP 401/);
    expect(client.getCloudCompatAgent).toHaveBeenCalledTimes(1);
  });

  it("reads Retry-After out of a direct-cloud 503 error body", async () => {
    const client = fakeClient({
      resumeCloudCompatAgent: vi.fn(async () => ({ success: true })),
      getCloudCompatAgent: vi
        .fn()
        .mockRejectedValue(httpError(503, { data: { retry_after: 45 } })),
    });
    const error = await waitForCloudAgentRunning(client, {
      agentId: "agent-1",
      ...FAST,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CloudAgentWakeError);
    expect((error as CloudAgentWakeError).status).toBe(503);
    expect((error as CloudAgentWakeError).retryAfter).toBe(45);
  });

  it("keeps polling through transient failures (network / other 5xx) and resolves", async () => {
    const client = fakeClient({
      resumeCloudCompatAgent: vi.fn().mockRejectedValue(new Error("offline")),
      getCloudCompatAgent: vi
        .fn()
        .mockRejectedValueOnce(httpError(500))
        .mockRejectedValueOnce(new Error("socket hang up"))
        .mockResolvedValue({ success: true, data: makeAgent() }),
    });
    const agent = await waitForCloudAgentRunning(client, {
      agentId: "agent-1",
      pollIntervalMs: 1,
      timeoutMs: 1_000,
    });
    expect(agent.status).toBe("running");
    expect(client.getCloudCompatAgent).toHaveBeenCalledTimes(3);
  });

  it("times out with phase, last observed status, and the agent correlation id", async () => {
    const client = fakeClient({
      resumeCloudCompatAgent: vi.fn(async () => ({ success: true })),
      getCloudCompatAgent: vi.fn(async () => ({
        success: true,
        data: makeAgent({ status: "starting" }),
      })),
    });
    const error = await waitForCloudAgentRunning(client, {
      agentId: "agent-1",
      ...FAST,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CloudAgentWakeError);
    const wake = error as CloudAgentWakeError;
    expect(wake.phase).toBe("timeout");
    expect(wake.lastObservedStatus).toBe("starting");
    expect(wake.message).toMatch(/still "starting" after \d+s/);
    expect(wake.message).toContain("agent-1");
  });
});

describe("waitForCloudProvisionJob — canonical job followed to terminal", () => {
  it("resolves when the job completes", async () => {
    const client = fakeClient({
      getCloudCompatJobStatus: vi
        .fn()
        .mockResolvedValueOnce({
          success: true,
          data: { status: "processing", state: "in_progress" },
        })
        .mockResolvedValueOnce({
          success: true,
          data: { status: "completed", state: "completed" },
        }),
    });
    await expect(
      waitForCloudProvisionJob(client, {
        agentId: "agent-1",
        jobId: "job-1",
        pollIntervalMs: 1,
        timeoutMs: 1_000,
      }),
    ).resolves.toBeUndefined();
    expect(client.getCloudCompatJobStatus).toHaveBeenCalledWith("job-1");
  });

  it("surfaces a failed job with its real reason and both correlation ids", async () => {
    const client = fakeClient({
      getCloudCompatJobStatus: vi.fn(async () => ({
        success: true,
        data: {
          status: "failed",
          state: "failed",
          error: "no provisioning worker available",
        },
      })),
    });
    const error = await waitForCloudProvisionJob(client, {
      agentId: "agent-1",
      jobId: "job-1",
      ...FAST,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CloudAgentWakeError);
    const wake = error as CloudAgentWakeError;
    expect(wake.phase).toBe("provision-job");
    expect(wake.agentId).toBe("agent-1");
    expect(wake.jobId).toBe("job-1");
    expect(wake.message).toMatch(/failed to start.*no provisioning worker/i);
  });

  it("surfaces a non-transient job read (503 + Retry-After) immediately", async () => {
    const client = fakeClient({
      getCloudCompatJobStatus: vi
        .fn()
        .mockRejectedValue(httpError(503, { retryAfter: 20 })),
    });
    const error = await waitForCloudProvisionJob(client, {
      agentId: "agent-1",
      jobId: "job-1",
      ...FAST,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CloudAgentWakeError);
    expect((error as CloudAgentWakeError).status).toBe(503);
    expect((error as CloudAgentWakeError).retryAfter).toBe(20);
    expect(client.getCloudCompatJobStatus).toHaveBeenCalledTimes(1);
  });

  it("keeps polling through a transient job read, then times out truthfully", async () => {
    const client = fakeClient({
      getCloudCompatJobStatus: vi.fn().mockRejectedValue(new Error("blip")),
    });
    const error = await waitForCloudProvisionJob(client, {
      agentId: "agent-1",
      jobId: "job-1",
      ...FAST,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CloudAgentWakeError);
    const wake = error as CloudAgentWakeError;
    expect(wake.phase).toBe("timeout");
    expect(wake.message).toContain("job-1");
    expect(
      (client.getCloudCompatJobStatus as ReturnType<typeof vi.fn>).mock.calls
        .length,
    ).toBeGreaterThan(1);
  });
});

describe("selectOrProvisionCloudAgent — fresh create follows its job", () => {
  it("rejects with the job's failure instead of polling agent detail for six minutes", async () => {
    const getCloudCompatAgent = vi.fn();
    const client = fakeClient({
      getCloudCompatAgents: vi.fn(async () => ({ success: true, data: [] })),
      createCloudCompatAgent: vi.fn(async () => ({
        success: true,
        data: {
          agentId: "agent-new",
          agentName: "Eliza",
          jobId: "job-9",
          status: "provisioning",
          nodeId: null,
          message: "",
        },
      })),
      getCloudCompatJobStatus: vi.fn(async () => ({
        success: true,
        data: { status: "failed", state: "failed", error: "image pull failed" },
      })),
      getCloudCompatAgent,
      resumeCloudCompatAgent: vi.fn(async () => ({ success: true })),
    });
    const error = await client
      .selectOrProvisionCloudAgent({
        cloudApiBase: "https://api.elizacloud.ai/api/v1",
        authToken: "test-token",
        name: "Eliza",
        wakePollIntervalMs: 1,
        wakeTimeoutMs: 60,
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CloudAgentWakeError);
    expect((error as CloudAgentWakeError).jobId).toBe("job-9");
    expect((error as CloudAgentWakeError).message).toMatch(/image pull failed/);
    expect(getCloudCompatAgent).not.toHaveBeenCalled();
  });
});
