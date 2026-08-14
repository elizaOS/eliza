/**
 * Unit coverage for the org/agent join flow (dedicated subdomain resolution,
 * effects). Client + effects injected, no network.
 */
import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  dedicatedSubdomainBase,
  type JoinFlowClient,
  type JoinFlowEffects,
  runJoinFlow,
} from "./run-join-flow";

const CLOUD_API_BASE = "https://api.eliza.app";
const SHARED_BASE = "https://api.eliza.app/api/v1/eliza/agents/agent-123";

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
  clearServer: ReturnType<typeof vi.fn>;
  saveFirstRun: ReturnType<typeof vi.fn>;
} {
  const saveServer = vi.fn();
  const clearServer = vi.fn();
  const saveFirstRun = vi.fn();
  return {
    effects: {
      savePersistedActiveServer: saveServer,
      clearPersistedActiveServer: clearServer,
      savePersistedFirstRunComplete: saveFirstRun,
    },
    saveServer,
    clearServer,
    saveFirstRun,
  };
}

/** The wrapped list-lookup failure `selectOrProvisionCloudAgent` throws when
 * the bound (deleted) agent's origin answers the agent list with the cloud
 * router's structural agent-gone shape (`agent_not_found` code). */
function agentGoneError(): Error {
  return new Error("agent not found or not running", {
    cause: Object.assign(new Error("agent not found or not running"), {
      kind: "http",
      status: 404,
      code: "agent_not_found",
      path: "/api/cloud/compat/agents",
    }),
  });
}

describe("dedicatedSubdomainBase", () => {
  test("returns the dedicated container apex for an agent subdomain", () => {
    expect(
      dedicatedSubdomainBase(
        "https://agent-123.cloud.eliza.app/api/conversations",
      ),
    ).toBe("https://agent-123.cloud.eliza.app");
  });

  test("returns null for the shared-tier control-plane REST base", () => {
    expect(dedicatedSubdomainBase(SHARED_BASE)).toBeNull();
  });

  test("returns null for the bare control-plane host", () => {
    expect(dedicatedSubdomainBase("https://api.eliza.app")).toBeNull();
    expect(dedicatedSubdomainBase("https://eliza.app")).toBeNull();
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
      apiBase: "https://agent-xyz.cloud.eliza.app/api/conversations",
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

    expect(setBaseUrl).toHaveBeenCalledWith(
      "https://agent-xyz.cloud.eliza.app",
    );
    expect(saveServer).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "cloud:agent-xyz",
        apiBase: "https://agent-xyz.cloud.eliza.app",
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
      "https://api.eliza.app/api/v1/eliza/agents/agent-new",
    );
    expect(result.apiBase).toBe(
      "https://api.eliza.app/api/v1/eliza/agents/agent-new",
    );
    expect(result.dedicated).toBe(false);
  });

  test("clears a stale binding and reselects fresh when the bound agent is gone (404)", async () => {
    const setBaseUrl = vi.fn();
    const setToken = vi.fn();
    const select = vi
      .fn()
      .mockRejectedValueOnce(agentGoneError())
      .mockResolvedValueOnce({
        agentId: "agent-alive",
        agentName: "Eliza",
        apiBase: "https://api.eliza.app/api/v1/eliza/agents/agent-alive",
        bridgeUrl: null,
        created: false,
      });
    const client: JoinFlowClient = {
      selectOrProvisionCloudAgent: select,
      setBaseUrl,
      setToken,
    };
    const { effects, saveServer, clearServer, saveFirstRun } = makeEffects();

    const result = await runJoinFlow({
      client,
      effects,
      cloudApiBase: CLOUD_API_BASE,
      authToken: "tok",
      agentName: "Eliza",
      preferAgentId: "agent-deleted",
    });

    // The stale binding is dropped and the client reset to the fresh-visit
    // state BEFORE the fallback selection, so the retry resolves the control
    // plane instead of misrouting through the dead agent origin again.
    expect(clearServer).toHaveBeenCalledTimes(1);
    expect(setBaseUrl.mock.calls[0]).toEqual([null]);
    expect(select).toHaveBeenCalledTimes(2);
    expect(select.mock.calls[1][0]).not.toHaveProperty("preferAgentId");
    // The fallback selection binds normally — no terminal error state.
    expect(result.agentId).toBe("agent-alive");
    expect(saveServer).toHaveBeenCalledWith(
      expect.objectContaining({ id: "cloud:agent-alive" }),
    );
    expect(saveFirstRun).toHaveBeenCalledWith(true);
  });

  test("reaches the provisioning path when the org has zero agents after dropping the stale binding", async () => {
    const select = vi
      .fn()
      .mockRejectedValueOnce(agentGoneError())
      .mockResolvedValueOnce({
        agentId: "agent-created",
        agentName: "Eliza",
        apiBase: "https://agent-created.cloud.eliza.app",
        bridgeUrl: null,
        created: true,
      });
    const client: JoinFlowClient = {
      selectOrProvisionCloudAgent: select,
      setBaseUrl: vi.fn(),
      setToken: vi.fn(),
    };
    const { effects, clearServer } = makeEffects();

    const result = await runJoinFlow({
      client,
      effects,
      cloudApiBase: CLOUD_API_BASE,
      authToken: "tok",
      agentName: "Eliza",
      preferAgentId: "agent-deleted",
    });

    expect(clearServer).toHaveBeenCalledTimes(1);
    expect(result.created).toBe(true);
    expect(result.agentId).toBe("agent-created");
  });

  test("keeps the terminal error for a transport-level failure of a valid binding", async () => {
    const select = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    const client: JoinFlowClient = {
      selectOrProvisionCloudAgent: select,
      setBaseUrl: vi.fn(),
      setToken: vi.fn(),
    };
    const { effects, clearServer, saveFirstRun } = makeEffects();

    await expect(
      runJoinFlow({
        client,
        effects,
        cloudApiBase: CLOUD_API_BASE,
        authToken: "tok",
        agentName: "Eliza",
        preferAgentId: "agent-bound",
      }),
    ).rejects.toThrow(/failed to fetch/i);
    // Network-down is not agent-gone: the binding survives, no blind retry.
    expect(clearServer).not.toHaveBeenCalled();
    expect(select).toHaveBeenCalledTimes(1);
    expect(saveFirstRun).not.toHaveBeenCalled();
  });

  test("rethrows an agent-gone failure when no binding was remembered", async () => {
    const select = vi.fn().mockRejectedValue(agentGoneError());
    const client: JoinFlowClient = {
      selectOrProvisionCloudAgent: select,
      setBaseUrl: vi.fn(),
      setToken: vi.fn(),
    };
    const { effects, clearServer } = makeEffects();

    await expect(
      runJoinFlow({
        client,
        effects,
        cloudApiBase: CLOUD_API_BASE,
        authToken: "tok",
        agentName: "Eliza",
      }),
    ).rejects.toThrow(/agent not found/i);
    expect(clearServer).not.toHaveBeenCalled();
    expect(select).toHaveBeenCalledTimes(1);
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

  test("does not start selection when already cancelled", async () => {
    const controller = new AbortController();
    controller.abort(new DOMException("cancelled", "AbortError"));
    const { client, select } = makeClient({
      agentId: "agent-123",
      agentName: "Eliza",
      apiBase: SHARED_BASE,
      bridgeUrl: null,
      created: false,
    });
    const { effects } = makeEffects();

    await expect(
      runJoinFlow({
        client,
        effects,
        cloudApiBase: CLOUD_API_BASE,
        authToken: "tok",
        agentName: "Eliza",
        signal: controller.signal,
      }),
    ).rejects.toThrow(/cancelled/i);
    expect(select).not.toHaveBeenCalled();
  });

  test("deletes a newly created agent when cancellation arrives after selection", async () => {
    const controller = new AbortController();
    const deleteAgent = vi.fn().mockResolvedValue(undefined);
    const { client } = makeClient({
      agentId: "agent-created",
      agentName: "Eliza",
      apiBase: SHARED_BASE,
      bridgeUrl: null,
      created: true,
    });
    client.deleteCloudCompatAgent = deleteAgent;
    const select = client.selectOrProvisionCloudAgent;
    client.selectOrProvisionCloudAgent = vi.fn(async (options) => {
      const result = await select(options);
      controller.abort(new DOMException("signed out", "AbortError"));
      return result;
    });
    const { effects, saveServer } = makeEffects();

    await expect(
      runJoinFlow({
        client,
        effects,
        cloudApiBase: CLOUD_API_BASE,
        authToken: "tok",
        agentName: "Eliza",
        signal: controller.signal,
      }),
    ).rejects.toThrow(/signed out/i);
    expect(deleteAgent).toHaveBeenCalledWith("agent-created");
    expect(saveServer).not.toHaveBeenCalled();
  });

  test("does not delete a reused agent when cancellation arrives after selection", async () => {
    const controller = new AbortController();
    const deleteAgent = vi.fn().mockResolvedValue(undefined);
    const { client } = makeClient({
      agentId: "agent-reused",
      agentName: "Eliza",
      apiBase: SHARED_BASE,
      bridgeUrl: null,
      created: false,
    });
    client.deleteCloudCompatAgent = deleteAgent;
    const select = client.selectOrProvisionCloudAgent;
    client.selectOrProvisionCloudAgent = vi.fn(async (options) => {
      const result = await select(options);
      controller.abort(new DOMException("signed out", "AbortError"));
      return result;
    });
    const { effects } = makeEffects();

    await expect(
      runJoinFlow({
        client,
        effects,
        cloudApiBase: CLOUD_API_BASE,
        authToken: "tok",
        agentName: "Eliza",
        signal: controller.signal,
      }),
    ).rejects.toThrow(/signed out/i);
    expect(deleteAgent).not.toHaveBeenCalled();
  });

  test("reports both cancellation and compensating deletion failure", async () => {
    const controller = new AbortController();
    const cleanupError = new Error("delete failed");
    const { client } = makeClient({
      agentId: "agent-created",
      agentName: "Eliza",
      apiBase: SHARED_BASE,
      bridgeUrl: null,
      created: true,
    });
    client.deleteCloudCompatAgent = vi.fn().mockRejectedValue(cleanupError);
    const select = client.selectOrProvisionCloudAgent;
    client.selectOrProvisionCloudAgent = vi.fn(async (options) => {
      const result = await select(options);
      controller.abort(new DOMException("signed out", "AbortError"));
      return result;
    });
    const { effects } = makeEffects();

    const failure = await runJoinFlow({
      client,
      effects,
      cloudApiBase: CLOUD_API_BASE,
      authToken: "tok",
      agentName: "Eliza",
      signal: controller.signal,
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toContain(cleanupError);
    expect((failure as AggregateError).errors).toContain(
      controller.signal.reason,
    );
  });
});
