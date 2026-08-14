/**
 * Verifies that account-native Shared identity resolution uses the read-only
 * personal endpoint and returns the standard per-agent chat base.
 */
// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => false },
  CapacitorHttp: { get: vi.fn(), post: vi.fn(), request: vi.fn() },
}));

import { ElizaClient } from "./client-base";
import "./client-cloud";
import {
  loadAgentProfileRegistry,
  upsertAndActivateAgentProfile,
} from "../state/agent-profiles";
import {
  createPersistedActiveServer,
  loadPersistedActiveServer,
  savePersistedActiveServer,
} from "../state/persistence";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("getPersonalSharedEliza", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("resolves the rowless identity without creating an agent", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        jsonResponse(200, {
          success: true,
          data: {
            identity: {
              id: "personal:3b9e517b-5c33-5c5f-a6f9-f78c764dc41b",
              displayName: "Eliza",
              runtime: "shared",
            },
          },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const controller = new AbortController();
    const result = await new ElizaClient().getPersonalSharedEliza({
      cloudApiBase: "https://api.eliza.app",
      authToken: "steward-token",
      signal: controller.signal,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://api.eliza.app/api/v1/eliza/personal",
    );
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: "GET",
      headers: {
        accept: "application/json",
        authorization: "Bearer steward-token",
      },
      signal: controller.signal,
    });
    expect(result).toEqual({
      personalElizaId: "personal:3b9e517b-5c33-5c5f-a6f9-f78c764dc41b",
      agentId: "personal:3b9e517b-5c33-5c5f-a6f9-f78c764dc41b",
      activeAgentId: "personal:3b9e517b-5c33-5c5f-a6f9-f78c764dc41b",
      agentName: "Eliza",
      apiBase:
        "https://api.eliza.app/api/v1/eliza/agents/personal%3A3b9e517b-5c33-5c5f-a6f9-f78c764dc41b",
      runtime: "shared",
    });
  });

  it("reconnects a returning account to its activated Dedicated target", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(200, {
          success: true,
          data: {
            identity: {
              id: "personal:3b9e517b-5c33-5c5f-a6f9-f78c764dc41b",
              displayName: "Eliza",
              runtime: "dedicated",
              activeAgentId: "00000000-0000-4000-8000-000000000020",
              apiBase:
                "https://00000000-0000-4000-8000-000000000020.cloud.eliza.app",
            },
          },
        }),
      ),
    );

    await expect(
      new ElizaClient().getPersonalSharedEliza({
        cloudApiBase: "https://api.eliza.app",
        authToken: "steward-token",
      }),
    ).resolves.toEqual({
      personalElizaId: "personal:3b9e517b-5c33-5c5f-a6f9-f78c764dc41b",
      agentId: "personal:3b9e517b-5c33-5c5f-a6f9-f78c764dc41b",
      activeAgentId: "00000000-0000-4000-8000-000000000020",
      agentName: "Eliza",
      apiBase: "https://00000000-0000-4000-8000-000000000020.cloud.eliza.app",
      runtime: "dedicated",
    });
  });

  it("rejects a response that does not identify the personal Shared runtime", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(200, {
          success: true,
          data: {
            identity: {
              id: "sandbox-row-id",
              displayName: "Eliza",
              runtime: "shared",
            },
          },
        }),
      ),
    );

    await expect(
      new ElizaClient().getPersonalSharedEliza({
        cloudApiBase: "https://api.eliza.app",
        authToken: "steward-token",
      }),
    ).rejects.toThrow("invalid personal Eliza identity");
  });
});

describe("personal Eliza runtime repoint", () => {
  const personalElizaId = "personal:3b9e517b-5c33-5c5f-a6f9-f78c764dc41b";
  const sharedBase =
    "https://api.eliza.app/api/v1/eliza/agents/personal%3A3b9e517b-5c33-5c5f-a6f9-f78c764dc41b";
  const dedicatedAgentId = "00000000-0000-4000-8000-000000000020";
  const dedicatedBase = `https://${dedicatedAgentId}.cloud.eliza.app`;

  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    const server = createPersistedActiveServer({
      kind: "cloud",
      id: `cloud:${personalElizaId}`,
      label: "Eliza",
      apiBase: sharedBase,
      accessToken: "steward-token",
      cloudRuntimeAgentId: personalElizaId,
      cloudRuntime: "shared",
    });
    savePersistedActiveServer(server);
    upsertAndActivateAgentProfile({
      kind: "cloud",
      label: "Eliza",
      cloudAgentId: personalElizaId,
      cloudRuntimeAgentId: personalElizaId,
      cloudRuntime: "shared",
      apiBase: sharedBase,
      accessToken: "steward-token",
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
    sessionStorage.clear();
  });

  it("repoints an open Shared client and retries the rejected turn once", async () => {
    const requestBodies: string[] = [];
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === `${sharedBase}/api/chat`) {
          requestBodies.push(String(init?.body));
          return jsonResponse(409, {
            success: false,
            code: "personal_eliza_dedicated",
            error: "This personal Eliza is active on Dedicated.",
          });
        }
        if (url === "https://api.eliza.app/api/v1/eliza/personal") {
          return jsonResponse(200, {
            success: true,
            data: {
              identity: {
                id: personalElizaId,
                displayName: "Eliza",
                runtime: "dedicated",
                activeAgentId: dedicatedAgentId,
                apiBase: dedicatedBase,
              },
            },
          });
        }
        if (url === `${dedicatedBase}/api/chat`) {
          requestBodies.push(String(init?.body));
          return jsonResponse(200, { delivered: true });
        }
        return jsonResponse(500, { error: `Unexpected URL ${url}` });
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new ElizaClient(sharedBase, "steward-token");
    const body = JSON.stringify({
      text: "keep this exact turn",
      clientMessageId: "same-idempotency-key",
    });

    await expect(
      client.fetch<{ delivered: boolean }>("/api/chat", {
        method: "POST",
        body,
      }),
    ).resolves.toEqual({ delivered: true });

    expect(requestBodies).toEqual([body, body]);
    expect(client.getBaseUrl()).toBe(dedicatedBase);
    expect(loadPersistedActiveServer()).toMatchObject({
      id: `cloud:${personalElizaId}`,
      apiBase: dedicatedBase,
      cloudRuntimeAgentId: dedicatedAgentId,
      cloudRuntime: "dedicated",
    });
    const registry = loadAgentProfileRegistry();
    expect(registry.profiles).toHaveLength(1);
    expect(registry.profiles[0]).toMatchObject({
      cloudAgentId: personalElizaId,
      cloudRuntimeAgentId: dedicatedAgentId,
      cloudRuntime: "dedicated",
      apiBase: dedicatedBase,
    });
    const calls = fetchMock.mock.calls.map(([url, init]) => ({
      url: String(url),
      method: init?.method ?? "GET",
    }));
    expect(calls).toEqual([
      { url: `${sharedBase}/api/chat`, method: "POST" },
      {
        url: "https://api.eliza.app/api/v1/eliza/personal",
        method: "GET",
      },
      { url: `${dedicatedBase}/api/chat`, method: "POST" },
    ]);
    expect(JSON.stringify(calls)).not.toMatch(
      /upgrade-tier|provision|create-agent|sandbox/i,
    );
  });

  it("fails closed when the saved logical identity does not own the rejection", async () => {
    savePersistedActiveServer(
      createPersistedActiveServer({
        kind: "cloud",
        id: "cloud:personal:00000000-0000-5000-8000-000000000099",
        label: "Other account",
        apiBase: sharedBase,
        accessToken: "steward-token",
      }),
    );
    const fetchMock = vi.fn(async () =>
      jsonResponse(409, {
        code: "personal_eliza_dedicated",
        error: "This personal Eliza is active on Dedicated.",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new ElizaClient(sharedBase, "steward-token");

    await expect(client.fetch("/api/chat")).rejects.toMatchObject({
      status: 409,
      code: "personal_eliza_dedicated",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(client.getBaseUrl()).toBe(sharedBase);
  });

  it("does not fabricate a Dedicated target when authority still reports Shared", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === `${sharedBase}/api/chat`) {
        return jsonResponse(409, {
          code: "personal_eliza_dedicated",
          error: "This personal Eliza is active on Dedicated.",
        });
      }
      return jsonResponse(200, {
        success: true,
        data: {
          identity: {
            id: personalElizaId,
            displayName: "Eliza",
            runtime: "shared",
          },
        },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new ElizaClient(sharedBase, "steward-token");

    await expect(client.fetch("/api/chat")).rejects.toMatchObject({
      status: 409,
      code: "personal_eliza_dedicated",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(client.getBaseUrl()).toBe(sharedBase);
    expect(loadPersistedActiveServer()).toMatchObject({
      id: `cloud:${personalElizaId}`,
      cloudRuntime: "shared",
    });
  });
});
