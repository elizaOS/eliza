/** Verifies that Cloud join binds the rowless personal Eliza without provisioning compute. */

import { describe, expect, test, vi } from "vitest";
import {
  type JoinFlowClient,
  type JoinFlowEffects,
  runJoinFlow,
} from "./run-join-flow";

const CLOUD_API_BASE = "https://api.eliza.app";
const PERSONAL_ID = "personal:00000000-0000-5000-8000-000000000001";
const PERSONAL_BASE = `${CLOUD_API_BASE}/api/v1/eliza/agents/personal%3A00000000-0000-5000-8000-000000000001`;

function harness() {
  const getPersonalSharedEliza = vi.fn().mockResolvedValue({
    agentId: PERSONAL_ID,
    agentName: "Eliza",
    apiBase: PERSONAL_BASE,
    runtime: "shared" as const,
  });
  const setBaseUrl = vi.fn();
  const setToken = vi.fn();
  const savePersistedActiveServer = vi.fn();
  const savePersistedFirstRunComplete = vi.fn();
  const client: JoinFlowClient = {
    getPersonalSharedEliza,
    setBaseUrl,
    setToken,
  };
  const effects: JoinFlowEffects = {
    savePersistedActiveServer,
    savePersistedFirstRunComplete,
  };
  return {
    client,
    effects,
    getPersonalSharedEliza,
    setBaseUrl,
    setToken,
    savePersistedActiveServer,
    savePersistedFirstRunComplete,
  };
}

describe("runJoinFlow", () => {
  test("resolves and persists the account-native Shared identity", async () => {
    const h = harness();
    const onProgress = vi.fn();

    const result = await runJoinFlow({
      client: h.client,
      effects: h.effects,
      cloudApiBase: CLOUD_API_BASE,
      authToken: "session-token",
      onProgress,
    });

    expect(h.getPersonalSharedEliza).toHaveBeenCalledWith({
      cloudApiBase: CLOUD_API_BASE,
      authToken: "session-token",
    });
    expect(onProgress).toHaveBeenCalledWith(
      "connecting",
      "Opening your personal Eliza…",
    );
    expect(h.setBaseUrl).toHaveBeenCalledWith(PERSONAL_BASE);
    expect(h.setToken).toHaveBeenCalledWith("session-token");
    expect(h.savePersistedActiveServer).toHaveBeenCalledWith({
      id: `cloud:${PERSONAL_ID}`,
      kind: "cloud",
      label: "Eliza",
      apiBase: PERSONAL_BASE,
      accessToken: "session-token",
    });
    expect(h.savePersistedFirstRunComplete).toHaveBeenCalledWith(true);
    expect(result).toEqual({
      agentId: PERSONAL_ID,
      agentName: "Eliza",
      apiBase: PERSONAL_BASE,
      runtime: "shared",
    });
  });

  test("fails closed without persisting when identity resolution fails", async () => {
    const h = harness();
    h.getPersonalSharedEliza.mockRejectedValueOnce(
      new Error("Cloud unavailable"),
    );

    await expect(
      runJoinFlow({
        client: h.client,
        effects: h.effects,
        cloudApiBase: CLOUD_API_BASE,
        authToken: "session-token",
      }),
    ).rejects.toThrow("Cloud unavailable");

    expect(h.setBaseUrl).not.toHaveBeenCalled();
    expect(h.savePersistedActiveServer).not.toHaveBeenCalled();
    expect(h.savePersistedFirstRunComplete).not.toHaveBeenCalled();
  });

  test("does not bind or persist when identity resolution finishes after cancellation", async () => {
    const h = harness();
    let resolveIdentity: (value: {
      agentId: string;
      agentName: string;
      apiBase: string;
      runtime: "shared";
    }) => void = () => undefined;
    h.getPersonalSharedEliza.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveIdentity = resolve;
        }),
    );
    const controller = new AbortController();
    const flow = runJoinFlow({
      client: h.client,
      effects: h.effects,
      cloudApiBase: CLOUD_API_BASE,
      authToken: "session-token",
      signal: controller.signal,
    });

    controller.abort(new DOMException("User signed out", "AbortError"));
    resolveIdentity({
      agentId: PERSONAL_ID,
      agentName: "Eliza",
      apiBase: PERSONAL_BASE,
      runtime: "shared",
    });

    await expect(flow).rejects.toMatchObject({ name: "AbortError" });
    expect(h.getPersonalSharedEliza).toHaveBeenCalledWith({
      cloudApiBase: CLOUD_API_BASE,
      authToken: "session-token",
      signal: controller.signal,
    });
    expect(h.setBaseUrl).not.toHaveBeenCalled();
    expect(h.setToken).not.toHaveBeenCalled();
    expect(h.savePersistedActiveServer).not.toHaveBeenCalled();
    expect(h.savePersistedFirstRunComplete).not.toHaveBeenCalled();
  });

  test("rejects a pre-aborted attempt before starting identity resolution", async () => {
    const h = harness();
    const controller = new AbortController();
    controller.abort(new DOMException("Already signed out", "AbortError"));

    await expect(
      runJoinFlow({
        client: h.client,
        effects: h.effects,
        cloudApiBase: CLOUD_API_BASE,
        authToken: "session-token",
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });

    expect(h.getPersonalSharedEliza).not.toHaveBeenCalled();
    expect(h.savePersistedActiveServer).not.toHaveBeenCalled();
  });
});
