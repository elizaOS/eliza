/**
 * Managed-OAuth provider tests using the REAL core ConnectorAccountManager
 * (in-memory storage) plus fake vault/ref-writer services: startOAuth's PKCE
 * authorization URL, scope narrowing and fail-closed unknown scopes,
 * completeOAuth's code exchange + identity fetch + vault-ref persistence (no
 * raw tokens in account metadata), denied callbacks, and disconnect/revoke
 * invalidation of the service token cache.
 */
import {
  ConnectorAccountManager,
  type ConnectorOAuthFlow,
  type IAgentRuntime,
} from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { SPOTIFY_AUTHORIZE_ENDPOINT, SPOTIFY_OAUTH_SCOPES, SPOTIFY_TOKEN_ENDPOINT } from "../auth";
import { createSpotifyConnectorAccountProvider } from "../connector-account-provider";
import { jsonResponse, MockSpotify, tokenGrantBody } from "./mock-spotify";

const API = "https://api.spotify.test";

interface Harness {
  runtime: IAgentRuntime;
  manager: ConnectorAccountManager;
  vault: Map<string, string>;
  refWrites: Array<Record<string, unknown>>;
  invalidated: string[];
}

function makeHarness(settings: Record<string, string>): Harness {
  const vault = new Map<string, string>();
  const refWrites: Array<Record<string, unknown>> = [];
  const invalidated: string[] = [];
  const services = new Map<string, unknown>([
    [
      "vault",
      {
        set: (key: string, value: string) => {
          vault.set(key, value);
        },
        get: (key: string) => vault.get(key) ?? null,
      },
    ],
    [
      "spotify",
      {
        invalidateAccount: (accountId: string) => {
          invalidated.push(accountId);
        },
      },
    ],
  ]);
  const runtime = {
    agentId: "agent-1",
    getSetting: (key: string) => settings[key],
    getService: (type: string) => services.get(type) ?? null,
    adapter: {
      setConnectorAccountCredentialRef: (params: Record<string, unknown>) => {
        refWrites.push(params);
      },
    },
  } as unknown as IAgentRuntime;
  const manager = new ConnectorAccountManager(runtime);
  return { runtime, manager, vault, refWrites, invalidated };
}

function makeFlow(overrides: Partial<ConnectorOAuthFlow> = {}): ConnectorOAuthFlow {
  const now = Date.now();
  return {
    id: "oauth_flow_1",
    provider: "spotify",
    state: "state-123",
    status: "pending",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

const SETTINGS = {
  SPOTIFY_CLIENT_ID: "spotify-client",
  SPOTIFY_CLIENT_SECRET: "spotify-secret",
  SPOTIFY_REDIRECT_URI: "https://host.example/api/connector-accounts/spotify/oauth/callback",
};

describe("Spotify connector account provider", () => {
  it("startOAuth builds a PKCE authorization URL with state and the full scope grant", async () => {
    const harness = makeHarness(SETTINGS);
    const provider = createSpotifyConnectorAccountProvider(harness.runtime);
    const result = await provider.startOAuth?.(
      { provider: "spotify", flow: makeFlow() },
      harness.manager
    );
    expect(result).toBeDefined();
    const url = new URL(result?.authUrl ?? "");
    expect(result?.authUrl?.startsWith(SPOTIFY_AUTHORIZE_ENDPOINT)).toBe(true);
    expect(url.searchParams.get("client_id")).toBe("spotify-client");
    expect(url.searchParams.get("state")).toBe("state-123");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBeTruthy();
    expect(url.searchParams.get("scope")).toBe(SPOTIFY_OAUTH_SCOPES.join(" "));
    expect(result?.codeVerifier).toBeTruthy();
    expect(result?.redirectUri).toBe(SETTINGS.SPOTIFY_REDIRECT_URI);
  });

  it("startOAuth narrows to an explicit scope subset and fails closed on unknown scopes", async () => {
    const harness = makeHarness(SETTINGS);
    const provider = createSpotifyConnectorAccountProvider(harness.runtime);
    const narrowed = await provider.startOAuth?.(
      { provider: "spotify", flow: makeFlow(), scopes: ["user-library-read"] },
      harness.manager
    );
    expect(new URL(narrowed?.authUrl ?? "").searchParams.get("scope")).toBe("user-library-read");
    await expect(
      provider.startOAuth?.(
        { provider: "spotify", flow: makeFlow(), scopes: ["user-follow-modify"] },
        harness.manager
      )
    ).rejects.toMatchObject({ code: "SPOTIFY_INVALID_INPUT" });
  });

  it("startOAuth fails closed without client configuration", async () => {
    const harness = makeHarness({});
    const provider = createSpotifyConnectorAccountProvider(harness.runtime);
    await expect(
      provider.startOAuth?.({ provider: "spotify", flow: makeFlow() }, harness.manager)
    ).rejects.toMatchObject({ code: "SPOTIFY_CONFIG_MISSING" });
  });

  it("completeOAuth exchanges the code, resolves identity, and vaults tokens", async () => {
    const harness = makeHarness(SETTINGS);
    const mock = new MockSpotify()
      .on("POST", SPOTIFY_TOKEN_ENDPOINT, () =>
        jsonResponse(200, tokenGrantBody({ accessToken: "managed-at", refreshToken: "managed-rt" }))
      )
      .on("GET", `${API}/v1/me`, () =>
        jsonResponse(200, {
          id: "spotify-user",
          display_name: "Listener",
          email: "listener@example.com",
          product: "premium",
          country: "US",
        })
      );
    const provider = createSpotifyConnectorAccountProvider(harness.runtime, {
      fetchImpl: mock.fetch,
      apiBase: API,
    });
    const result = await provider.completeOAuth?.(
      {
        provider: "spotify",
        flow: makeFlow({ codeVerifier: "verifier-1" }),
        code: "auth-code",
        query: {},
      },
      harness.manager
    );
    expect(result?.flow?.status).toBe("completed");
    const account = result?.account as Record<string, unknown>;
    expect(account.status).toBe("connected");
    expect(account.externalId).toBe("spotify-user");
    const metadata = account.metadata as Record<string, unknown>;
    expect(metadata.product).toBe("premium");
    // Raw tokens never land in account metadata; only vault refs do.
    expect(JSON.stringify(metadata)).not.toContain("managed-at");
    expect(JSON.stringify(metadata)).not.toContain("managed-rt");
    const refs = metadata.credentialRefs as Array<Record<string, unknown>>;
    expect(refs).toHaveLength(1);
    const vaultRef = String(refs[0]?.vaultRef);
    expect(harness.vault.get(vaultRef)).toContain("managed-at");
    expect(harness.refWrites[0]).toMatchObject({ credentialType: "oauth.tokens", vaultRef });
    // The exchange carried the PKCE verifier.
    const tokenBody = new URLSearchParams(mock.requests[0]?.body ?? "");
    expect(tokenBody.get("code_verifier")).toBe("verifier-1");
  });

  it("completeOAuth surfaces a denied callback instead of fabricating success", async () => {
    const harness = makeHarness(SETTINGS);
    const provider = createSpotifyConnectorAccountProvider(harness.runtime);
    await expect(
      provider.completeOAuth?.(
        { provider: "spotify", flow: makeFlow(), error: "access_denied", query: {} },
        harness.manager
      )
    ).rejects.toMatchObject({ code: "SPOTIFY_AUTH_REQUIRED" });
    await expect(
      provider.completeOAuth?.(
        { provider: "spotify", flow: makeFlow(), query: {} },
        harness.manager
      )
    ).rejects.toMatchObject({ code: "SPOTIFY_AUTH_REQUIRED" });
  });

  it("revoke and delete invalidate the service's cached tokens", async () => {
    const harness = makeHarness(SETTINGS);
    const provider = createSpotifyConnectorAccountProvider(harness.runtime);
    await provider.patchAccount?.("acct-1", { status: "revoked" }, harness.manager);
    await provider.deleteAccount?.("acct-2", harness.manager);
    expect(harness.invalidated).toEqual(["acct-1", "acct-2"]);
  });
});
