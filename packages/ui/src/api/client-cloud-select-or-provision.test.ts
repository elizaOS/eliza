/**
 * Unit coverage for the cloud select-or-provision-agent flow. Capacitor mocked,
 * no live cloud.
 */
import { ElizaError } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => false },
  CapacitorHttp: { get: vi.fn(), post: vi.fn(), request: vi.fn() },
}));

import { ElizaClient } from "./client-base";
// Side-effect import: patches selectOrProvisionCloudAgent onto the prototype.
import "./client-cloud";
import type {
  CloudAgentJoinProgress,
  CloudCompatAgent,
  CloudCompatJob,
} from "./client-types-cloud";
import { isCloudAgentGoneError } from "./client-types-core";
import { cloudAgentJoinProgressFromError } from "./cloud-agent-join-progress";

/**
 * selectOrProvisionCloudAgent reuses an existing cloud agent instead of minting
 * a new (billed, dedicated) one on every sign-in. The launch-blocking failure
 * mode shaw reported as "it creates multiple agents" was a swallowed list-fetch
 * error: a transient failure (expired token, network blip, or a success:false
 * body) collapsed to an empty list and fell through to provisioning — so an
 * existing agent silently became a duplicate. The contract under test: ONLY an
 * authoritative success list may conclude the user has no agent to reuse.
 */

function makeAgent(
  overrides: Partial<CloudCompatAgent> = {},
): CloudCompatAgent {
  return {
    agent_id: "agent-existing",
    agent_name: "Eliza",
    node_id: null,
    container_id: null,
    headscale_ip: null,
    bridge_url: null,
    web_ui_url: "https://agent-existing.example.test",
    status: "running",
    agent_config: {},
    created_at: "2026-06-24T00:00:00.000Z",
    updated_at: "2026-06-24T00:00:00.000Z",
    containerUrl: "",
    webUiUrl: "https://agent-existing.example.test",
    database_status: "ok",
    error_message: null,
    last_heartbeat_at: null,
    execution_tier: "dedicated-always",
    ...overrides,
  };
}

function makeJob(
  jobId: string,
  overrides: Partial<CloudCompatJob> = {},
): CloudCompatJob {
  return {
    jobId,
    type: "agent_provision",
    status: "completed",
    data: {},
    result: null,
    error: null,
    createdAt: "2026-08-11T00:00:00.000Z",
    startedAt: "2026-08-11T00:00:00.000Z",
    completedAt: "2026-08-11T00:00:01.000Z",
    retryCount: 0,
    id: jobId,
    name: "agent_provision",
    state: "completed",
    created_on: "2026-08-11T00:00:00.000Z",
    completed_on: "2026-08-11T00:00:01.000Z",
    ...overrides,
  };
}

function fakeClient() {
  const getCloudCompatAgents = vi.fn();
  const createCloudCompatAgent = vi.fn();
  const getCloudCompatAgent = vi.fn();
  const getCloudCompatJobStatus = vi.fn(async (jobId: string) => ({
    success: true,
    data: makeJob(jobId),
  }));
  const provisionCloudCompatAgent = vi.fn(async (agentId: string) => ({
    success: true,
    alreadyInProgress: true,
    data: {
      agentId,
      jobId: `provision-${agentId}`,
      status: "queued",
    },
  }));
  const resumeCloudCompatAgent = vi.fn(async (agentId: string) => ({
    success: true,
    data: {
      jobId: `resume-${agentId}`,
      status: "queued",
      message: "Agent resume enqueued",
    },
  }));
  const wakeCloudCompatAgent = vi.fn(async (agentId: string) => ({
    success: true,
    data: {
      jobId: `wake-${agentId}`,
      status: "queued",
      message: "Agent wake enqueued",
    },
  }));
  const client = Object.create(ElizaClient.prototype) as ElizaClient;
  Object.assign(client, {
    getCloudCompatAgents,
    createCloudCompatAgent,
    getCloudCompatAgent,
    getCloudCompatJobStatus,
    provisionCloudCompatAgent,
    resumeCloudCompatAgent,
    wakeCloudCompatAgent,
  });
  return {
    client,
    getCloudCompatAgents,
    createCloudCompatAgent,
    getCloudCompatAgent,
    getCloudCompatJobStatus,
    provisionCloudCompatAgent,
    resumeCloudCompatAgent,
    wakeCloudCompatAgent,
  };
}

const BASE_OPTS = {
  cloudApiBase: "https://api.elizacloud.ai/api/v1",
  authToken: "test-token",
  name: "Eliza",
};

describe("selectOrProvisionCloudAgent — never duplicate on a failed lookup", () => {
  it("reuses the existing agent and never provisions when the list succeeds", async () => {
    const { client, getCloudCompatAgents, createCloudCompatAgent } =
      fakeClient();
    getCloudCompatAgents.mockResolvedValue({
      success: true,
      data: [makeAgent()],
    });

    const result = await client.selectOrProvisionCloudAgent(BASE_OPTS);

    expect(result.created).toBe(false);
    expect(result.agentId).toBe("agent-existing");
    expect(createCloudCompatAgent).not.toHaveBeenCalled();
  });

  it("reuses a caller-provided successful list without a second lookup", async () => {
    const { client, getCloudCompatAgents, createCloudCompatAgent } =
      fakeClient();
    getCloudCompatAgents.mockRejectedValue(new Error("second list forbidden"));

    const result = await client.selectOrProvisionCloudAgent({
      ...BASE_OPTS,
      knownAgents: [makeAgent({ agent_id: "agent-from-first-run-list" })],
    });

    expect(result.created).toBe(false);
    expect(result.agentId).toBe("agent-from-first-run-list");
    expect(getCloudCompatAgents).not.toHaveBeenCalled();
    expect(createCloudCompatAgent).not.toHaveBeenCalled();
  });

  it("resumes and reuses a non-running existing agent instead of provisioning a duplicate", async () => {
    const {
      client,
      getCloudCompatAgents,
      createCloudCompatAgent,
      getCloudCompatAgent,
      resumeCloudCompatAgent,
    } = fakeClient();
    getCloudCompatAgents.mockResolvedValue({
      success: true,
      data: [makeAgent({ status: "stopped" })],
    });
    getCloudCompatAgent.mockResolvedValue({
      success: true,
      data: makeAgent({
        status: "running",
        web_ui_url: "https://agent-existing.example.test",
        webUiUrl: "https://agent-existing.example.test",
      }),
    });

    const result = await client.selectOrProvisionCloudAgent({
      ...BASE_OPTS,
      wakePollIntervalMs: 1,
      wakeTimeoutMs: 50,
    });

    expect(result.created).toBe(false);
    expect(result.agentId).toBe("agent-existing");
    expect(resumeCloudCompatAgent).toHaveBeenCalledWith("agent-existing");
    expect(createCloudCompatAgent).not.toHaveBeenCalled();
  });

  it("wakes a sleeping agent through the canonical restore path and polls its job", async () => {
    const {
      client,
      createCloudCompatAgent,
      getCloudCompatAgent,
      getCloudCompatAgents,
      getCloudCompatJobStatus,
      provisionCloudCompatAgent,
      resumeCloudCompatAgent,
      wakeCloudCompatAgent,
    } = fakeClient();
    getCloudCompatAgents.mockResolvedValue({
      success: true,
      data: [makeAgent({ status: "sleeping" })],
    });
    getCloudCompatAgent.mockResolvedValue({
      success: true,
      data: makeAgent({ status: "running" }),
    });

    const result = await client.selectOrProvisionCloudAgent({
      ...BASE_OPTS,
      wakePollIntervalMs: 1,
      wakeTimeoutMs: 50,
    });

    expect(wakeCloudCompatAgent).toHaveBeenCalledOnce();
    expect(wakeCloudCompatAgent).toHaveBeenCalledWith("agent-existing");
    expect(getCloudCompatJobStatus).toHaveBeenCalledWith("wake-agent-existing");
    expect(resumeCloudCompatAgent).not.toHaveBeenCalled();
    expect(provisionCloudCompatAgent).not.toHaveBeenCalled();
    expect(createCloudCompatAgent).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      agentId: "agent-existing",
      created: false,
      jobId: "wake-agent-existing",
      source: "existing_wake",
      progress: {
        phase: "running",
        source: "existing_wake",
        correlationId: "wake-agent-existing",
      },
    });
  });

  it("reprovisions a disconnected agent idempotently without resume, wake, or create", async () => {
    const {
      client,
      createCloudCompatAgent,
      getCloudCompatAgent,
      getCloudCompatAgents,
      getCloudCompatJobStatus,
      provisionCloudCompatAgent,
      resumeCloudCompatAgent,
      wakeCloudCompatAgent,
    } = fakeClient();
    getCloudCompatAgents.mockResolvedValue({
      success: true,
      data: [makeAgent({ status: "disconnected" })],
    });
    provisionCloudCompatAgent.mockResolvedValue({
      success: true,
      alreadyInProgress: true,
      data: {
        agentId: "agent-existing",
        jobId: "provision-agent-existing",
        status: "processing",
      },
    });
    getCloudCompatAgent.mockResolvedValue({
      success: true,
      data: makeAgent({ status: "running" }),
    });

    const result = await client.selectOrProvisionCloudAgent({
      ...BASE_OPTS,
      wakePollIntervalMs: 1,
      wakeTimeoutMs: 50,
    });

    expect(provisionCloudCompatAgent).toHaveBeenCalledOnce();
    expect(provisionCloudCompatAgent).toHaveBeenCalledWith("agent-existing");
    expect(getCloudCompatJobStatus).toHaveBeenCalledWith(
      "provision-agent-existing",
    );
    expect(resumeCloudCompatAgent).not.toHaveBeenCalled();
    expect(wakeCloudCompatAgent).not.toHaveBeenCalled();
    expect(createCloudCompatAgent).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      agentId: "agent-existing",
      created: false,
      jobId: "provision-agent-existing",
      source: "existing_provision",
    });
  });

  it.each([
    {
      status: "sleeping",
      expectedJobId: "wake-agent-existing",
      expectedSource: "existing_wake",
      expectedTrigger: "wake",
    },
    {
      status: "disconnected",
      expectedJobId: "provision-agent-existing",
      expectedSource: "existing_provision",
      expectedTrigger: "provision",
    },
  ] as const)(
    "routes an idempotent create response whose detail is $status through $expectedTrigger",
    async ({ status, expectedJobId, expectedSource, expectedTrigger }) => {
      const {
        client,
        createCloudCompatAgent,
        getCloudCompatAgent,
        getCloudCompatAgents,
        provisionCloudCompatAgent,
        resumeCloudCompatAgent,
        wakeCloudCompatAgent,
      } = fakeClient();
      getCloudCompatAgents.mockResolvedValue({ success: true, data: [] });
      createCloudCompatAgent.mockResolvedValue({
        success: true,
        created: false,
        data: {
          agentId: "agent-existing",
          agentName: "Eliza",
          jobId: "",
          status,
          nodeId: null,
          message: "Existing agent returned",
        },
      });
      getCloudCompatAgent
        .mockResolvedValueOnce({
          success: true,
          data: makeAgent({
            status,
            web_ui_url: "https://agent-existing.elizacloud.ai",
            webUiUrl: "https://agent-existing.elizacloud.ai",
          }),
        })
        .mockResolvedValueOnce({
          success: true,
          data: makeAgent({
            status: "running",
            web_ui_url: "https://agent-existing.elizacloud.ai",
            webUiUrl: "https://agent-existing.elizacloud.ai",
          }),
        });

      const result = await client.selectOrProvisionCloudAgent({
        ...BASE_OPTS,
        wakePollIntervalMs: 1,
        wakeTimeoutMs: 50,
      });

      expect(createCloudCompatAgent).toHaveBeenCalledTimes(1);
      expect(resumeCloudCompatAgent).not.toHaveBeenCalled();
      expect(wakeCloudCompatAgent).toHaveBeenCalledTimes(
        expectedTrigger === "wake" ? 1 : 0,
      );
      expect(provisionCloudCompatAgent).toHaveBeenCalledTimes(
        expectedTrigger === "provision" ? 1 : 0,
      );
      expect(result).toMatchObject({
        agentId: "agent-existing",
        created: false,
        jobId: expectedJobId,
        source: expectedSource,
      });
    },
  );

  it("reuses real dedicated Eliza Cloud agent subdomains without pairing", async () => {
    const { client, getCloudCompatAgents } = fakeClient();
    getCloudCompatAgents.mockResolvedValue({
      success: true,
      data: [
        makeAgent({
          agent_id: "agent-dedicated",
          web_ui_url: "https://agent-dedicated.elizacloud.ai",
          webUiUrl: "https://agent-dedicated.elizacloud.ai",
        }),
      ],
    });

    const result = await client.selectOrProvisionCloudAgent(BASE_OPTS);

    expect(result.apiBase).toBe("https://agent-dedicated.elizacloud.ai");
    expect(result.requiresAgentPairing).toBe(false);
  });

  it("does not force a reused dedicated agent through the shared adapter when Steward adapter is preferred", async () => {
    const { client, getCloudCompatAgents } = fakeClient();
    getCloudCompatAgents.mockResolvedValue({
      success: true,
      data: [
        makeAgent({
          agent_id: "agent-dedicated",
          web_ui_url: "https://agent-dedicated.elizacloud.ai",
          webUiUrl: "https://agent-dedicated.elizacloud.ai",
        }),
      ],
    });

    const result = await client.selectOrProvisionCloudAgent({
      ...BASE_OPTS,
      preferStewardAgentAdapter: true,
      preferSharedTier: true,
    });

    expect(result.created).toBe(false);
    expect(result.apiBase).toBe("https://agent-dedicated.elizacloud.ai");
    expect(result.apiBase).not.toContain("/api/v1/eliza/agents/");
    expect(result.requiresAgentPairing).toBe(false);
  });

  it("derives a dedicated subdomain for reused agents when shared tier is not requested", async () => {
    const { client, getCloudCompatAgents, createCloudCompatAgent } =
      fakeClient();
    getCloudCompatAgents.mockResolvedValue({
      success: true,
      data: [
        makeAgent({
          agent_id: "agent-no-urls",
          bridge_url: null,
          web_ui_url: null,
          webUiUrl: null,
          containerUrl: "",
        }),
      ],
    });

    const result = await client.selectOrProvisionCloudAgent(BASE_OPTS);

    expect(result.created).toBe(false);
    expect(result.agentId).toBe("agent-no-urls");
    expect(result.apiBase).toBe("https://agent-no-urls.elizacloud.ai");
    expect(result.apiBase).not.toContain("/api/v1/eliza/agents/");
    expect(createCloudCompatAgent).not.toHaveBeenCalled();
  });

  it("converts an adapter-shaped URL for a dedicated staging record to dedicated ingress", async () => {
    const { client, getCloudCompatAgents, createCloudCompatAgent } =
      fakeClient();
    getCloudCompatAgents.mockResolvedValue({
      success: true,
      data: [
        makeAgent({
          agent_id: "agent-staging",
          bridge_url: null,
          web_ui_url:
            "https://api-staging.elizacloud.ai/api/v1/eliza/agents/agent-staging",
          webUiUrl:
            "https://api-staging.elizacloud.ai/api/v1/eliza/agents/agent-staging",
        }),
      ],
    });

    const result = await client.selectOrProvisionCloudAgent({
      ...BASE_OPTS,
      cloudApiBase: "https://api-staging.elizacloud.ai/api/v1",
    });

    expect(result.created).toBe(false);
    expect(result.apiBase).toBe("https://agent-staging.staging.elizacloud.ai");
    expect(createCloudCompatAgent).not.toHaveBeenCalled();
  });

  it("keeps an explicit shared staging record on the shared adapter", async () => {
    const { client, getCloudCompatAgents, createCloudCompatAgent } =
      fakeClient();
    getCloudCompatAgents.mockResolvedValue({
      success: true,
      data: [
        makeAgent({
          agent_id: "agent-shared",
          bridge_url: null,
          web_ui_url: null,
          webUiUrl: null,
          containerUrl: "",
          execution_tier: "shared",
        }),
      ],
    });

    const result = await client.selectOrProvisionCloudAgent({
      ...BASE_OPTS,
      cloudApiBase: "https://api-staging.elizacloud.ai/api/v1",
      preferSharedTier: true,
    });

    expect(result.created).toBe(false);
    expect(result.executionTier).toBe("shared");
    expect(result.apiBase).toBe(
      "https://api-staging.elizacloud.ai/api/v1/eliza/agents/agent-shared",
    );
    expect(createCloudCompatAgent).not.toHaveBeenCalled();
  });

  it("force-creates a dedicated target instead of reusing an explicit shared bridge", async () => {
    const {
      client,
      getCloudCompatAgents,
      createCloudCompatAgent,
      getCloudCompatAgent,
    } = fakeClient();
    getCloudCompatAgents.mockResolvedValue({
      success: true,
      data: [
        makeAgent({
          agent_id: "shared-bridge",
          bridge_url: null,
          web_ui_url: null,
          webUiUrl: null,
          containerUrl: "",
          execution_tier: "shared",
        }),
      ],
    });
    createCloudCompatAgent.mockResolvedValue({
      success: true,
      created: true,
      data: {
        agentId: "dedicated-target",
        agentName: "Eliza",
        jobId: "",
        status: "running",
        nodeId: null,
        message: "",
      },
    });
    getCloudCompatAgent.mockResolvedValue({
      success: true,
      data: makeAgent({
        agent_id: "dedicated-target",
        status: "running",
        web_ui_url: "https://dedicated-target.elizacloud.ai",
        webUiUrl: "https://dedicated-target.elizacloud.ai",
      }),
    });

    const result = await client.selectOrProvisionCloudAgent(BASE_OPTS);

    expect(createCloudCompatAgent).toHaveBeenCalledWith(
      expect.objectContaining({ forceCreate: true }),
    );
    expect(result.agentId).toBe("dedicated-target");
    expect(result.apiBase).toBe("https://dedicated-target.elizacloud.ai");
    expect(result.executionTier).toBe("dedicated-always");
  });

  it("does NOT provision when the list fetch throws (transient/network error)", async () => {
    const { client, getCloudCompatAgents, createCloudCompatAgent } =
      fakeClient();
    getCloudCompatAgents.mockRejectedValue(new Error("network down"));

    await expect(client.selectOrProvisionCloudAgent(BASE_OPTS)).rejects.toThrow(
      /network down|find your agents/i,
    );
    expect(createCloudCompatAgent).not.toHaveBeenCalled();
  });

  it("keeps the structural agent-gone shape on the cause chain of a failed lookup", async () => {
    const { client, getCloudCompatAgents } = fakeClient();
    // What a stale binding produces: the deleted agent's origin answers the
    // compat agent list with the structured agent_not_found 404.
    getCloudCompatAgents.mockRejectedValue(
      Object.assign(new Error("agent not found or not running"), {
        kind: "http",
        status: 404,
        code: "agent_not_found",
        path: "/api/cloud/compat/agents",
      }),
    );

    const rejection = await client
      .selectOrProvisionCloudAgent(BASE_OPTS)
      .then(() => null)
      .catch((error: unknown) => error);

    expect(rejection).toBeInstanceOf(Error);
    // The join flow's stale-binding recovery classifies by status/code via
    // the cause chain — the flattened message alone cannot carry it.
    expect(isCloudAgentGoneError(rejection)).toBe(true);
    expect(isCloudAgentGoneError(new TypeError("Failed to fetch"))).toBe(false);
    expect(
      isCloudAgentGoneError(
        Object.assign(new Error("unauthorized"), { status: 401 }),
      ),
    ).toBe(false);
    // Pre-change router used this code-less body for both deleted and
    // stopped/cold rows — must not classify as gone (mixed-version safety).
    expect(
      isCloudAgentGoneError(
        Object.assign(new Error("agent not found or not running"), {
          kind: "http",
          status: 404,
          path: "/api/cloud/compat/agents",
        }),
      ),
    ).toBe(false);
  });

  it("does NOT provision when the list returns success:false (e.g. expired auth)", async () => {
    const { client, getCloudCompatAgents, createCloudCompatAgent } =
      fakeClient();
    getCloudCompatAgents.mockResolvedValue({
      success: false,
      data: [],
      error: "unauthorized",
    });

    await expect(client.selectOrProvisionCloudAgent(BASE_OPTS)).rejects.toThrow(
      /unauthorized|find your agents/i,
    );
    expect(createCloudCompatAgent).not.toHaveBeenCalled();
  });

  it("provisions exactly once for a confirmed-empty list (genuine first-time user)", async () => {
    const { client, getCloudCompatAgents, createCloudCompatAgent } =
      fakeClient();
    getCloudCompatAgents.mockResolvedValue({ success: true, data: [] });
    createCloudCompatAgent.mockResolvedValue({
      success: true,
      data: {
        agentId: "agent-new",
        agentName: "Eliza",
        jobId: "job-1",
        status: "provisioning",
        nodeId: null,
        message: "",
      },
    });
    (client.getCloudCompatAgent as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      data: makeAgent({
        agent_id: "agent-new",
        web_ui_url: "https://agent-new.example.test",
        webUiUrl: "https://agent-new.example.test",
      }),
    });

    const progress: CloudAgentJoinProgress[] = [];
    const result = await client.selectOrProvisionCloudAgent({
      ...BASE_OPTS,
      onProgress: (_status, _detail, receipt) => {
        if (receipt) progress.push(receipt);
      },
    });

    expect(result.created).toBe(true);
    expect(result.agentId).toBe("agent-new");
    expect(createCloudCompatAgent).toHaveBeenCalledTimes(1);
    expect(progress.find(({ status }) => status === "creating")).toMatchObject({
      phase: "provisioning",
      source: null,
      agentId: null,
      jobId: null,
    });
    expect(result.source).toBe("cold_provision");
  });

  it("does not reuse terminal-error agents; force-creates a replacement instead", async () => {
    const { client, getCloudCompatAgents, createCloudCompatAgent } =
      fakeClient();
    getCloudCompatAgents.mockResolvedValue({
      success: true,
      data: [
        makeAgent({
          agent_id: "agent-broken",
          status: "error",
          error_message:
            'State restore failed: HTTP 401 {"error":"Unauthorized"}',
          created_at: "2026-07-07T03:42:55.378Z",
        }),
      ],
    });
    createCloudCompatAgent.mockResolvedValue({
      success: true,
      created: true,
      data: {
        agentId: "agent-replacement",
        agentName: "Eliza",
        jobId: "job-1",
        status: "provisioning",
        nodeId: null,
        message: "",
      },
    });
    (client.getCloudCompatAgent as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      data: makeAgent({
        agent_id: "agent-replacement",
        status: "running",
        web_ui_url: "https://agent-replacement.example.test",
        webUiUrl: "https://agent-replacement.example.test",
      }),
    });

    const result = await client.selectOrProvisionCloudAgent(BASE_OPTS);

    expect(result.created).toBe(true);
    expect(result.agentId).toBe("agent-replacement");
    expect(createCloudCompatAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        agentName: "Eliza",
        forceCreate: true,
      }),
    );
  });

  it("does not send forceCreate for shared-tier replacements when terminal-error agents exist", async () => {
    const { client, getCloudCompatAgents, createCloudCompatAgent } =
      fakeClient();
    getCloudCompatAgents.mockResolvedValue({
      success: true,
      data: [
        makeAgent({
          agent_id: "agent-broken",
          status: "error",
          error_message:
            'State restore failed: HTTP 401 {"error":"Unauthorized"}',
          created_at: "2026-07-07T03:42:55.378Z",
        }),
      ],
    });
    createCloudCompatAgent.mockResolvedValue({
      success: true,
      created: true,
      source: "shared_runtime",
      data: {
        agentId: "agent-shared-replacement",
        agentName: "Eliza",
        jobId: "",
        status: "running",
        nodeId: null,
        message: "",
      },
    });
    (client.getCloudCompatAgent as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      data: makeAgent({
        agent_id: "agent-shared-replacement",
        status: "running",
        execution_tier: "shared",
        web_ui_url: null,
        webUiUrl: null,
      }),
    });

    const result = await client.selectOrProvisionCloudAgent({
      ...BASE_OPTS,
      preferSharedTier: true,
    });

    expect(result.created).toBe(true);
    expect(result.agentId).toBe("agent-shared-replacement");
    expect(createCloudCompatAgent).toHaveBeenCalledTimes(1);
    const createPayload = createCloudCompatAgent.mock.calls[0]?.[0];
    expect(createPayload).toEqual(
      expect.objectContaining({
        agentName: "Eliza",
        preferSharedTier: true,
      }),
    );
    expect(createPayload).not.toHaveProperty("forceCreate");
  });

  it("forwards forceCreate through the create branch so explicit new-agent requests cannot reuse an existing backend row", async () => {
    const { client, getCloudCompatAgents, createCloudCompatAgent } =
      fakeClient();
    createCloudCompatAgent.mockResolvedValue({
      success: true,
      created: true,
      data: {
        agentId: "agent-forced-new",
        agentName: "Demo Fresh",
        jobId: "job-1",
        status: "provisioning",
        nodeId: null,
        message: "",
      },
    });
    (client.getCloudCompatAgent as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      data: makeAgent({
        agent_id: "agent-forced-new",
        agent_name: "Demo Fresh",
        status: "running",
        web_ui_url: "https://agent-forced-new.example.test",
        webUiUrl: "https://agent-forced-new.example.test",
      }),
    });

    const result = await client.selectOrProvisionCloudAgent({
      ...BASE_OPTS,
      name: "Demo Fresh",
      forceCreate: true,
    });

    expect(getCloudCompatAgents).not.toHaveBeenCalled();
    expect(createCloudCompatAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        agentName: "Demo Fresh",
        forceCreate: true,
      }),
    );
    expect(result.created).toBe(true);
    expect(result.agentId).toBe("agent-forced-new");
  });

  it("rejects an existing-agent response to forceCreate without binding or inspecting that agent", async () => {
    const { client, createCloudCompatAgent, getCloudCompatAgent } =
      fakeClient();
    createCloudCompatAgent.mockResolvedValue({
      success: true,
      created: false,
      data: {
        agentId: "agent-existing",
        agentName: "Launch Verify Dedicated",
        jobId: "",
        status: "running",
        nodeId: null,
        message: "Agent created",
      },
    });

    await expect(
      client.selectOrProvisionCloudAgent({
        ...BASE_OPTS,
        name: "Demo Fresh",
        forceCreate: true,
      }),
    ).rejects.toThrow("did not confirm that a new agent was created");

    expect(getCloudCompatAgent).not.toHaveBeenCalled();
  });

  it("rejects an ambiguous force-create response that omits the freshness flag", async () => {
    const { client, createCloudCompatAgent, getCloudCompatAgent } =
      fakeClient();
    createCloudCompatAgent.mockResolvedValue({
      success: true,
      data: {
        agentId: "agent-legacy",
        agentName: "Eliza",
        jobId: "",
        status: "provisioning",
        nodeId: null,
        message: "",
      },
    });
    await expect(
      client.selectOrProvisionCloudAgent({
        ...BASE_OPTS,
        name: "Eliza",
        forceCreate: true,
      }),
    ).rejects.toThrow("did not confirm that a new agent was created");

    expect(getCloudCompatAgent).not.toHaveBeenCalled();
  });

  // Default first-run: a freshly-created dedicated agent whose container is
  // still provisioning waits for the dedicated runtime instead of binding chat
  // to the shared adapter, which returns "Not a shared-runtime agent" for
  // dedicated ids.
  it("waits for a still-provisioning new dedicated agent and returns its dedicated subdomain", async () => {
    const {
      client,
      getCloudCompatAgents,
      createCloudCompatAgent,
      getCloudCompatAgent,
      getCloudCompatJobStatus,
      resumeCloudCompatAgent,
    } = fakeClient();
    getCloudCompatAgents.mockResolvedValue({ success: true, data: [] });
    createCloudCompatAgent.mockResolvedValue({
      success: true,
      data: {
        agentId: "agent-new",
        agentName: "Eliza",
        jobId: "job-1",
        status: "provisioning",
        nodeId: null,
        message: "",
      },
    });
    getCloudCompatAgent
      .mockResolvedValueOnce({
        success: true,
        data: makeAgent({
          agent_id: "agent-new",
          status: "provisioning",
          bridge_url: null,
          web_ui_url: "https://agent-new.elizacloud.ai",
          webUiUrl: "https://agent-new.elizacloud.ai",
        }),
      })
      .mockResolvedValueOnce({
        success: true,
        data: makeAgent({
          agent_id: "agent-new",
          status: "running",
          bridge_url: null,
          web_ui_url: "https://agent-new.elizacloud.ai",
          webUiUrl: "https://agent-new.elizacloud.ai",
        }),
      });
    const result = await client.selectOrProvisionCloudAgent({
      ...BASE_OPTS,
      wakePollIntervalMs: 1,
      wakeTimeoutMs: 50,
    });

    expect(result.created).toBe(true);
    expect(result.agentId).toBe("agent-new");
    expect(result.apiBase).toBe("https://agent-new.elizacloud.ai");
    expect(result.requiresAgentPairing).toBe(false);
    expect(getCloudCompatJobStatus).toHaveBeenCalledWith("job-1");
    expect(resumeCloudCompatAgent).not.toHaveBeenCalled();
  });

  // The warm-pool path returns a brand-new agent already `running` with a
  // dedicated URL — no boot gap — so we use the subdomain immediately.
  it("uses the dedicated subdomain immediately when a new agent is already running", async () => {
    const { client, getCloudCompatAgents, createCloudCompatAgent } =
      fakeClient();
    getCloudCompatAgents.mockResolvedValue({ success: true, data: [] });
    createCloudCompatAgent.mockResolvedValue({
      success: true,
      data: {
        agentId: "agent-warm",
        agentName: "Eliza",
        jobId: "",
        status: "running",
        nodeId: null,
        message: "",
      },
    });
    (client.getCloudCompatAgent as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      data: makeAgent({
        agent_id: "agent-warm",
        status: "running",
        web_ui_url: "https://agent-warm.elizacloud.ai",
        webUiUrl: "https://agent-warm.elizacloud.ai",
      }),
    });

    const result = await client.selectOrProvisionCloudAgent(BASE_OPTS);

    expect(result.created).toBe(true);
    expect(result.apiBase).toContain("agent-warm.elizacloud.ai");
    expect(result.requiresAgentPairing).toBe(false);
  });

  it("keeps a warm newly-created dedicated agent on its dedicated subdomain even when Steward adapter is requested", async () => {
    const { client, getCloudCompatAgents, createCloudCompatAgent } =
      fakeClient();
    getCloudCompatAgents.mockResolvedValue({ success: true, data: [] });
    createCloudCompatAgent.mockResolvedValue({
      success: true,
      data: {
        agentId: "agent-warm",
        agentName: "Eliza",
        jobId: "",
        status: "running",
        nodeId: null,
        message: "",
      },
    });
    (client.getCloudCompatAgent as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      data: makeAgent({
        agent_id: "agent-warm",
        status: "running",
        web_ui_url: "https://agent-warm.elizacloud.ai",
        webUiUrl: "https://agent-warm.elizacloud.ai",
      }),
    });

    const result = await client.selectOrProvisionCloudAgent({
      ...BASE_OPTS,
      preferStewardAgentAdapter: true,
    });

    expect(result.created).toBe(true);
    expect(result.apiBase).toBe("https://agent-warm.elizacloud.ai");
    expect(result.apiBase).not.toContain("/api/v1/eliza/agents/");
    expect(result.requiresAgentPairing).toBe(false);
  });

  it("preserves a fresh cold-create job and polls it before accepting the running agent", async () => {
    const {
      client,
      createCloudCompatAgent,
      getCloudCompatAgent,
      getCloudCompatAgents,
      getCloudCompatJobStatus,
      provisionCloudCompatAgent,
      resumeCloudCompatAgent,
    } = fakeClient();
    getCloudCompatAgents.mockResolvedValue({ success: true, data: [] });
    createCloudCompatAgent.mockResolvedValue({
      success: true,
      created: true,
      data: {
        agentId: "agent-cold",
        agentName: "Eliza",
        jobId: "job-cold",
        status: "queued",
        nodeId: null,
        message: "",
      },
    });
    getCloudCompatJobStatus
      .mockResolvedValueOnce({
        success: true,
        data: makeJob("job-cold", {
          status: "processing",
          state: "in_progress",
          completedAt: null,
          completed_on: null,
        }),
      })
      .mockResolvedValueOnce({
        success: true,
        data: makeJob("job-cold"),
      });
    getCloudCompatAgent
      .mockResolvedValueOnce({
        success: true,
        data: makeAgent({
          agent_id: "agent-cold",
          status: "provisioning",
          web_ui_url: "https://agent-cold.elizacloud.ai",
          webUiUrl: "https://agent-cold.elizacloud.ai",
        }),
      })
      .mockResolvedValueOnce({
        success: true,
        data: makeAgent({
          agent_id: "agent-cold",
          status: "running",
          web_ui_url: "https://agent-cold.elizacloud.ai",
          webUiUrl: "https://agent-cold.elizacloud.ai",
        }),
      });

    const result = await client.selectOrProvisionCloudAgent({
      ...BASE_OPTS,
      wakePollIntervalMs: 1,
      wakeTimeoutMs: 100,
    });

    expect(getCloudCompatJobStatus).toHaveBeenCalledTimes(2);
    expect(getCloudCompatJobStatus).toHaveBeenNthCalledWith(1, "job-cold");
    expect(
      getCloudCompatJobStatus.mock.invocationCallOrder.at(-1),
    ).toBeLessThan(getCloudCompatAgent.mock.invocationCallOrder[0] ?? 0);
    expect(provisionCloudCompatAgent).not.toHaveBeenCalled();
    expect(resumeCloudCompatAgent).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      agentId: "agent-cold",
      jobId: "job-cold",
      source: "cold_provision",
      progress: {
        phase: "running",
        source: "cold_provision",
        agentId: "agent-cold",
        jobId: "job-cold",
        status: "running",
        correlationId: "job-cold",
      },
    });
  });

  it("accepts a warm-pool create without inventing or polling a lifecycle job", async () => {
    const {
      client,
      createCloudCompatAgent,
      getCloudCompatAgent,
      getCloudCompatAgents,
      getCloudCompatJobStatus,
      provisionCloudCompatAgent,
      resumeCloudCompatAgent,
    } = fakeClient();
    getCloudCompatAgents.mockResolvedValue({ success: true, data: [] });
    createCloudCompatAgent.mockResolvedValue({
      success: true,
      created: true,
      source: "warm_pool",
      data: {
        agentId: "agent-warm-source",
        agentName: "Eliza",
        jobId: "",
        status: "running",
        nodeId: null,
        message: "",
      },
    });
    getCloudCompatAgent.mockResolvedValue({
      success: true,
      data: makeAgent({
        agent_id: "agent-warm-source",
        status: "running",
        web_ui_url: "https://agent-warm-source.elizacloud.ai",
        webUiUrl: "https://agent-warm-source.elizacloud.ai",
      }),
    });

    const result = await client.selectOrProvisionCloudAgent(BASE_OPTS);

    expect(result.source).toBe("warm_pool");
    expect(result.jobId).toBeNull();
    expect(getCloudCompatJobStatus).not.toHaveBeenCalled();
    expect(provisionCloudCompatAgent).not.toHaveBeenCalled();
    expect(resumeCloudCompatAgent).not.toHaveBeenCalled();
  });

  it("recovers the same provisioning job across reload attempts without duplicate create", async () => {
    const {
      client,
      createCloudCompatAgent,
      getCloudCompatAgent,
      getCloudCompatAgents,
      provisionCloudCompatAgent,
      resumeCloudCompatAgent,
    } = fakeClient();
    getCloudCompatAgents.mockResolvedValue({
      success: true,
      data: [makeAgent({ status: "provisioning" })],
    });
    provisionCloudCompatAgent.mockResolvedValue({
      success: true,
      alreadyInProgress: true,
      data: {
        agentId: "agent-existing",
        jobId: "job-existing",
        status: "processing",
      },
    });
    getCloudCompatAgent.mockResolvedValue({
      success: true,
      data: makeAgent({ status: "running" }),
    });

    const first = await client.selectOrProvisionCloudAgent(BASE_OPTS);
    const afterReload = await client.selectOrProvisionCloudAgent(BASE_OPTS);

    expect(createCloudCompatAgent).not.toHaveBeenCalled();
    expect(resumeCloudCompatAgent).not.toHaveBeenCalled();
    expect(provisionCloudCompatAgent).toHaveBeenCalledTimes(2);
    expect(provisionCloudCompatAgent).toHaveBeenNthCalledWith(
      1,
      "agent-existing",
    );
    expect(provisionCloudCompatAgent).toHaveBeenNthCalledWith(
      2,
      "agent-existing",
    );
    expect(first.jobId).toBe("job-existing");
    expect(afterReload.jobId).toBe("job-existing");
    expect(first.source).toBe("existing_provision");
  });

  for (const status of [401, 402, 403, 404, 409, 503]) {
    it(`fails a stopped-agent resume immediately on HTTP ${status}`, async () => {
      const {
        client,
        createCloudCompatAgent,
        getCloudCompatAgent,
        getCloudCompatAgents,
        getCloudCompatJobStatus,
        resumeCloudCompatAgent,
      } = fakeClient();
      getCloudCompatAgents.mockResolvedValue({
        success: true,
        data: [makeAgent({ status: "stopped" })],
      });
      resumeCloudCompatAgent.mockRejectedValueOnce(
        Object.assign(new Error(`HTTP ${status}`), { status }),
      );

      const rejection = await client
        .selectOrProvisionCloudAgent({
          ...BASE_OPTS,
          wakePollIntervalMs: 1,
          wakeTimeoutMs: 50,
        })
        .then(() => null)
        .catch((error: unknown) => error);

      expect(rejection).toBeInstanceOf(Error);
      expect(rejection).toBeInstanceOf(ElizaError);
      expect(rejection).toMatchObject({ code: "CLOUD_AGENT_JOIN_FAILED" });
      expect(resumeCloudCompatAgent).toHaveBeenCalledTimes(1);
      expect(getCloudCompatJobStatus).not.toHaveBeenCalled();
      expect(getCloudCompatAgent).not.toHaveBeenCalled();
      expect(createCloudCompatAgent).not.toHaveBeenCalled();
      expect(cloudAgentJoinProgressFromError(rejection)).toMatchObject({
        phase: "resuming",
        source: "existing_resume",
        agentId: "agent-existing",
        jobId: null,
        status: "stopped",
        correlationId: "agent-existing",
      });
    });
  }

  for (const status of [401, 402, 403, 404, 409, 503]) {
    it(`fails a post-job agent-detail read immediately on HTTP ${status}`, async () => {
      const {
        client,
        createCloudCompatAgent,
        getCloudCompatAgent,
        getCloudCompatAgents,
        getCloudCompatJobStatus,
        resumeCloudCompatAgent,
      } = fakeClient();
      getCloudCompatAgents.mockResolvedValue({
        success: true,
        data: [makeAgent({ status: "stopped" })],
      });
      getCloudCompatAgent.mockRejectedValueOnce(
        Object.assign(new Error(`detail HTTP ${status}`), { status }),
      );

      const rejection = await client
        .selectOrProvisionCloudAgent({
          ...BASE_OPTS,
          wakePollIntervalMs: 1,
          wakeTimeoutMs: 50,
        })
        .then(() => null)
        .catch((error: unknown) => error);

      expect(rejection).toBeInstanceOf(Error);
      expect(getCloudCompatJobStatus).toHaveBeenCalledTimes(1);
      expect(getCloudCompatAgent).toHaveBeenCalledTimes(1);
      expect(resumeCloudCompatAgent).toHaveBeenCalledTimes(1);
      expect(createCloudCompatAgent).not.toHaveBeenCalled();
      expect(cloudAgentJoinProgressFromError(rejection)).toMatchObject({
        phase: "resuming",
        source: "existing_resume",
        agentId: "agent-existing",
        jobId: "resume-agent-existing",
        status: "completed",
        correlationId: "resume-agent-existing",
      });
    });
  }

  it("retries a declared transient resume failure and retains the canonical resume job", async () => {
    const {
      client,
      getCloudCompatAgent,
      getCloudCompatAgents,
      resumeCloudCompatAgent,
    } = fakeClient();
    getCloudCompatAgents.mockResolvedValue({
      success: true,
      data: [makeAgent({ status: "stopped" })],
    });
    resumeCloudCompatAgent.mockRejectedValueOnce(
      Object.assign(new Error("temporary gateway"), { status: 502 }),
    );
    getCloudCompatAgent.mockResolvedValue({
      success: true,
      data: makeAgent({ status: "running" }),
    });

    const result = await client.selectOrProvisionCloudAgent({
      ...BASE_OPTS,
      wakePollIntervalMs: 1,
      wakeTimeoutMs: 100,
    });

    expect(resumeCloudCompatAgent).toHaveBeenCalledTimes(2);
    expect(result.jobId).toBe("resume-agent-existing");
    expect(result.source).toBe("existing_resume");
  });

  for (const testCase of [
    {
      action: "wake",
      expectedJobId: "wake-agent-existing",
      status: "sleeping",
    },
    {
      action: "resume",
      expectedJobId: "resume-agent-existing",
      status: "stopped",
    },
    {
      action: "provision",
      expectedJobId: "provision-agent-existing",
      status: "disconnected",
    },
  ] as const) {
    it(`never replays ${testCase.action} when a progress consumer throws TypeError`, async () => {
      const {
        client,
        createCloudCompatAgent,
        getCloudCompatAgents,
        getCloudCompatJobStatus,
        provisionCloudCompatAgent,
        resumeCloudCompatAgent,
        wakeCloudCompatAgent,
      } = fakeClient();
      getCloudCompatAgents.mockResolvedValue({
        success: true,
        data: [makeAgent({ status: testCase.status })],
      });

      const result = client.selectOrProvisionCloudAgent({
        ...BASE_OPTS,
        onProgress: (_status, _detail, progress) => {
          if (progress?.jobId === testCase.expectedJobId) {
            throw new TypeError("progress renderer exploded");
          }
        },
        wakePollIntervalMs: 1,
        wakeTimeoutMs: 50,
      });

      await expect(result).rejects.toThrow("progress renderer exploded");
      expect(wakeCloudCompatAgent).toHaveBeenCalledTimes(
        testCase.action === "wake" ? 1 : 0,
      );
      expect(resumeCloudCompatAgent).toHaveBeenCalledTimes(
        testCase.action === "resume" ? 1 : 0,
      );
      expect(provisionCloudCompatAgent).toHaveBeenCalledTimes(
        testCase.action === "provision" ? 1 : 0,
      );
      expect(getCloudCompatJobStatus).not.toHaveBeenCalled();
      expect(createCloudCompatAgent).not.toHaveBeenCalled();
    });
  }

  it("times out with the last phase and canonical correlation instead of spinning forever", async () => {
    const {
      client,
      createCloudCompatAgent,
      getCloudCompatAgent,
      getCloudCompatAgents,
      getCloudCompatJobStatus,
    } = fakeClient();
    getCloudCompatAgents.mockResolvedValue({ success: true, data: [] });
    createCloudCompatAgent.mockResolvedValue({
      success: true,
      created: true,
      data: {
        agentId: "agent-timeout",
        agentName: "Eliza",
        jobId: "job-timeout",
        status: "queued",
        nodeId: null,
        message: "",
      },
    });
    getCloudCompatJobStatus.mockResolvedValue({
      success: true,
      data: makeJob("job-timeout", {
        status: "processing",
        state: "in_progress",
        completedAt: null,
        completed_on: null,
      }),
    });
    getCloudCompatAgent.mockResolvedValue({
      success: true,
      data: makeAgent({
        agent_id: "agent-timeout",
        status: "provisioning",
        web_ui_url: "https://agent-timeout.elizacloud.ai",
        webUiUrl: "https://agent-timeout.elizacloud.ai",
      }),
    });

    const rejection = await client
      .selectOrProvisionCloudAgent({
        ...BASE_OPTS,
        wakePollIntervalMs: 1,
        wakeTimeoutMs: 5,
      })
      .then(() => null)
      .catch((error: unknown) => error);

    expect(rejection).toBeInstanceOf(Error);
    expect((rejection as Error).message).toMatch(/still .* after|booting/i);
    expect(cloudAgentJoinProgressFromError(rejection)).toMatchObject({
      phase: "provisioning",
      source: "cold_provision",
      agentId: "agent-timeout",
      jobId: "job-timeout",
      correlationId: "job-timeout",
    });
  });

  it("surfaces a failed canonical job and never treats agent detail as success", async () => {
    const {
      client,
      createCloudCompatAgent,
      getCloudCompatAgent,
      getCloudCompatAgents,
      getCloudCompatJobStatus,
    } = fakeClient();
    getCloudCompatAgents.mockResolvedValue({ success: true, data: [] });
    createCloudCompatAgent.mockResolvedValue({
      success: true,
      created: true,
      data: {
        agentId: "agent-failed-job",
        agentName: "Eliza",
        jobId: "job-failed",
        status: "queued",
        nodeId: null,
        message: "",
      },
    });
    getCloudCompatAgent.mockResolvedValueOnce({
      success: true,
      data: makeAgent({
        agent_id: "agent-failed-job",
        status: "provisioning",
        web_ui_url: "https://agent-failed-job.elizacloud.ai",
        webUiUrl: "https://agent-failed-job.elizacloud.ai",
      }),
    });
    getCloudCompatJobStatus.mockResolvedValue({
      success: true,
      data: makeJob("job-failed", {
        status: "failed",
        state: "failed",
        error: "worker rejected image",
      }),
    });

    const rejection = await client
      .selectOrProvisionCloudAgent(BASE_OPTS)
      .then(() => null)
      .catch((error: unknown) => error);

    expect((rejection as Error).message).toContain("worker rejected image");
    expect(getCloudCompatAgent).not.toHaveBeenCalled();
    expect(cloudAgentJoinProgressFromError(rejection)).toMatchObject({
      phase: "provisioning",
      jobId: "job-failed",
      status: "failed",
    });
  });
});
