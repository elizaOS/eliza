/**
 * Remote-mode consumption of the remote-agent pairing payload: strict parsing,
 * origin trust before any request, and instance binding. The server side of the
 * same contract is exercised over real HTTP in
 * packages/agent/test/remote-agent-pairing-http.test.ts.
 */
import { buildRemoteAgentPairingUri } from "@elizaos/contracts";
import { describe, expect, it, vi } from "vitest";
import { ElizaClient } from "../api/client";
import {
  exchangeRemoteAgentPairing,
  parseRemoteAgentPairingDeepLink,
  type RemoteAgentPairingClient,
  RemoteAgentPairingError,
} from "./remote-agent-pairing";

const ORIGIN = "https://alpha-agent.example";
const INSTANCE = "5b8c6c0e-3a1f-4d2b-9e7a-1c2d3e4f5a6b";

function agent(instanceId: string) {
  const calls: string[] = [];
  const client: RemoteAgentPairingClient = {
    setBaseUrl: (base) => calls.push(`base:${base}`),
    setToken: (token) => calls.push(`token:${token}`),
    getAuthStatus: async () => {
      calls.push("status");
      return { instanceId, pairingEnabled: true };
    },
    pair: async (code, expectedInstanceId) => {
      expect(expectedInstanceId).toBe(INSTANCE);
      calls.push(`pair:${code}`);
      return { token: "server-issued", instanceId };
    },
  };
  return { client, calls };
}

describe("remote agent pairing deep link", () => {
  it("round-trips the canonical payload for the app scheme", () => {
    const uri = buildRemoteAgentPairingUri(
      { apiBase: `${ORIGIN}/`, code: "abcd-efgh", instanceId: INSTANCE },
      "eliza",
    );
    expect(parseRemoteAgentPairingDeepLink(uri, "eliza")).toEqual({
      version: 1,
      apiBase: ORIGIN,
      code: "ABCD-EFGH",
      instanceId: INSTANCE,
    });
    expect(parseRemoteAgentPairingDeepLink(uri, "elizaos")).toBeNull();
  });

  it.each([
    ["a bearer token", `&token=secret`],
    ["a duplicate code", `&code=WXYZ-2345`],
  ])("rejects a payload carrying %s", (_label, extra) => {
    const uri = `${buildRemoteAgentPairingUri({
      apiBase: ORIGIN,
      code: "ABCD-EFGH",
      instanceId: INSTANCE,
    })}${extra}`;
    expect(parseRemoteAgentPairingDeepLink(uri, "elizaos")).toBeNull();
  });

  it("rejects non-HTTPS or path-scoped agent addresses", () => {
    for (const url of [
      "http://alpha-agent.example",
      "https://user:pass@alpha-agent.example",
      "https://alpha-agent.example/api",
    ]) {
      const uri = `elizaos://remote/agent-pair?v=1&url=${encodeURIComponent(url)}&code=ABCD-EFGH&instance=${INSTANCE}`;
      expect(parseRemoteAgentPairingDeepLink(uri, "elizaos")).toBeNull();
    }
    expect(() =>
      buildRemoteAgentPairingUri({
        apiBase: "http://alpha-agent.example",
        code: "ABCD-EFGH",
        instanceId: INSTANCE,
      }),
    ).toThrow(TypeError);
  });
});

describe("remote agent pairing exchange", () => {
  const payload = {
    version: 1 as const,
    apiBase: ORIGIN,
    code: "ABCD-EFGH",
    instanceId: INSTANCE,
  };

  it("exchanges the code with the issuing instance and returns its token", async () => {
    const { client, calls } = agent(INSTANCE);
    await expect(
      exchangeRemoteAgentPairing(payload, client, (base) => base === ORIGIN),
    ).resolves.toEqual({
      apiBase: ORIGIN,
      token: "server-issued",
      instanceId: INSTANCE,
    });
    expect(calls).toEqual([
      `base:${ORIGIN}`,
      "token:null",
      "status",
      "pair:ABCD-EFGH",
    ]);
  });

  it("does not submit a code if the agent restarts between status reads", async () => {
    const client = new ElizaClient(ORIGIN);
    const status = vi
      .spyOn(client, "getAuthStatus")
      .mockResolvedValueOnce({
        required: true,
        pairingEnabled: true,
        expiresAt: null,
        instanceId: INSTANCE,
      })
      .mockResolvedValueOnce({
        required: true,
        pairingEnabled: true,
        expiresAt: null,
        instanceId: "0f1e2d3c-4b5a-4987-8a6b-5c4d3e2f1a0b",
      });
    const network = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("Unexpected pairing request"));
    try {
      await expect(
        exchangeRemoteAgentPairing(payload, client, () => true),
      ).rejects.toMatchObject({ code: "PAIRING_INSTANCE_MISMATCH" });
      expect(status).toHaveBeenCalledTimes(2);
      expect(network).not.toHaveBeenCalled();
    } finally {
      status.mockRestore();
      network.mockRestore();
    }
  });

  it("refuses an untrusted origin before any request", async () => {
    const { client, calls } = agent(INSTANCE);
    await expect(
      exchangeRemoteAgentPairing(payload, client, () => false),
    ).rejects.toMatchObject({ code: "REMOTE_AGENT_ORIGIN_UNTRUSTED" });
    expect(calls).toEqual([]);
  });

  it("refuses a stale code from a restarted or different agent", async () => {
    const { client, calls } = agent("0f1e2d3c-4b5a-4987-8a6b-5c4d3e2f1a0b");
    const failure = await exchangeRemoteAgentPairing(
      payload,
      client,
      () => true,
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(RemoteAgentPairingError);
    expect((failure as RemoteAgentPairingError).code).toBe(
      "PAIRING_INSTANCE_MISMATCH",
    );
    expect(calls).not.toContain("pair:ABCD-EFGH");
  });
});
