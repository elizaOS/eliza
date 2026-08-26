/** Verifies that Cloud join persists only the signed-in personal Dedicated runtime. */

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
  const ensurePersonalDedicatedEliza = vi.fn().mockResolvedValue({
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
    ensurePersonalDedicatedEliza,
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
    ensurePersonalDedicatedEliza,
    setBaseUrl,
    setToken,
    savePersistedActiveServer,
    savePersistedFirstRunComplete,
  };
}

describe("runJoinFlow", () => {
  test("activates and persists the account-native Dedicated identity", async () => {
    const h = harness();
    const onProgress = vi.fn();

    const result = await runJoinFlow({
      client: h.client,
      effects: h.effects,
      cloudApiBase: CLOUD_API_BASE,
      authToken: "session-token",
      onProgress,
    });

    expect(h.ensurePersonalDedicatedEliza).toHaveBeenCalledWith({
      cloudApiBase: CLOUD_API_BASE,
      authToken: "session-token",
      onProgress,
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
    h.ensurePersonalDedicatedEliza.mockResolvedValueOnce({
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
    h.ensurePersonalDedicatedEliza.mockRejectedValueOnce(
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
    expect(h.ensurePersonalDedicatedEliza).not.toHaveBeenCalled();
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

    expect(h.ensurePersonalDedicatedEliza).toHaveBeenCalledWith({
      cloudApiBase: CLOUD_API_BASE,
      authToken: "tok",
      signal: controller.signal,
    });
  });

  test("does not persist when cancellation arrives after identity resolution", async () => {
    const controller = new AbortController();
    const h = harness();
    h.ensurePersonalDedicatedEliza.mockImplementationOnce(async () => {
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
});
