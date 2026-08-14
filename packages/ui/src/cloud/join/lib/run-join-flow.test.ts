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

  test("conditionally deletes a newly created agent when cancellation arrives after selection", async () => {
    const controller = new AbortController();
    const deleteAgent = vi.fn().mockResolvedValue({
      success: true,
      data: { jobId: "", status: "deleted", message: "deleted" },
    });
    const { client } = makeClient(freshSelection());
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
    expect(deleteAgent).toHaveBeenCalledWith("agent-created", DELETE_CONDITION);
    expect(saveServer).not.toHaveBeenCalled();
  });

  test("does not delete a reused agent when cancellation arrives after selection", async () => {
    const controller = new AbortController();
    const deleteAgent = vi.fn().mockResolvedValue({
      success: true,
      data: { jobId: "", status: "deleted", message: "deleted" },
    });
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
    const { client } = makeClient(freshSelection());
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

  test("fails closed on a resolved conditional-identity mismatch", async () => {
    const controller = new AbortController();
    const { client } = makeClient(freshSelection());
    client.deleteCloudCompatAgent = vi.fn().mockResolvedValue({
      success: false,
      error: "agent identity no longer matches cleanup condition",
      data: { jobId: "", status: "error", message: "denied" },
    });
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
    expect((failure as AggregateError).errors).toContain(
      controller.signal.reason,
    );
    expect((failure as AggregateError).errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: "agent identity no longer matches cleanup condition",
        }),
      ]),
    );
  });

  test("treats an accepted async conditional delete as durable compensation", async () => {
    const controller = new AbortController();
    const { client } = makeClient(freshSelection());
    const deleteAgent = vi.fn().mockResolvedValue({
      success: true,
      data: {
        jobId: "delete-job",
        status: "pending",
        message: "queued",
      },
    });
    client.deleteCloudCompatAgent = deleteAgent;
    const select = client.selectOrProvisionCloudAgent;
    client.selectOrProvisionCloudAgent = vi.fn(async (options) => {
      const result = await select(options);
      controller.abort(new DOMException("signed out", "AbortError"));
      return result;
    });

    await expect(
      runJoinFlow({
        client,
        effects: makeEffects().effects,
        cloudApiBase: CLOUD_API_BASE,
        authToken: "tok",
        agentName: "Eliza",
        signal: controller.signal,
      }),
    ).rejects.toThrow(/signed out/i);

    expect(deleteAgent).toHaveBeenCalledWith("agent-created", DELETE_CONDITION);
  });

  test("fails closed on a malformed successful delete without durable receipt", async () => {
    const controller = new AbortController();
    const { client } = makeClient(freshSelection());
    client.deleteCloudCompatAgent = vi.fn().mockResolvedValue({
      success: true,
      data: { jobId: "", status: "pending", message: "ambiguous" },
    });
    const select = client.selectOrProvisionCloudAgent;
    client.selectOrProvisionCloudAgent = vi.fn(async (options) => {
      const result = await select(options);
      controller.abort(new DOMException("signed out", "AbortError"));
      return result;
    });

    const failure = await runJoinFlow({
      client,
      effects: makeEffects().effects,
      cloudApiBase: CLOUD_API_BASE,
      authToken: "tok",
      agentName: "Eliza",
      signal: controller.signal,
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message:
            "Eliza Cloud did not return a durable agent deletion receipt",
        }),
      ]),
    );
  });

  test("fails closed when the authoritative create identity is missing", async () => {
    const controller = new AbortController();
    const { client } = makeClient({
      ...freshSelection(),
      cleanupReceipt: undefined,
    });
    const deleteAgent = vi.fn();
    client.deleteCloudCompatAgent = deleteAgent;
    const select = client.selectOrProvisionCloudAgent;
    client.selectOrProvisionCloudAgent = vi.fn(async (options) => {
      const result = await select(options);
      controller.abort(new DOMException("signed out", "AbortError"));
      return result;
    });

    const failure = await runJoinFlow({
      client,
      effects: makeEffects().effects,
      cloudApiBase: CLOUD_API_BASE,
      authToken: "tok",
      agentName: "Eliza",
      signal: controller.signal,
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect(deleteAgent).not.toHaveBeenCalled();
  });

  test("runs compensation exactly once when cancellation is requested twice", async () => {
    const controller = new AbortController();
    const { client } = makeClient(freshSelection());
    const deleteAgent = vi.fn().mockResolvedValue({
      success: true,
      data: { jobId: "", status: "deleted", message: "deleted" },
    });
    client.deleteCloudCompatAgent = deleteAgent;
    const select = client.selectOrProvisionCloudAgent;
    client.selectOrProvisionCloudAgent = vi.fn(async (options) => {
      const result = await select(options);
      controller.abort(new DOMException("signed out", "AbortError"));
      controller.abort(new DOMException("superseded", "AbortError"));
      return result;
    });

    await expect(
      runJoinFlow({
        client,
        effects: makeEffects().effects,
        cloudApiBase: CLOUD_API_BASE,
        authToken: "tok",
        agentName: "Eliza",
        signal: controller.signal,
      }),
    ).rejects.toThrow(/signed out/i);
    expect(deleteAgent).toHaveBeenCalledTimes(1);
  });
});
