/**
 * Unit coverage for the cloud select-or-provision-agent flow. Capacitor mocked,
 * no live cloud.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => false },
  CapacitorHttp: { get: vi.fn(), post: vi.fn(), request: vi.fn() },
}));

import { ElizaClient } from "./client-base";
// Side-effect import: patches selectOrProvisionCloudAgent onto the prototype.
import "./client-cloud";
import type { CloudCompatAgent } from "./client-types-cloud";

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
    ...overrides,
  };
}

function fakeClient() {
  const getCloudCompatAgents = vi.fn();
  const createCloudCompatAgent = vi.fn();
  const getCloudCompatAgent = vi.fn();
  const resumeCloudCompatAgent = vi.fn(async () => ({ success: true }));
  const client = Object.create(ElizaClient.prototype) as ElizaClient;
  Object.assign(client, {
    getCloudCompatAgents,
    createCloudCompatAgent,
    getCloudCompatAgent,
    resumeCloudCompatAgent,
  });
  return {
    client,
    getCloudCompatAgents,
    createCloudCompatAgent,
    getCloudCompatAgent,
    resumeCloudCompatAgent,
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

  it("does NOT provision when the list fetch throws (transient/network error)", async () => {
    const { client, getCloudCompatAgents, createCloudCompatAgent } =
      fakeClient();
    getCloudCompatAgents.mockRejectedValue(new Error("network down"));

    await expect(client.selectOrProvisionCloudAgent(BASE_OPTS)).rejects.toThrow(
      /network down|find your agents/i,
    );
    expect(createCloudCompatAgent).not.toHaveBeenCalled();
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

    const result = await client.selectOrProvisionCloudAgent(BASE_OPTS);

    expect(result.created).toBe(true);
    expect(result.agentId).toBe("agent-new");
    expect(createCloudCompatAgent).toHaveBeenCalledTimes(1);
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
        status: "provisioning",
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
      data: {
        agentId: "agent-shared-replacement",
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
        agent_id: "agent-shared-replacement",
        status: "provisioning",
        web_ui_url: "https://agent-shared-replacement.example.test",
        webUiUrl: "https://agent-shared-replacement.example.test",
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
        status: "provisioning",
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

  it("reports created:false when the backend reused an existing agent despite forceCreate (org at per-org cap #11023) so the UI cannot claim a fresh agent (#14487)", async () => {
    const { client, createCloudCompatAgent } = fakeClient();
    // Backend hit the per-org cap: the reuse guard handed back the existing
    // agent and the create route returned 200 `created: false`. The client
    // must propagate that, not hardcode `created: true`.
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
    (client.getCloudCompatAgent as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      data: makeAgent({
        agent_id: "agent-existing",
        agent_name: "Launch Verify Dedicated",
        status: "running",
        web_ui_url: "https://agent-existing.example.test",
        webUiUrl: "https://agent-existing.example.test",
      }),
    });

    const result = await client.selectOrProvisionCloudAgent({
      ...BASE_OPTS,
      name: "Demo Fresh",
      forceCreate: true,
    });

    expect(result.created).toBe(false);
    expect(result.agentId).toBe("agent-existing");
  });

  it("keeps created:true when the create response omits the flag (older worker / non-direct path) so the pre-existing UX is unchanged", async () => {
    const { client, createCloudCompatAgent } = fakeClient();
    // No `created` field at all — the client must not demote a normal create.
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
    (client.getCloudCompatAgent as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      data: makeAgent({
        agent_id: "agent-legacy",
        status: "provisioning",
        web_ui_url: "https://agent-legacy.example.test",
        webUiUrl: "https://agent-legacy.example.test",
      }),
    });

    const result = await client.selectOrProvisionCloudAgent({
      ...BASE_OPTS,
      name: "Eliza",
      forceCreate: true,
    });

    expect(result.created).toBe(true);
    expect(result.agentId).toBe("agent-legacy");
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
    resumeCloudCompatAgent.mockResolvedValue({ success: true });

    const result = await client.selectOrProvisionCloudAgent({
      ...BASE_OPTS,
      wakePollIntervalMs: 1,
      wakeTimeoutMs: 50,
    });

    expect(result.created).toBe(true);
    expect(result.agentId).toBe("agent-new");
    expect(result.apiBase).toBe("https://agent-new.elizacloud.ai");
    expect(result.requiresAgentPairing).toBe(false);
    expect(resumeCloudCompatAgent).toHaveBeenCalledWith("agent-new");
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
});
