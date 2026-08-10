/**
 * Deterministic coverage for separating Google OAuth's cumulative grant from
 * the narrower personal Workspace products selected for the current agent.
 */

import {
  ConnectorAccountManager,
  type IAgentRuntime,
  InMemoryDatabaseAdapter,
} from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createGoogleConnectorAccountProvider,
  revokeGoogleOAuthToken,
  selectRequestedGrantedCapabilities,
} from "./connector-account-provider.js";

function oauthRuntime(clientId = "google-client-id"): IAgentRuntime {
  const vault = new Map([
    ["GOOGLE_CLIENT_ID", clientId],
    ["GOOGLE_CLIENT_SECRET", `${clientId}-secret`],
  ]);
  return {
    getSetting: () => undefined,
    getService: (name: string) =>
      name === "SECRETS" ? { getGlobal: async (key: string) => vault.get(key) ?? null } : null,
  } as unknown as IAgentRuntime;
}

function managedDesktopOAuthRuntime(): IAgentRuntime & {
  tokenVault: Map<string, string>;
} {
  const tokenVault = new Map<string, string>();
  return {
    agentId: "00000000-0000-0000-0000-000000000001",
    getSetting: (key: string) =>
      key === "ELIZA_GOOGLE_OAUTH_DESKTOP_CLIENT_ID" ? "eliza-desktop-client-id" : undefined,
    getService: (name: string) =>
      name === "connector_credential_store"
        ? {
            putSecret: async (input: { vaultRef?: string; value: string }) => {
              const vaultRef = input.vaultRef ?? "missing-ref";
              tokenVault.set(vaultRef, input.value);
              return vaultRef;
            },
            reveal: async (vaultRef: string) => tokenVault.get(vaultRef) ?? null,
            remove: async (vaultRef: string) => {
              tokenVault.delete(vaultRef);
            },
          }
        : null,
    tokenVault,
  } as unknown as IAgentRuntime & { tokenVault: Map<string, string> };
}

function pendingFlow() {
  return {
    id: "google-oauth-flow",
    provider: "google",
    state: "google-oauth-state",
    status: "pending" as const,
    createdAt: 1,
    updatedAt: 1,
  };
}

describe("Google connector OAuth selection", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("does not re-enable products that remain in Google's incremental grant", () => {
    expect(
      selectRequestedGrantedCapabilities(
        ["gmail.read", "gmail.draft"],
        ["gmail.read", "gmail.draft", "calendar.read", "drive.read"]
      )
    ).toEqual(["gmail.read", "gmail.draft"]);
  });

  it.each([
    "https://www.googleapis.com/auth/calendar.events",
    "https://www.googleapis.com/auth/calendar",
  ])(
    "accepts the legacy %s grant as calendar.read but requests only readonly",
    async (legacyScope) => {
      const provider = createGoogleConnectorAccountProvider(oauthRuntime());
      const started = await provider.startOAuth?.(
        {
          provider: "google",
          flow: pendingFlow(),
          redirectUri: "https://example.test/oauth/google/callback",
          scopes: [legacyScope],
        },
        {} as ConnectorAccountManager
      );
      const url = new URL(started?.authUrl ?? "");
      const requestedScopes = new Set(
        (url.searchParams.get("scope") ?? "").split(" ").filter(Boolean)
      );

      expect(started?.metadata).toMatchObject({
        requestedCapabilities: ["calendar.read"],
      });
      expect(requestedScopes).toContain("https://www.googleapis.com/auth/calendar.readonly");
      expect(requestedScopes).not.toContain(legacyScope);
    }
  );

  it("starts OAuth from vault credentials and the request-derived callback", async () => {
    const provider = createGoogleConnectorAccountProvider(oauthRuntime("vault-google-client-id"));
    const started = await provider.startOAuth?.(
      {
        provider: "google",
        flow: pendingFlow(),
        redirectUri: "http://localhost:31337/api/connectors/google/oauth/callback",
        scopes: ["calendar.read"],
      },
      {} as ConnectorAccountManager
    );
    const url = new URL(started?.authUrl ?? "");

    expect(url.searchParams.get("client_id")).toBe("vault-google-client-id");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "http://localhost:31337/api/connectors/google/oauth/callback"
    );
  });

  it("starts managed desktop OAuth with PKCE and no user-vault registration", async () => {
    const provider = createGoogleConnectorAccountProvider(managedDesktopOAuthRuntime());
    const started = await provider.startOAuth?.(
      {
        provider: "google",
        flow: pendingFlow(),
        redirectUri: "http://localhost:31337/api/connectors/google/oauth/callback",
        scopes: ["calendar.read"],
      },
      {} as ConnectorAccountManager
    );
    const url = new URL(started?.authUrl ?? "");

    expect(url.searchParams.get("client_id")).toBe("eliza-desktop-client-id");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(started?.codeVerifier).toMatch(/^[A-Za-z0-9_-]{86}$/);
  });

  it("reads the managed desktop registration from the product environment", async () => {
    vi.stubEnv("ELIZA_GOOGLE_OAUTH_DESKTOP_CLIENT_ID", "release-client-id");
    const provider = createGoogleConnectorAccountProvider({
      getSetting: () => null,
      getService: () => null,
    } as unknown as IAgentRuntime);

    const started = await provider.startOAuth?.(
      {
        provider: "google",
        flow: pendingFlow(),
        redirectUri: "http://127.0.0.1:31337/api/connectors/google/oauth/callback",
        scopes: ["calendar.read"],
      },
      {} as ConnectorAccountManager
    );

    expect(new URL(started?.authUrl ?? "").searchParams.get("client_id")).toBe("release-client-id");
  });

  it("exchanges a managed desktop authorization code without a client secret", async () => {
    const identityPayload = Buffer.from(
      JSON.stringify({ sub: "google-user-1", email: "person@example.test" })
    ).toString("base64url");
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      if (String(input) !== "https://oauth2.googleapis.com/token") {
        throw new Error(`Unexpected request: ${String(input)}`);
      }
      return Response.json({
        access_token: "access-token",
        refresh_token: "refresh-token",
        expires_in: 3600,
        token_type: "Bearer",
        scope: "https://www.googleapis.com/auth/calendar.readonly",
        id_token: `header.${identityPayload}.signature`,
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const provider = createGoogleConnectorAccountProvider(managedDesktopOAuthRuntime());
    const refWrites: unknown[] = [];
    const manager = {
      getStorage: () => ({
        setConnectorAccountCredentialRef: async (input: unknown) => {
          refWrites.push(input);
        },
      }),
      upsertAccount: async (_provider: string, input: Record<string, unknown>) => ({
        ...input,
        id: "google-account-1",
        createdAt: 1,
        updatedAt: 1,
      }),
      createAccount: async (_provider: string, input: Record<string, unknown>) => ({
        ...input,
        id: "google-account-1",
        createdAt: 1,
        updatedAt: 1,
      }),
      listAccounts: async () => [],
    } as unknown as ConnectorAccountManager;

    const result = await provider.completeOAuth?.(
      {
        provider: "google",
        code: "authorization-code",
        flow: {
          ...pendingFlow(),
          codeVerifier: "pkce-verifier",
          redirectUri: "http://localhost:31337/api/connectors/google/oauth/callback",
          metadata: {
            requestedCapabilities: ["calendar.read"],
          },
        },
      },
      manager
    );

    const request = fetchMock.mock.calls[0];
    const body = new URLSearchParams(String(request?.[1]?.body));
    expect(body.get("client_id")).toBe("eliza-desktop-client-id");
    expect(body.get("client_secret")).toBeNull();
    expect(body.get("code_verifier")).toBe("pkce-verifier");
    expect(result?.account).toMatchObject({
      id: "google-account-1",
      status: "connected",
      externalId: "google-user-1",
    });
    expect(refWrites).toHaveLength(1);
  });

  it("completes a first Google OAuth connection through the real account manager", async () => {
    const identityPayload = Buffer.from(
      JSON.stringify({ sub: "google-user-1", email: "person@example.test" })
    ).toString("base64url");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input) !== "https://oauth2.googleapis.com/token") {
          throw new Error(`Unexpected request: ${String(input)}`);
        }
        const code = new URLSearchParams(String(init?.body)).get("code");
        const secondGrant = code === "second-authorization-code";
        return Response.json({
          access_token: "access-token",
          ...(secondGrant ? {} : { refresh_token: "refresh-token" }),
          expires_in: 3600,
          token_type: "Bearer",
          scope: secondGrant
            ? [
                "https://www.googleapis.com/auth/calendar.readonly",
                "https://www.googleapis.com/auth/gmail.readonly",
                "https://www.googleapis.com/auth/gmail.compose",
                "https://www.googleapis.com/auth/gmail.modify",
              ].join(" ")
            : "https://www.googleapis.com/auth/calendar.readonly",
          id_token: `header.${identityPayload}.signature`,
        });
      })
    );
    const adapter = new InMemoryDatabaseAdapter();
    await adapter.initialize();
    const runtime = managedDesktopOAuthRuntime() as IAgentRuntime & {
      adapter: InMemoryDatabaseAdapter;
    };
    runtime.adapter = adapter;
    const manager = new ConnectorAccountManager(runtime);
    manager.registerProvider(createGoogleConnectorAccountProvider(runtime));
    const flow = await manager.startOAuth("google", {
      redirectUri: "http://localhost:31337/api/connectors/google/oauth/callback",
      scopes: ["calendar.read"],
    });

    const result = await manager.completeOAuth("google", {
      state: flow.state,
      code: "authorization-code",
    });

    expect(result.account).toMatchObject({
      provider: "google",
      status: "connected",
      externalId: "google-user-1",
    });
    expect(result.account?.id).toEqual(expect.any(String));
    expect(result.redirectUrl).toBe("/settings#connectors/google");

    const secondFlow = await manager.startOAuth("google", {
      redirectUri: "http://localhost:31337/api/connectors/google/oauth/callback",
      scopes: ["gmail.read", "gmail.draft", "gmail.manage"],
    });
    const secondResult = await manager.completeOAuth("google", {
      state: secondFlow.state,
      code: "second-authorization-code",
    });

    expect(secondResult.account?.id).toBe(result.account?.id);
    expect(secondResult.account?.selectedProducts).toEqual(["calendar", "gmail"]);
    await expect(manager.listAccounts("google")).resolves.toHaveLength(1);
    const storedTokens = [...runtime.tokenVault.values()].map(
      (value) => JSON.parse(value) as { refresh_token?: string }
    );
    expect(storedTokens).toHaveLength(1);
    expect(storedTokens[0]?.refresh_token).toBe("refresh-token");
  });

  it("revokes with a form-encoded token and never places it in the URL", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await revokeGoogleOAuthToken("refresh-token-secret");

    expect(fetchMock).toHaveBeenCalledWith(
      "https://oauth2.googleapis.com/revoke",
      expect.objectContaining({
        method: "POST",
        body: "token=refresh-token-secret",
      })
    );
    expect(String(fetchMock.mock.calls[0]?.[0])).not.toContain("refresh-token-secret");
  });
});
