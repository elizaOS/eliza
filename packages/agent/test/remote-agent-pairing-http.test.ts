/**
 * Real host HTTP for the remote-agent pairing contract used by the phone's
 * Remote mode against a hosted (e.g. dstack) agent without reachable loopback:
 * operator code issuance, QR payload round trip, instance binding, single use,
 * and bearer use of the paired credential.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  buildRemoteAgentPairingUri,
  parseRemoteAgentPairingUri,
  REMOTE_AGENT_ENDPOINTS,
} from "@elizaos/contracts";
import { createCharacter } from "@elizaos/core";
import { createSQLiteTestRuntime } from "@elizaos/testing/runtime";
import { expect, it, vi } from "vitest";
import { startApiServer } from "../src/api/server.ts";

const API_TOKEN = "alpha-pairing-test-token-7c1f0d4e9b2a6f38";

it("pairs a remote phone through an operator-issued, instance-bound code", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "eliza-remote-pair-"));
  for (const [key, value] of Object.entries({
    ELIZA_STATE_DIR: directory,
    ELIZA_CONFIG_PATH: path.join(directory, "config.json"),
    ELIZA_PERSIST_CONFIG_PATH: path.join(directory, "config.json"),
    ELIZA_API_BIND_HOST: "127.0.0.1",
    ELIZA_API_TOKEN: API_TOKEN,
    // A hosted CVM has no trusted loopback operator; every request is remote.
    ELIZA_REQUIRE_LOCAL_AUTH: "1",
    ELIZA_PAIRING_DISABLED: "",
    ELIZA_CLOUD_PROVISIONED: "",
  }))
    vi.stubEnv(key, value);
  const runtime = createSQLiteTestRuntime({
    character: createCharacter({ name: "RemotePairing" }),
    logLevel: "fatal",
    enableAutonomy: false,
  });
  let server: Awaited<ReturnType<typeof startApiServer>> | undefined;
  try {
    await runtime.initialize();
    server = await startApiServer({
      port: 0,
      runtime,
      skipDeferredStartupWork: true,
    });
    const base = `http://127.0.0.1:${server.port}`;
    const call = async (
      route: string,
      init: { method?: string; token?: string; body?: object } = {},
    ) => {
      const response = await fetch(`${base}${route}`, {
        method: init.method ?? "GET",
        headers: {
          ...(init.body ? { "content-type": "application/json" } : {}),
          ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
        },
        ...(init.body ? { body: JSON.stringify(init.body) } : {}),
      });
      return {
        status: response.status,
        body: (await response.json()) as Record<string, unknown>,
      };
    };

    const status = await call(REMOTE_AGENT_ENDPOINTS.status);
    expect(status.status).toBe(200);
    expect(status.body).toMatchObject({
      required: true,
      authenticated: false,
      pairingEnabled: true,
    });
    const instanceId = String(status.body.instanceId);
    expect(instanceId).toMatch(/^[0-9a-f-]{36}$/);

    // Only an operator holding the API token can read the one-time code.
    expect((await call(REMOTE_AGENT_ENDPOINTS.pairCode)).status).toBe(403);
    expect(
      (await call(REMOTE_AGENT_ENDPOINTS.pairCode, { token: "wrong" })).status,
    ).toBe(403);
    const issued = await call(REMOTE_AGENT_ENDPOINTS.pairCode, {
      token: API_TOKEN,
    });
    expect(issued.status).toBe(200);
    expect(issued.body.instanceId).toBe(instanceId);

    // The QR payload carries origin, code and instance — never a token.
    const uri = buildRemoteAgentPairingUri({
      apiBase: "https://alpha-agent.example",
      code: String(issued.body.code).toLowerCase(),
      instanceId,
    });
    expect(uri).not.toContain(API_TOKEN);
    const payload = parseRemoteAgentPairingUri(uri);
    expect(payload).toEqual({
      version: 1,
      apiBase: "https://alpha-agent.example",
      code: String(issued.body.code),
      instanceId,
    });
    if (!payload) throw new Error("pairing payload did not round-trip");

    const otherInstance = await call(REMOTE_AGENT_ENDPOINTS.pair, {
      method: "POST",
      body: {
        code: payload.code,
        instanceId: "00000000-0000-4000-8000-000000000000",
      },
    });
    expect(otherInstance.status).toBe(409);
    expect(otherInstance.body.code).toBe("PAIRING_INSTANCE_MISMATCH");

    const paired = await call(REMOTE_AGENT_ENDPOINTS.pair, {
      method: "POST",
      body: { code: payload.code, instanceId: payload.instanceId },
    });
    expect(paired).toEqual({
      status: 200,
      body: { token: API_TOKEN, instanceId },
    });

    // Codes are single use.
    const reused = await call(REMOTE_AGENT_ENDPOINTS.pair, {
      method: "POST",
      body: { code: payload.code, instanceId: payload.instanceId },
    });
    expect(reused.status).toBe(403);

    const me = await call("/api/auth/me", { token: String(paired.body.token) });
    expect(me.status).toBe(200);
    expect(
      (await call("/api/auth/me", { token: "expired-or-wrong" })).status,
    ).toBe(401);
  } finally {
    await server?.close();
    await runtime.stop();
    await runtime.close();
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  }
});
