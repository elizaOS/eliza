/**
 * SpotifyService credential-resolution tests across both modes: local-mode
 * refresh from SPOTIFY_* settings, managed accounts reading vaulted tokens,
 * expiry-driven refresh with durable write-back, revoked-account fail-fast,
 * and account-selection precedence. Uses the real core ConnectorAccountManager
 * with in-memory storage and the protocol-faithful fetch harness.
 */
import { ConnectorAccountManager, type IAgentRuntime } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { SPOTIFY_TOKEN_ENDPOINT } from "../auth";
import { SpotifyService } from "../service";
import { LOCAL_ACCOUNT_ID } from "../types";
import { jsonResponse, MockSpotify, rawDevice, tokenGrantBody } from "./mock-spotify";

const API = "https://api.spotify.test";

interface Harness {
  runtime: IAgentRuntime;
  manager: ConnectorAccountManager;
  vault: Map<string, string>;
  reported: string[];
}

function makeHarness(settings: Record<string, string>): Harness {
  const vault = new Map<string, string>();
  const reported: string[] = [];
  let manager: ConnectorAccountManager | undefined;
  const runtime = {
    agentId: "agent-1",
    getSetting: (key: string) => settings[key],
    getService: (type: string) => {
      if (type === "vault") {
        return {
          set: (key: string, value: string) => {
            vault.set(key, value);
          },
          get: (key: string) => vault.get(key) ?? null,
        };
      }
      if (type === "connector_account" && manager) return manager;
      return null;
    },
    reportError: (scope: string) => {
      reported.push(scope);
    },
    adapter: {
      setConnectorAccountCredentialRef: () => {},
    },
  } as unknown as IAgentRuntime;
  manager = new ConnectorAccountManager(runtime);
  return { runtime, manager, vault, reported };
}

async function seedManagedAccount(
  harness: Harness,
  tokens: { access: string; refresh?: string; expiresAt: number }
): Promise<string> {
  const vaultRef = "connector.agent-1.spotify.acct-1.oauth_tokens";
  harness.vault.set(
    vaultRef,
    JSON.stringify({
      access_token: tokens.access,
      ...(tokens.refresh ? { refresh_token: tokens.refresh } : {}),
      expiry_date: tokens.expiresAt,
      scope: "user-library-read",
    })
  );
  const account = await harness.manager.upsertAccount(
    "spotify",
    {
      provider: "spotify",
      role: "OWNER",
      purpose: ["media"],
      accessGate: "open",
      status: "connected",
      externalId: "spotify-user",
      metadata: { credentialRefs: [{ credentialType: "oauth.tokens", vaultRef }] },
    },
    "acct-1"
  );
  return account.id;
}

describe("SpotifyService", () => {
  it("local mode refreshes with SPOTIFY_* settings and serves API calls", async () => {
    const mock = new MockSpotify()
      .on("POST", SPOTIFY_TOKEN_ENDPOINT, () =>
        jsonResponse(200, tokenGrantBody({ accessToken: "local-at" }))
      )
      .on("GET", `${API}/v1/me/player/devices`, () =>
        jsonResponse(200, { devices: [rawDevice("d1", "Desk", true)] })
      );
    const harness = makeHarness({
      SPOTIFY_CLIENT_ID: "id",
      SPOTIFY_CLIENT_SECRET: "secret",
      SPOTIFY_REFRESH_TOKEN: "rt",
    });
    const service = new SpotifyService(harness.runtime, { fetchImpl: mock.fetch, apiBase: API });
    const accountId = await service.resolveAccountId();
    expect(accountId).toBe(LOCAL_ACCOUNT_ID);
    const devices = await service.listDevices({ accountId });
    expect(devices[0]?.name).toBe("Desk");
    expect(mock.requests[1]?.headers.authorization).toBe("Bearer local-at");
    // The cached token is reused: no second token-endpoint hit.
    await service.listDevices({ accountId });
    const tokenCalls = mock.requests.filter((r) => r.url === SPOTIFY_TOKEN_ENDPOINT);
    expect(tokenCalls).toHaveLength(1);
  });

  it("fails fast with SPOTIFY_AUTH_REQUIRED when nothing is configured", async () => {
    const harness = makeHarness({});
    const service = new SpotifyService(harness.runtime);
    await expect(service.resolveAccountId()).rejects.toMatchObject({
      code: "SPOTIFY_AUTH_REQUIRED",
    });
  });

  it("prefers a connected managed account over local mode and reads vaulted tokens", async () => {
    const mock = new MockSpotify().on("GET", `${API}/v1/me/player/devices`, () =>
      jsonResponse(200, { devices: [] })
    );
    const harness = makeHarness({
      SPOTIFY_CLIENT_ID: "id",
      SPOTIFY_CLIENT_SECRET: "secret",
      SPOTIFY_REFRESH_TOKEN: "rt",
    });
    const accountId = await seedManagedAccount(harness, {
      access: "vaulted-at",
      expiresAt: Date.now() + 3_600_000,
    });
    const service = new SpotifyService(harness.runtime, { fetchImpl: mock.fetch, apiBase: API });
    const resolved = await service.resolveAccountId();
    expect(resolved).toBe(accountId);
    const devices = await service.listDevices({ accountId: resolved });
    expect(devices).toEqual([]);
    expect(mock.requests[0]?.headers.authorization).toBe("Bearer vaulted-at");
  });

  it("refreshes an expired managed token and persists it back to the vault", async () => {
    const mock = new MockSpotify()
      .on("POST", SPOTIFY_TOKEN_ENDPOINT, () =>
        jsonResponse(200, tokenGrantBody({ accessToken: "refreshed-at" }))
      )
      .on("GET", `${API}/v1/me/player/devices`, () => jsonResponse(200, { devices: [] }));
    const harness = makeHarness({ SPOTIFY_CLIENT_ID: "id", SPOTIFY_CLIENT_SECRET: "secret" });
    const accountId = await seedManagedAccount(harness, {
      access: "expired-at",
      refresh: "managed-rt",
      expiresAt: Date.now() - 1000,
    });
    const service = new SpotifyService(harness.runtime, { fetchImpl: mock.fetch, apiBase: API });
    await service.listDevices({ accountId });
    const tokenBody = new URLSearchParams(
      mock.requests.find((r) => r.url === SPOTIFY_TOKEN_ENDPOINT)?.body ?? ""
    );
    expect(tokenBody.get("refresh_token")).toBe("managed-rt");
    const apiCall = mock.requests.find((r) => r.url.includes("/v1/me/player/devices"));
    expect(apiCall?.headers.authorization).toBe("Bearer refreshed-at");
    const vaulted = [...harness.vault.values()].join("\n");
    expect(vaulted).toContain("refreshed-at");
  });

  it("surfaces SPOTIFY_AUTH_REVOKED for an expired token without a refresh token", async () => {
    const harness = makeHarness({ SPOTIFY_CLIENT_ID: "id" });
    const accountId = await seedManagedAccount(harness, {
      access: "expired-at",
      expiresAt: Date.now() - 1000,
    });
    const service = new SpotifyService(harness.runtime, { apiBase: API });
    await expect(service.listDevices({ accountId })).rejects.toMatchObject({
      code: "SPOTIFY_AUTH_REVOKED",
    });
  });

  it("fails fast on a revoked account status before touching the network", async () => {
    const harness = makeHarness({});
    await harness.manager.upsertAccount(
      "spotify",
      {
        provider: "spotify",
        role: "OWNER",
        purpose: ["media"],
        accessGate: "open",
        status: "revoked",
        metadata: {},
      },
      "acct-revoked"
    );
    const service = new SpotifyService(harness.runtime, { apiBase: API });
    await expect(service.listDevices({ accountId: "acct-revoked" })).rejects.toMatchObject({
      code: "SPOTIFY_AUTH_REVOKED",
    });
  });

  it("invalidateAccount drops cached tokens so the next call re-resolves", async () => {
    const mock = new MockSpotify()
      .on("POST", SPOTIFY_TOKEN_ENDPOINT, () =>
        jsonResponse(200, tokenGrantBody({ accessToken: "at" }))
      )
      .on("GET", `${API}/v1/me/player/devices`, () => jsonResponse(200, { devices: [] }));
    const harness = makeHarness({
      SPOTIFY_CLIENT_ID: "id",
      SPOTIFY_CLIENT_SECRET: "secret",
      SPOTIFY_REFRESH_TOKEN: "rt",
    });
    const service = new SpotifyService(harness.runtime, { fetchImpl: mock.fetch, apiBase: API });
    await service.listDevices({ accountId: LOCAL_ACCOUNT_ID });
    service.invalidateAccount(LOCAL_ACCOUNT_ID);
    await service.listDevices({ accountId: LOCAL_ACCOUNT_ID });
    const tokenCalls = mock.requests.filter((r) => r.url === SPOTIFY_TOKEN_ENDPOINT);
    expect(tokenCalls).toHaveLength(2);
  });
});
