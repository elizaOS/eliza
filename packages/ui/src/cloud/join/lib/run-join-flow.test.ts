import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  dedicatedSubdomainBase,
  type JoinFlowClient,
  type JoinFlowEffects,
  runJoinFlow,
} from "./run-join-flow";

const CLOUD_API_BASE = "https://www.elizacloud.ai";
const SHARED_BASE = "https://api.elizacloud.ai/api/v1/eliza/agents/agent-123";

function makeClient(
  selectResult: Awaited<
    ReturnType<JoinFlowClient["selectOrProvisionCloudAgent"]>
  >,
): {
  client: JoinFlowClient;
  setBaseUrl: ReturnType<typeof vi.fn>;
  setToken: ReturnType<typeof vi.fn>;
  select: ReturnType<typeof vi.fn>;
} {
  const setBaseUrl = vi.fn();
  const setToken = vi.fn();
  const select = vi.fn().mockResolvedValue(selectResult);
  return {
    client: {
      selectOrProvisionCloudAgent: select,
      setBaseUrl,
      setToken,
    },
    setBaseUrl,
    setToken,
    select,
  };
}

function makeEffects(): {
  effects: JoinFlowEffects;
  saveServer: ReturnType<typeof vi.fn>;
  saveFirstRun: ReturnType<typeof vi.fn>;
} {
  const saveServer = vi.fn();
  const saveFirstRun = vi.fn();
  return {
    effects: {
      savePersistedActiveServer: saveServer,
      savePersistedFirstRunComplete: saveFirstRun,
    },
    saveServer,
    saveFirstRun,
  };
}

describe("dedicatedSubdomainBase", () => {
  test("returns the dedicated container apex for an agent subdomain", () => {
    expect(
      dedicatedSubdomainBase(
        "https://agent-123.elizacloud.ai/api/conversations",
      ),
    ).toBe("https://agent-123.elizacloud.ai");
  });

  test("returns null for the shared-tier control-plane REST base", () => {
    expect(dedicatedSubdomainBase(SHARED_BASE)).toBeNull();
  });

  test("returns null for the bare control-plane host", () => {
    expect(dedicatedSubdomainBase("https://api.elizacloud.ai")).toBeNull();
    expect(dedicatedSubdomainBase("https://www.elizacloud.ai")).toBeNull();
  });

  test("returns null for non-https or non-cloud hosts", () => {
    expect(dedicatedSubdomainBase("http://agent-123.elizacloud.ai")).toBeNull();
    expect(dedicatedSubdomainBase("https://example.com")).toBeNull();
    expect(dedicatedSubdomainBase("not a url")).toBeNull();
  });
});

describe("runJoinFlow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("connects to a reused shared-tier agent and lands first-run complete", async () => {
    const { client, setBaseUrl, setToken, select } = makeClient({
      agentId: "agent-123",
      agentName: "Eliza",
      apiBase: SHARED_BASE,
      bridgeUrl: null,
      created: false,
    });
    const { effects, saveServer, saveFirstRun } = makeEffects();

    const result = await runJoinFlow({
      client,
      effects,
      cloudApiBase: CLOUD_API_BASE,
      authToken: "tok-abc",
      agentName: "Eliza",
      preferAgentId: "agent-123",
    });

    expect(select).toHaveBeenCalledWith(
      expect.objectContaining({
        cloudApiBase: CLOUD_API_BASE,
        authToken: "tok-abc",
        preferAgentId: "agent-123",
      }),
    );
    expect(setBaseUrl).toHaveBeenCalledWith(SHARED_BASE);
    expect(setToken).toHaveBeenCalledWith("tok-abc");
    expect(saveServer).toHaveBeenCalledWith({
      id: "cloud:agent-123",
      kind: "cloud",
      label: "Eliza",
      apiBase: SHARED_BASE,
      accessToken: "tok-abc",
    });
    expect(saveFirstRun).toHaveBeenCalledWith(true);
    expect(result).toEqual({
      agentId: "agent-123",
      agentName: "Eliza",
      apiBase: SHARED_BASE,
      created: false,
      dedicated: false,
    });
  });

  test("prefers the dedicated container subdomain when reported", async () => {
    const { client, setBaseUrl } = makeClient({
      agentId: "agent-xyz",
      agentName: "Dedicated",
      apiBase: "https://agent-xyz.elizacloud.ai/api/conversations",
      bridgeUrl: null,
      created: true,
    });
    const { effects, saveServer } = makeEffects();

    const result = await runJoinFlow({
      client,
      effects,
      cloudApiBase: CLOUD_API_BASE,
      authToken: "tok",
      agentName: "Dedicated",
    });

    expect(setBaseUrl).toHaveBeenCalledWith("https://agent-xyz.elizacloud.ai");
    expect(saveServer).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "cloud:agent-xyz",
        apiBase: "https://agent-xyz.elizacloud.ai",
      }),
    );
    expect(result.dedicated).toBe(true);
    expect(result.created).toBe(true);
  });

  test("derives a per-agent REST base when the agent reports a blank apiBase", async () => {
    const { client, setBaseUrl } = makeClient({
      agentId: "agent-new",
      agentName: "Fresh",
      apiBase: "",
      bridgeUrl: null,
      created: true,
    });
    const { effects } = makeEffects();

    const result = await runJoinFlow({
      client,
      effects,
      cloudApiBase: CLOUD_API_BASE,
      authToken: "tok",
      agentName: "Fresh",
    });

    expect(setBaseUrl).toHaveBeenCalledWith(
      "https://www.elizacloud.ai/api/v1/eliza/agents/agent-new",
    );
    expect(result.apiBase).toBe(
      "https://www.elizacloud.ai/api/v1/eliza/agents/agent-new",
    );
    expect(result.dedicated).toBe(false);
  });

  test("throws when no agent id is returned", async () => {
    const { client } = makeClient({
      agentId: "",
      agentName: "",
      apiBase: "",
      bridgeUrl: null,
      created: false,
    });
    const { effects, saveFirstRun } = makeEffects();

    await expect(
      runJoinFlow({
        client,
        effects,
        cloudApiBase: CLOUD_API_BASE,
        authToken: "tok",
        agentName: "Eliza",
      }),
    ).rejects.toThrow(/did not return an agent/i);
    expect(saveFirstRun).not.toHaveBeenCalled();
  });
});
