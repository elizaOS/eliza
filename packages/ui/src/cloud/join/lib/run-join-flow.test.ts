import { describe, expect, it, vi } from "vitest";
import { type JoinFlowResult, runJoinFlow } from "./run-join-flow";

const personalId = "personal:00000001-1111-5111-8111-111111111111";
const ownerToken = "synthetic-owner-session";
const cloudApiBase = "https://api.example.test";

function ports(selected: JoinFlowResult) {
  const client = {
    getPersonalSharedEliza: vi.fn(async () => selected),
    // The old generic entry invoked this paid-compute path even for an
    // already-existing Shared account. A zero-credit owner cannot use it.
    ensurePersonalDedicatedEliza: vi.fn(async () => {
      throw Object.assign(new Error("Insufficient hosting credits"), {
        status: 402,
      });
    }),
    setBaseUrl: vi.fn(),
    setToken: vi.fn(),
  };
  const effects = {
    savePersistedActiveServer: vi.fn(),
    savePersistedFirstRunComplete: vi.fn(),
  };
  return { client, effects, cloudApiBase, authToken: ownerToken };
}

const shared: JoinFlowResult = {
  personalElizaId: personalId,
  agentId: personalId,
  activeAgentId: personalId,
  agentName: "Eliza",
  apiBase: `${cloudApiBase}/api/v1/eliza/agents/${encodeURIComponent(personalId)}`,
  runtime: "shared",
};

describe("personal chat entry", () => {
  it("opens an existing zero-credit Shared account without requesting paid activation", async () => {
    const input = ports(shared);
    const result = await runJoinFlow(input);

    expect(input.client.ensurePersonalDedicatedEliza).not.toHaveBeenCalled();
    expect(input.client.getPersonalSharedEliza).toHaveBeenCalledExactlyOnceWith(
      {
        cloudApiBase,
        authToken: ownerToken,
      },
    );
    expect(input.client.setBaseUrl).toHaveBeenCalledWith(shared.apiBase);
    expect(input.client.setToken).toHaveBeenCalledWith(ownerToken);
    expect(input.effects.savePersistedActiveServer).toHaveBeenCalledWith({
      id: `cloud:${personalId}`,
      kind: "cloud",
      label: "Eliza",
      apiBase: shared.apiBase,
      accessToken: ownerToken,
      cloudRuntimeAgentId: personalId,
      cloudRuntime: "shared",
    });
    expect(input.effects.savePersistedFirstRunComplete).toHaveBeenCalledWith(
      true,
    );
    expect(result).toEqual(shared);
  });

  it("preserves the existing Dedicated destination and identity for normal startup and wake polling", async () => {
    const dedicated: JoinFlowResult = {
      ...shared,
      activeAgentId: "00000002-1111-4111-8111-111111111111",
      apiBase: "https://existing-dedicated.example.test",
      runtime: "dedicated",
    };
    const input = ports(dedicated);
    expect(await runJoinFlow(input)).toEqual(dedicated);
    expect(input.client.getPersonalSharedEliza).toHaveBeenCalledTimes(1);
    expect(input.client.ensurePersonalDedicatedEliza).not.toHaveBeenCalled();
    expect(input.client.setBaseUrl).toHaveBeenCalledWith(dedicated.apiBase);
    expect(input.effects.savePersistedActiveServer).toHaveBeenCalledWith(
      expect.objectContaining({
        id: `cloud:${personalId}`,
        cloudRuntimeAgentId: dedicated.activeAgentId,
        cloudRuntime: "dedicated",
        apiBase: dedicated.apiBase,
      }),
    );
  });

  it("does not fall back or overwrite identity when the server refuses an unreconciled Dedicated destination", async () => {
    const input = ports(shared);
    const unavailable = Object.assign(
      new Error("Dedicated is restoring the conversation"),
      {
        status: 503,
        code: "dedicated_reconciling",
      },
    );
    input.client.getPersonalSharedEliza.mockRejectedValueOnce(unavailable);
    await expect(runJoinFlow(input)).rejects.toBe(unavailable);
    expect(input.client.setBaseUrl).not.toHaveBeenCalled();
    expect(input.client.setToken).not.toHaveBeenCalled();
    expect(input.effects.savePersistedActiveServer).not.toHaveBeenCalled();
    expect(input.client.ensurePersonalDedicatedEliza).not.toHaveBeenCalled();
  });

  it("does not install an old account binding when progress revalidation cancels entry", async () => {
    const input = ports(shared);
    const controller = new AbortController();
    await expect(
      runJoinFlow({
        ...input,
        signal: controller.signal,
        onProgress: (_status, detail) => {
          if (detail === "Finishing setup…") controller.abort();
        },
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(input.client.setBaseUrl).not.toHaveBeenCalled();
    expect(input.client.setToken).not.toHaveBeenCalled();
    expect(input.effects.savePersistedActiveServer).not.toHaveBeenCalled();
    expect(input.effects.savePersistedFirstRunComplete).not.toHaveBeenCalled();
  });
});
