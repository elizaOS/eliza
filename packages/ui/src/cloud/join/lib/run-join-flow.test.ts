/** Verifies Cloud join reads and persists the signed-in personal runtime without paid activation. */

import { describe, expect, test, vi } from "vitest";
import {
  type JoinFlowClient,
  type JoinFlowEffects,
  runJoinFlow,
} from "./run-join-flow";

const CLOUD_API_BASE = "https://api.eliza.app";
const PERSONAL_ID = "personal:00000000-0000-5000-8000-000000000001";
const DEDICATED_ID = "00000000-0000-4000-8000-000000000020";
const PERSONAL_BASE = `https://${DEDICATED_ID}.cloud.eliza.app`;

function harness() {
  const getPersonalSharedEliza = vi.fn().mockResolvedValue({
    personalElizaId: PERSONAL_ID,
    agentId: PERSONAL_ID,
    activeAgentId: DEDICATED_ID,
    agentName: "Eliza",
    apiBase: PERSONAL_BASE,
    runtime: "dedicated" as const,
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
  test("reads and persists an existing account-native Dedicated identity", async () => {
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
      cloudRuntimeAgentId: DEDICATED_ID,
      cloudRuntime: "dedicated",
    });
    expect(h.savePersistedFirstRunComplete).toHaveBeenCalledWith(true);
    expect(result).toEqual({
      personalElizaId: PERSONAL_ID,
      agentId: PERSONAL_ID,
      activeAgentId: DEDICATED_ID,
      agentName: "Eliza",
      apiBase: PERSONAL_BASE,
      runtime: "dedicated",
    });
  });

  test("keeps the personal identity stable when Dedicated is already active", async () => {
    const h = harness();
    const dedicatedAgentId = "00000000-0000-4000-8000-000000000020";
    const dedicatedBase = `https://${dedicatedAgentId}.cloud.eliza.app`;
    h.getPersonalSharedEliza.mockResolvedValueOnce({
      personalElizaId: PERSONAL_ID,
      agentId: PERSONAL_ID,
      activeAgentId: dedicatedAgentId,
      agentName: "Eliza",
      apiBase: dedicatedBase,
      runtime: "dedicated" as const,
    });

    const result = await runJoinFlow({
      client: h.client,
      effects: h.effects,
      cloudApiBase: CLOUD_API_BASE,
      authToken: "session-token",
    });

    expect(h.savePersistedActiveServer).toHaveBeenCalledWith({
      id: `cloud:${PERSONAL_ID}`,
      kind: "cloud",
      label: "Eliza",
      apiBase: dedicatedBase,
      accessToken: "session-token",
      cloudRuntimeAgentId: dedicatedAgentId,
      cloudRuntime: "dedicated",
    });
    expect(result).toEqual({
      personalElizaId: PERSONAL_ID,
      agentId: PERSONAL_ID,
      activeAgentId: dedicatedAgentId,
      agentName: "Eliza",
      apiBase: dedicatedBase,
      runtime: "dedicated",
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

  test("does not resolve identity when already cancelled", async () => {
    const controller = new AbortController();
    controller.abort(new DOMException("cancelled", "AbortError"));
    const h = harness();

    await expect(
      runJoinFlow({
        client: h.client,
        effects: h.effects,
        cloudApiBase: CLOUD_API_BASE,
        authToken: "tok",
        signal: controller.signal,
      }),
    ).rejects.toThrow(/cancelled/i);
    expect(h.getPersonalSharedEliza).not.toHaveBeenCalled();
    expect(h.savePersistedActiveServer).not.toHaveBeenCalled();
  });

  test("passes cancellation through the read-only identity request", async () => {
    const controller = new AbortController();
    const h = harness();

    await runJoinFlow({
      client: h.client,
      effects: h.effects,
      cloudApiBase: CLOUD_API_BASE,
      authToken: "tok",
      signal: controller.signal,
    });

    expect(h.getPersonalSharedEliza).toHaveBeenCalledWith({
      cloudApiBase: CLOUD_API_BASE,
      authToken: "tok",
      signal: controller.signal,
    });
  });

  test("does not persist when cancellation arrives after identity resolution", async () => {
    const controller = new AbortController();
    const h = harness();
    h.getPersonalSharedEliza.mockImplementationOnce(async () => {
      controller.abort(new DOMException("signed out", "AbortError"));
      return {
        personalElizaId: PERSONAL_ID,
        agentId: PERSONAL_ID,
        activeAgentId: DEDICATED_ID,
        agentName: "Eliza",
        apiBase: PERSONAL_BASE,
        runtime: "dedicated" as const,
      };
    });

    await expect(
      runJoinFlow({
        client: h.client,
        effects: h.effects,
        cloudApiBase: CLOUD_API_BASE,
        authToken: "tok",
        signal: controller.signal,
      }),
    ).rejects.toThrow(/signed out/i);
    expect(h.setBaseUrl).not.toHaveBeenCalled();
    expect(h.savePersistedActiveServer).not.toHaveBeenCalled();
  });

  test("opens the stable Shared conversation without activating Dedicated compute", async () => {
    const h = harness();
    h.getPersonalSharedEliza.mockResolvedValueOnce({
      personalElizaId: PERSONAL_ID,
      agentId: PERSONAL_ID,
      activeAgentId: PERSONAL_ID,
      agentName: "Eliza",
      apiBase: `${CLOUD_API_BASE}/api/v1/eliza/agents/${encodeURIComponent(PERSONAL_ID)}`,
      runtime: "shared",
    });
    const result = await runJoinFlow({
      client: h.client,
      effects: h.effects,
      cloudApiBase: CLOUD_API_BASE,
      authToken: "session-token",
    });
    expect(result.runtime).toBe("shared");
    expect(result.activeAgentId).toBe(PERSONAL_ID);
    expect(h.savePersistedActiveServer).toHaveBeenCalledWith(
      expect.objectContaining({
        id: `cloud:${PERSONAL_ID}`,
        cloudRuntimeAgentId: PERSONAL_ID,
        cloudRuntime: "shared",
      }),
    );
  });

  test("refuses a different Shared conversation before installing authority", async () => {
    const h = harness();
    h.getPersonalSharedEliza.mockResolvedValueOnce({
      personalElizaId: PERSONAL_ID,
      agentId: PERSONAL_ID,
      activeAgentId: DEDICATED_ID,
      agentName: "Eliza",
      apiBase: PERSONAL_BASE,
      runtime: "shared",
    });
    await expect(
      runJoinFlow({
        client: h.client,
        effects: h.effects,
        cloudApiBase: CLOUD_API_BASE,
        authToken: "session-token",
      }),
    ).rejects.toThrow("different Shared conversation identity");
    expect(h.setBaseUrl).not.toHaveBeenCalled();
    expect(h.setToken).not.toHaveBeenCalled();
    expect(h.savePersistedActiveServer).not.toHaveBeenCalled();
  });

  test.each(["Opening your personal Eliza…", "Finishing setup…"])(
    "honors synchronous cancellation from %s progress before side effects",
    async (detail) => {
      const h = harness();
      const controller = new AbortController();
      await expect(
        runJoinFlow({
          client: h.client,
          effects: h.effects,
          cloudApiBase: CLOUD_API_BASE,
          authToken: "session-token",
          signal: controller.signal,
          onProgress: (_status, current) => {
            if (current === detail)
              controller.abort(
                new DOMException("session changed", "AbortError"),
              );
          },
        }),
      ).rejects.toThrow("session changed");
      if (detail === "Opening your personal Eliza…")
        expect(h.getPersonalSharedEliza).not.toHaveBeenCalled();
      expect(h.setBaseUrl).not.toHaveBeenCalled();
      expect(h.setToken).not.toHaveBeenCalled();
      expect(h.savePersistedActiveServer).not.toHaveBeenCalled();
      expect(h.savePersistedFirstRunComplete).not.toHaveBeenCalled();
    },
  );
});
