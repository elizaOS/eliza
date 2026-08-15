/**
 * Unit coverage for the typed wake/provision failure surface (#18463): the
 * dedicated-agent wait must surface non-transient control-plane failures
 * (auth expiry, credits, missing row, conflict, worker outage) immediately as
 * `CloudAgentWakeError` with status + Retry-After + correlation ids, keep
 * retrying only transient errors, and follow a fresh create's provisioning
 * job to terminal instead of discarding its jobId. Mocked client, no live
 * cloud.
 */
import { ElizaError } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => false },
  CapacitorHttp: { get: vi.fn(), post: vi.fn(), request: vi.fn() },
}));

import { CloudAgentWakeError as PublicCloudAgentWakeError } from "./client";
import { ElizaClient } from "./client-base";
import {
  CloudAgentWakeError,
  waitForCloudAgentRunning,
  waitForCloudProvisionJob,
} from "./client-cloud";
import type { CloudCompatAgent } from "./client-types-cloud";
import { isCloudAgentGoneError } from "./client-types-core";

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
  it("exports the typed error through the public API barrel", () => {
    expect(PublicCloudAgentWakeError).toBe(CloudAgentWakeError);
  });

  it("surfaces a resolved resume rejection instead of entering the status poll", async () => {
    const client = fakeClient({
      resumeCloudCompatAgent: vi.fn(async () => ({
        success: false,
        error: "Eliza Cloud login session is missing. Sign in again.",
        data: { status: "auth-missing" },
      })),
      getCloudCompatAgent: vi.fn(),
    });
    const error = await waitForCloudAgentRunning(client, {
      agentId: "agent-1",
      ...FAST,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CloudAgentWakeError);
    expect((error as CloudAgentWakeError).phase).toBe("resume");
    expect((error as CloudAgentWakeError).code).toBe(
      "CLOUD_AGENT_RESUME_REJECTED",
    );
    expect(client.getCloudCompatAgent).not.toHaveBeenCalled();
  });

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

  it("surfaces a resolved detail-read rejection instead of timing out", async () => {
    const client = fakeClient({
      resumeCloudCompatAgent: vi.fn(async () => ({ success: true })),
      getCloudCompatAgent: vi.fn(async () => ({
        success: false,
        error: "Cloud session expired",
        data: makeAgent({ status: "auth-missing" }),
      })),
    });
    const error = await waitForCloudAgentRunning(client, {
      agentId: "agent-1",
      ...FAST,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CloudAgentWakeError);
    expect((error as CloudAgentWakeError).phase).toBe("status-poll");
    expect((error as CloudAgentWakeError).message).toBe(
      "Cloud session expired",
    );
    expect(client.getCloudCompatAgent).toHaveBeenCalledTimes(1);
  });

  it("does not retry an unclassified client HTTP rejection", async () => {
    const client = fakeClient({
      resumeCloudCompatAgent: vi
        .fn()
        .mockRejectedValue(httpError(400, { code: "invalid_request" })),
      getCloudCompatAgent: vi.fn(),
    });
    const error = await waitForCloudAgentRunning(client, {
      agentId: "agent-1",
      ...FAST,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CloudAgentWakeError);
    expect((error as CloudAgentWakeError).status).toBe(400);
    expect((error as CloudAgentWakeError).code).toBe("invalid_request");
    expect(client.getCloudCompatAgent).not.toHaveBeenCalled();
  });

  it("preserves agent_not_found through the typed wrapper for stale-binding recovery", async () => {
    const client = fakeClient({
      resumeCloudCompatAgent: vi.fn(async () => ({ success: true })),
      getCloudCompatAgent: vi.fn().mockRejectedValue(
        httpError(404, {
          data: { code: "agent_not_found", error: "Agent not found" },
        }),
      ),
    });
    const error = await waitForCloudAgentRunning(client, {
      agentId: "agent-1",
      ...FAST,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CloudAgentWakeError);
    expect((error as CloudAgentWakeError).code).toBe("agent_not_found");
    expect(isCloudAgentGoneError(error)).toBe(true);
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

  it("preserves a direct-cloud Retry-After header and structured code", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          success: false,
          code: "provisioning_capacity_unavailable",
          error: "No provisioning worker is currently available",
        }),
        {
          status: 503,
          headers: {
            "Content-Type": "application/json",
            "Retry-After": "17",
          },
        },
      ),
    );
    try {
      const client = new ElizaClient("https://api.eliza.app", "test-token");
      const error = await waitForCloudAgentRunning(client, {
        agentId: "agent-1",
        ...FAST,
      }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(CloudAgentWakeError);
      const wake = error as CloudAgentWakeError;
      expect(wake.status).toBe(503);
      expect(wake.retryAfter).toBe(17);
      expect(wake.code).toBe("provisioning_capacity_unavailable");
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(String(fetchSpy.mock.calls[0]?.[0])).toContain(
        "/api/v1/eliza/agents/agent-1/resume",
      );
    } finally {
      fetchSpy.mockRestore();
    }
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
  it("surfaces a resolved job-read rejection instead of treating it as progress", async () => {
    const client = fakeClient({
      getCloudCompatJobStatus: vi.fn(async () => ({
        success: false,
        error: "Eliza Cloud login session is missing. Sign in again.",
        data: { status: "failed", state: "failed" },
      })),
    });
    const error = await waitForCloudProvisionJob(client, {
      agentId: "agent-1",
      jobId: "job-1",
      ...FAST,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CloudAgentWakeError);
    expect((error as CloudAgentWakeError).code).toBe(
      "CLOUD_PROVISION_JOB_STATUS_REJECTED",
    );
    expect(client.getCloudCompatJobStatus).toHaveBeenCalledTimes(1);
  });

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

  it("returns the create receipt when cancellation lands during job polling", async () => {
    const controller = new AbortController();
    const reason = new DOMException("cancelled", "AbortError");
    let markJobReadStarted!: () => void;
    let releaseJobRead!: () => void;
    const jobReadStarted = new Promise<void>((resolve) => {
      markJobReadStarted = resolve;
    });
    const releaseJob = new Promise<void>((resolve) => {
      releaseJobRead = resolve;
    });
    const client = fakeClient({
      getCloudCompatAgents: vi.fn(async () => ({ success: true, data: [] })),
      createCloudCompatAgent: vi.fn(async () => ({
        success: true,
        created: true,
        data: {
          agentId: "agent-new",
          agentName: "Eliza",
          jobId: "job-9",
          status: "provisioning",
          nodeId: null,
          message: "",
        },
      })),
      getCloudCompatJobStatus: vi.fn(async () => {
        markJobReadStarted();
        await releaseJob;
        return {
          success: true,
          data: { status: "in_progress", state: "in_progress" },
        };
      }),
    });

    const selection = client.selectOrProvisionCloudAgent({
      cloudApiBase: "https://api.eliza.app/api/v1",
      authToken: "test-token",
      name: "Eliza",
      signal: controller.signal,
      wakePollIntervalMs: 1,
      wakeTimeoutMs: 1_000,
    });
    await jobReadStarted;
    controller.abort(reason);
    releaseJobRead();

    await expect(selection).resolves.toMatchObject({
      agentId: "agent-new",
      created: true,
    });
  });

  it("returns the create receipt when cancellation lands during running polling", async () => {
    const controller = new AbortController();
    const reason = new DOMException("cancelled", "AbortError");
    let markRunningReadStarted!: () => void;
    let resolveRunningRead!: () => void;
    const runningReadStarted = new Promise<void>((resolve) => {
      markRunningReadStarted = resolve;
    });
    const releaseRunningRead = new Promise<void>((resolve) => {
      resolveRunningRead = resolve;
    });
    const startingAgent = makeAgent({
      agent_id: "agent-new",
      status: "starting",
      web_ui_url: "https://agent-new.cloud.eliza.app",
      webUiUrl: "https://agent-new.cloud.eliza.app",
    });
    const getCloudCompatAgent = vi
      .fn()
      .mockResolvedValueOnce({ success: true, data: startingAgent })
      .mockImplementationOnce(async () => {
        markRunningReadStarted();
        await releaseRunningRead;
        return { success: true, data: startingAgent };
      });
    const client = fakeClient({
      getCloudCompatAgents: vi.fn(async () => ({ success: true, data: [] })),
      createCloudCompatAgent: vi.fn(async () => ({
        success: true,
        created: true,
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
        data: { status: "completed", state: "completed" },
      })),
      getCloudCompatAgent,
      resumeCloudCompatAgent: vi.fn(async () => ({ success: true })),
    });

    const selection = client.selectOrProvisionCloudAgent({
      cloudApiBase: "https://api.eliza.app/api/v1",
      authToken: "test-token",
      name: "Eliza",
      signal: controller.signal,
      wakePollIntervalMs: 1,
      wakeTimeoutMs: 1_000,
    });
    await runningReadStarted;
    controller.abort(reason);
    resolveRunningRead();

    await expect(selection).resolves.toMatchObject({
      agentId: "agent-new",
      created: true,
    });
  });
});

describe("CloudAgentWakeError — real typed-error identity", () => {
  it("is an ElizaError carrying the wake code and context", async () => {
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
    // The class must extend the real ElizaError, not a degraded plain-Error
    // base: `code`/`context` are what `isCloudAgentGoneError` and the error
    // reporters read, and a fixture bundle that swapped the base would
    // exercise a different class than production.
    expect(error).toBeInstanceOf(ElizaError);
    expect(error).toBeInstanceOf(CloudAgentWakeError);
    const wake = error as CloudAgentWakeError;
    expect(wake.code).toBe("CLOUD_AGENT_WAKE_FAILED");
    expect(wake.context).toMatchObject({
      phase: "resume",
      agentId: "agent-1",
      status: 402,
      retryAfter: 30,
    });
  });
});

describe("throttled wake polls stay transient and honor Retry-After", () => {
  it("keeps polling through a 429 status read instead of aborting the join", async () => {
    const client = fakeClient({
      resumeCloudCompatAgent: vi.fn(async () => ({ success: true })),
      getCloudCompatAgent: vi
        .fn()
        .mockRejectedValueOnce(httpError(429, { retryAfter: 0 }))
        .mockRejectedValueOnce(httpError(408))
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

  it("waits the Retry-After the control plane asked for before the next tick", async () => {
    const client = fakeClient({
      resumeCloudCompatAgent: vi.fn(async () => ({ success: true })),
      getCloudCompatAgent: vi
        .fn()
        .mockRejectedValueOnce(httpError(429, { retryAfter: 0.12 }))
        .mockResolvedValue({ success: true, data: makeAgent() }),
    });
    const startedAt = Date.now();
    const agent = await waitForCloudAgentRunning(client, {
      agentId: "agent-1",
      pollIntervalMs: 1,
      timeoutMs: 5_000,
    });
    // Re-polling on the 1ms tick would earn another 429; the loop must back off
    // for the 120ms the backend named.
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(100);
    expect(agent.status).toBe("running");
  });

  it("keeps polling through a 429 job read and honors its Retry-After", async () => {
    const client = fakeClient({
      getCloudCompatJobStatus: vi
        .fn()
        .mockRejectedValueOnce(httpError(429, { data: { retry_after: 0.12 } }))
        .mockResolvedValue({
          success: true,
          data: { status: "completed", state: "completed" },
        }),
    });
    const startedAt = Date.now();
    await waitForCloudProvisionJob(client, {
      agentId: "agent-1",
      jobId: "job-1",
      pollIntervalMs: 1,
      timeoutMs: 5_000,
    });
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(100);
    expect(client.getCloudCompatJobStatus).toHaveBeenCalledTimes(2);
  });
});

describe("selectOrProvisionCloudAgent — one wake budget for the whole join", () => {
  it("spends the provisioning wait out of the same deadline as the running wait", async () => {
    const WAKE_TIMEOUT_MS = 300;
    const JOB_LATENCY_MS = 240;
    const getCloudCompatAgent = vi.fn(async () => ({
      success: true,
      data: makeAgent({
        agent_id: "agent-new",
        status: "starting",
        web_ui_url: "https://agent-new.elizacloud.ai",
        webUiUrl: "https://agent-new.elizacloud.ai",
      }),
    }));
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
      getCloudCompatJobStatus: vi.fn(async () => {
        await new Promise((r) => setTimeout(r, JOB_LATENCY_MS));
        return {
          success: true,
          data: { status: "completed", state: "completed" },
        };
      }),
      getCloudCompatAgent,
      resumeCloudCompatAgent: vi.fn(async () => ({ success: true })),
    });

    const startedAt = Date.now();
    const error = await client
      .selectOrProvisionCloudAgent({
        cloudApiBase: "https://api.elizacloud.ai/api/v1",
        authToken: "test-token",
        name: "Eliza",
        wakePollIntervalMs: 1,
        wakeTimeoutMs: WAKE_TIMEOUT_MS,
      })
      .catch((e: unknown) => e);
    const elapsedMs = Date.now() - startedAt;

    expect(error).toBeInstanceOf(CloudAgentWakeError);
    expect((error as CloudAgentWakeError).phase).toBe("timeout");
    // Before the shared deadline each wait got the full budget, so a job that
    // finished just under the wire handed a fresh full timeout to the status
    // poll — the doubled spinner of #18463.
    expect(elapsedMs).toBeLessThan(JOB_LATENCY_MS + WAKE_TIMEOUT_MS);
    expect(elapsedMs).toBeGreaterThanOrEqual(JOB_LATENCY_MS);
  });
});
