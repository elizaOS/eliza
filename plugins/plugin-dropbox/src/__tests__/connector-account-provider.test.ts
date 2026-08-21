/**
 * Dropbox connector-account-provider contract tests. Uses a real in-memory
 * ConnectorAccountManager-shaped fake plus protocol-faithful fake token and
 * identity endpoints via injected fetch. Covers PKCE offline OAuth start,
 * scope normalization (read default + write escalation, unrecognized and
 * empty-scope failures), callback success with durable credential-ref
 * persistence, failed exchange, and invalid payloads.
 */
import type {
  ConnectorAccount,
  ConnectorAccountManager,
  ConnectorOAuthCallbackRequest,
  ConnectorOAuthStartRequest,
  IAgentRuntime,
} from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  createDropboxConnectorAccountProvider,
  DROPBOX_READ_SCOPES,
  DROPBOX_WRITE_SCOPES,
} from "../connector-account-provider.js";

function fakeRuntime(settings: Record<string, string>) {
  const vaultStore = new Map<string, string>();
  const runtime = {
    agentId: "agent-1",
    getSetting: (key: string) => settings[key],
    getService: (type: string) =>
      type === "vault"
        ? {
            set: async (key: string, value: string) => {
              vaultStore.set(key, value);
            },
          }
        : null,
  } as unknown as IAgentRuntime;
  return { runtime, vaultStore };
}

function fakeManager() {
  const accounts = new Map<string, ConnectorAccount>();
  const credentialRefs: Array<Record<string, unknown>> = [];
  const storage = {
    listAccounts: async (provider: string) =>
      [...accounts.values()].filter((account) => account.provider === provider),
    getAccount: async (_provider: string, id: string) => accounts.get(id) ?? null,
    upsertAccount: async (account: ConnectorAccount) => {
      accounts.set(account.id, account);
      return account;
    },
    deleteAccount: async (_provider: string, id: string) => {
      accounts.delete(id);
    },
    setConnectorAccountCredentialRef: async (params: Record<string, unknown>) => {
      credentialRefs.push(params);
    },
  };
  const manager = {
    getStorage: () => storage,
    getAccount: async (provider: string, id: string) => storage.getAccount(provider, id),
    listAccounts: async (provider: string) => storage.listAccounts(provider),
    upsertAccount: async (
      provider: string,
      patch: Record<string, unknown>,
      accountId?: string
    ): Promise<ConnectorAccount> => {
      const id = accountId ?? `acct-${accounts.size + 1}`;
      const account = { ...(accounts.get(id) ?? {}), ...patch, id, provider } as ConnectorAccount;
      accounts.set(id, account);
      return account;
    },
  } as unknown as ConnectorAccountManager;
  return { manager, accounts, credentialRefs };
}

const SETTINGS = {
  DROPBOX_CLIENT_ID: "app-key",
  DROPBOX_CLIENT_SECRET: "app-secret",
  DROPBOX_REDIRECT_URI: "https://agent.example/oauth/dropbox/callback",
};

function startRequest(scopes?: string[]): ConnectorOAuthStartRequest {
  return {
    scopes,
    flow: { state: "state-xyz" },
    metadata: {},
  } as unknown as ConnectorOAuthStartRequest;
}

function callbackRequest(code: string | undefined): ConnectorOAuthCallbackRequest {
  return {
    code,
    flow: {
      state: "state-xyz",
      redirectUri: SETTINGS.DROPBOX_REDIRECT_URI,
      codeVerifier: "verifier-1",
      metadata: { redirectUri: SETTINGS.DROPBOX_REDIRECT_URI },
    },
  } as unknown as ConnectorOAuthCallbackRequest;
}

describe("Dropbox OAuth start", () => {
  it("builds a PKCE offline authorization URL with the default read+write scopes", async () => {
    const { runtime } = fakeRuntime(SETTINGS);
    const provider = createDropboxConnectorAccountProvider(runtime);
    const { manager } = fakeManager();
    const result = await provider.startOAuth?.(startRequest(), manager);
    const url = new URL(result?.authUrl ?? "");
    expect(url.origin + url.pathname).toBe("https://www.dropbox.com/oauth2/authorize");
    expect(url.searchParams.get("token_access_type")).toBe("offline");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBeTruthy();
    expect(result?.codeVerifier).toBeTruthy();
    const scope = url.searchParams.get("scope")?.split(" ") ?? [];
    for (const expected of [...DROPBOX_READ_SCOPES, ...DROPBOX_WRITE_SCOPES]) {
      expect(scope).toContain(expected);
    }
  });

  it("narrows to a read-only grant when only read scopes are requested", async () => {
    const { runtime } = fakeRuntime(SETTINGS);
    const provider = createDropboxConnectorAccountProvider(runtime);
    const { manager } = fakeManager();
    const result = await provider.startOAuth?.(
      startRequest(["files.metadata.read", "files.content.read"]),
      manager
    );
    const scope = new URL(result?.authUrl ?? "").searchParams.get("scope")?.split(" ") ?? [];
    expect(scope).toContain("files.metadata.read");
    expect(scope).toContain("account_info.read");
    expect(scope).not.toContain("files.content.write");
  });

  it("fails closed on unrecognized or empty scope selections", async () => {
    const { runtime } = fakeRuntime(SETTINGS);
    const provider = createDropboxConnectorAccountProvider(runtime);
    const { manager } = fakeManager();
    await expect(provider.startOAuth?.(startRequest(["sharing.write"]), manager)).rejects.toThrow(
      /not recognized/
    );
    await expect(provider.startOAuth?.(startRequest([]), manager)).rejects.toThrow(
      /at least one recognized scope/
    );
  });

  it("fails closed when client settings are missing", async () => {
    const { runtime } = fakeRuntime({});
    const provider = createDropboxConnectorAccountProvider(runtime);
    const { manager } = fakeManager();
    await expect(provider.startOAuth?.(startRequest(), manager)).rejects.toThrow(
      /DROPBOX_CLIENT_ID/
    );
  });
});

describe("Dropbox OAuth callback", () => {
  it("exchanges the code with the verifier, records identity and scopes, and persists a durable token set", async () => {
    const { runtime, vaultStore } = fakeRuntime(SETTINGS);
    const requests: Array<{ url: string; body: string }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      requests.push({ url, body: String(init?.body ?? "") });
      if (url.endsWith("/oauth2/token")) {
        return new Response(
          JSON.stringify({
            access_token: "sl.short_lived",
            expires_in: 14_400,
            token_type: "bearer",
            refresh_token: "rt-durable",
            scope: "account_info.read files.metadata.read files.content.read",
            account_id: "dbid:abc",
            uid: "12345",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response(
        JSON.stringify({
          account_id: "dbid:abc",
          email: "ada@acme.test",
          name: { display_name: "Ada Lovelace" },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    };
    const provider = createDropboxConnectorAccountProvider(runtime, { fetchImpl });
    const { manager, credentialRefs } = fakeManager();

    const result = await provider.completeOAuth?.(callbackRequest("auth-code"), manager);

    const tokenBody = new URLSearchParams(requests[0].body);
    expect(tokenBody.get("grant_type")).toBe("authorization_code");
    expect(tokenBody.get("code_verifier")).toBe("verifier-1");
    expect(tokenBody.get("client_id")).toBe("app-key");

    expect(result?.account.status).toBe("connected");
    expect(result?.account.externalId).toBe("dbid:abc");
    expect(result?.account.label).toBe("Ada Lovelace");
    const metadata = result?.account.metadata as Record<string, unknown>;
    expect(metadata.grantedScopes).toEqual([
      "account_info.read",
      "files.metadata.read",
      "files.content.read",
    ]);
    expect(metadata.hasRefreshToken).toBe(true);
    // Tokens never land in account metadata — only durable refs.
    expect(JSON.stringify(metadata)).not.toContain("sl.short_lived");
    expect(JSON.stringify(metadata)).not.toContain("rt-durable");
    expect(credentialRefs).toHaveLength(1);
    const persisted = [...vaultStore.values()][0];
    expect(persisted).toContain("sl.short_lived");
    expect(persisted).toContain("rt-durable");
  });

  it("rejects a callback without an authorization code", async () => {
    const { runtime } = fakeRuntime(SETTINGS);
    const provider = createDropboxConnectorAccountProvider(runtime);
    const { manager } = fakeManager();
    await expect(provider.completeOAuth?.(callbackRequest(undefined), manager)).rejects.toThrow(
      /authorization code/
    );
  });

  it("surfaces a failed exchange and an invalid token payload", async () => {
    const { runtime } = fakeRuntime(SETTINGS);
    const failing = createDropboxConnectorAccountProvider(runtime, {
      fetchImpl: async () =>
        new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }),
    });
    const { manager, accounts } = fakeManager();
    await expect(failing.completeOAuth?.(callbackRequest("bad"), manager)).rejects.toThrow(
      /token exchange failed with 400/
    );
    expect(accounts.size).toBe(0);

    const invalid = createDropboxConnectorAccountProvider(runtime, {
      fetchImpl: async () =>
        new Response(JSON.stringify({ token_type: "bearer" }), { status: 200 }),
    });
    await expect(invalid.completeOAuth?.(callbackRequest("code"), manager)).rejects.toThrow(
      /invalid payload/
    );
  });
});
