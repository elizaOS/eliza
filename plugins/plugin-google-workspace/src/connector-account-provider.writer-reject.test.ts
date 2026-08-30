/**
 * The #18080 store-failure contract at the real manager→provider boundary:
 * a registered durable credential store whose `putSecret()` rejects must not
 * leave the consumed OAuth flow stranded as `pending`. Drives the REAL
 * `ConnectorAccountManager` (core) and the REAL Google connector provider;
 * only the Google token-endpoint HTTP response is stubbed (a successful
 * exchange, so the failure under test is the writer, not the provider).
 * First completion surfaces the writer failure and persists a terminal
 * `failed` flow with a typed error; the same state cannot be replayed.
 */
import {
  type ConnectorAccountManager,
  ElizaError,
  getConnectorAccountManager,
  type IAgentRuntime,
  InMemoryDatabaseAdapter,
} from "@elizaos/core";
import { OAuth2Client } from "google-auth-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGoogleConnectorAccountProvider } from "./connector-account-provider.js";

const REDIRECT_URI = "http://127.0.0.1:31437/api/connectors/google/oauth/callback";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const REVOKE_ENDPOINT = "https://oauth2.googleapis.com/revoke";
const WRITER_ERROR = "PGlite vault writer lock is held by another process";

function b64url(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function makeRuntime(
  putSecret: (params: unknown) => Promise<string>,
  adapter: InMemoryDatabaseAdapter,
  remove = vi.fn(async () => undefined),
  read?: { get(key: string): Promise<string>; has(key: string): Promise<boolean> }
): IAgentRuntime {
  const messageConnectors: unknown[] = [];
  const postConnectors: unknown[] = [];
  return {
    agentId: "00000000-0000-4000-8000-00000000e19a",
    // Real durable adapter: OAuth flow state and credential-ref rows go
    // through the same storage contract the deployed SQL adapter implements.
    adapter,
    getSetting: (key: string) =>
      ({
        GOOGLE_CLIENT_ID: "writer-reject-client",
        GOOGLE_CLIENT_SECRET: "writer-reject-secret",
        GOOGLE_REDIRECT_URI: REDIRECT_URI,
      })[key],
    // The durable credential store is the ONLY registered writer: no `vault`
    // service exists to silently absorb the write, exactly the deployment
    // shape #18080 covers.
    getService: (name: string) =>
      name === "connector_credential_store" ? { putSecret, remove, ...read } : null,
    getMessageConnectors: () => messageConnectors,
    registerMessageConnector: (connector: unknown) => {
      messageConnectors.push(connector);
    },
    getPostConnectors: () => postConnectors,
    registerPostConnector: (connector: unknown) => {
      postConnectors.push(connector);
    },
  } as never;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function stubTokenExchangeSuccess(
  nonce: string,
  subject = "google-sub-writer-reject",
  tokenOverrides: Record<string, unknown> = {},
  revokeFailure?: Error
): ReturnType<typeof vi.fn> {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: "https://accounts.google.com",
    aud: "writer-reject-client",
    iat: now - 10,
    exp: now + 3600,
    sub: subject,
    email: "writer-reject@example.com",
    email_verified: true,
    nonce,
  };
  vi.spyOn(OAuth2Client.prototype, "verifyIdToken").mockResolvedValue({
    getPayload: () => payload,
  } as never);
  const fetchStub = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === REVOKE_ENDPOINT) {
      if (revokeFailure) throw revokeFailure;
      return new Response(null, { status: 200 });
    }
    if (url !== TOKEN_ENDPOINT) {
      throw new Error(`unexpected network call in writer-reject test: ${url}`);
    }
    return {
      ok: true,
      json: async () => ({
        access_token: "writer-reject-access-token",
        refresh_token: "writer-reject-refresh-token",
        token_type: "Bearer",
        expires_in: 3600,
        scope: "https://www.googleapis.com/auth/gmail.readonly",
        id_token: `${b64url({ alg: "RS256", kid: "test-key" })}.${b64url(payload)}.sig`,
        ...tokenOverrides,
      }),
    };
  });
  vi.stubGlobal("fetch", fetchStub);
  return fetchStub;
}

describe("google provider completion with a rejecting durable credential writer (#18080 / #19225)", () => {
  it("persists a terminal failed flow, surfaces the writer error typed, and keeps the state consumed", async () => {
    const putSecret = vi.fn(async () => {
      throw new Error(WRITER_ERROR);
    });
    const adapter = new InMemoryDatabaseAdapter();
    await adapter.initialize();
    const runtime = makeRuntime(putSecret, adapter);
    const manager: ConnectorAccountManager = getConnectorAccountManager(runtime);
    manager.registerProvider(createGoogleConnectorAccountProvider(runtime));
    const flow = await manager.startOAuth("google", {
      scopes: ["gmail.read"],
      metadata: { requestedRole: "OWNER" },
    });
    const fetchStub = stubTokenExchangeSuccess(
      String((flow.metadata as Record<string, unknown>).oidcNonce)
    );

    // First completion: token exchange succeeds, the durable write rejects,
    // and the callback surfaces the writer failure as a typed error.
    let thrown: unknown;
    try {
      await manager.completeOAuth("google", { state: flow.state, code: "auth-code-1" });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ElizaError);
    const typed = thrown as ElizaError;
    expect(typed.code).toBe("CONNECTOR_OAUTH_COMPLETION_FAILED");
    // The public message is generic; the raw writer failure rides the cause.
    expect(typed.message).not.toContain(WRITER_ERROR);
    expect((typed.cause as Error).message).toContain(WRITER_ERROR);
    expect(typed.context).toMatchObject({ provider: "google", flowId: flow.id });
    expect(putSecret).toHaveBeenCalledOnce();
    expect(fetchStub).toHaveBeenCalledTimes(2);
    expect(fetchStub).toHaveBeenLastCalledWith(
      REVOKE_ENDPOINT,
      expect.objectContaining({
        method: "POST",
        body: "token=writer-reject-refresh-token",
      })
    );
    await expect(manager.listAccounts("google")).resolves.toEqual([]);

    // The stored flow is terminal `failed` with a generic public message —
    // not `pending` with no error, and not the raw writer exception text.
    const stored = await manager.getOAuthFlow("google", flow.id);
    expect(stored?.status).toBe("failed");
    expect(stored?.error).not.toContain(WRITER_ERROR);
    expect(stored?.error).toMatch(/start the flow again/i);

    // The one-time state was consumed by the first attempt and cannot be
    // replayed against the already-failed flow.
    await expect(
      manager.completeOAuth("google", { state: flow.state, code: "auth-code-2" })
    ).rejects.toThrow(/already used|unknown|expired/i);
  });

  it("revokes the combined grant and makes the prior account unavailable after a reauthorization writer failure", async () => {
    const priorVaultRef = "connector.prior.google.account.oauth_tokens";
    const vault = new Map([
      [
        priorVaultRef,
        JSON.stringify({ access_token: "prior-access", refresh_token: "prior-refresh" }),
      ],
    ]);
    const putSecret = vi.fn(async () => {
      throw new Error(WRITER_ERROR);
    });
    const remove = vi.fn(async (vaultRef: string) => {
      vault.delete(vaultRef);
    });
    const adapter = new InMemoryDatabaseAdapter();
    await adapter.initialize();
    const runtime = makeRuntime(putSecret, adapter, remove, {
      get: async (key) => {
        const value = vault.get(key);
        if (!value) throw new Error(`missing ${key}`);
        return value;
      },
      has: async (key) => vault.has(key),
    });
    const manager: ConnectorAccountManager = getConnectorAccountManager(runtime);
    manager.registerProvider(createGoogleConnectorAccountProvider(runtime));
    const account = await manager.upsertAccount(
      "google",
      {
        provider: "google",
        role: "OWNER",
        purpose: ["messaging"],
        accessGate: "owner_binding",
        status: "connected",
        externalId: "google-sub-writer-reject",
        label: "Existing Google",
        metadata: {
          marker: "must-survive",
          credentialRefs: [{ credentialType: "oauth.tokens", vaultRef: priorVaultRef }],
        },
      },
      "acct_google_existing"
    );
    await adapter.setConnectorAccountCredentialRef({
      accountId: account.id as never,
      credentialType: "oauth.tokens",
      vaultRef: priorVaultRef,
    });
    const flow = await manager.startOAuth("google", {
      accountId: account.id,
      scopes: ["gmail.read"],
    });
    const fetchStub = stubTokenExchangeSuccess(
      String((flow.metadata as Record<string, unknown>).oidcNonce)
    );

    await expect(
      manager.completeOAuth("google", { state: flow.state, code: "reauth-writer-failure" })
    ).rejects.toMatchObject({ code: "CONNECTOR_OAUTH_COMPLETION_FAILED" });

    expect(fetchStub).toHaveBeenCalledTimes(2);
    expect(fetchStub).toHaveBeenLastCalledWith(
      REVOKE_ENDPOINT,
      expect.objectContaining({ body: "token=writer-reject-refresh-token" })
    );
    await expect(manager.getAccount("google", account.id)).resolves.toMatchObject({
      status: "error",
      metadata: {
        marker: "must-survive",
        oauthUnavailableReason: "reauthorization_compensation_revoked_combined_grant",
      },
    });
    expect(vault.has(priorVaultRef)).toBe(false);
    expect(remove).toHaveBeenCalledWith(priorVaultRef);
    await expect(
      adapter.listConnectorAccountCredentialRefs({ accountId: account.id as never })
    ).resolves.toEqual([]);
  });

  it("revokes the combined grant and marks the prior account unavailable after identity validation fails", async () => {
    const putSecret = vi.fn(async () => "should-not-write");
    const adapter = new InMemoryDatabaseAdapter();
    await adapter.initialize();
    const runtime = makeRuntime(putSecret, adapter);
    const manager: ConnectorAccountManager = getConnectorAccountManager(runtime);
    manager.registerProvider(createGoogleConnectorAccountProvider(runtime));
    const account = await manager.upsertAccount(
      "google",
      {
        provider: "google",
        role: "OWNER",
        purpose: ["messaging"],
        accessGate: "owner_binding",
        status: "connected",
        externalId: "original-google-subject",
        label: "Existing Google",
        metadata: { marker: "identity-validation" },
      },
      "acct_google_identity_validation"
    );
    const flow = await manager.startOAuth("google", {
      accountId: account.id,
      scopes: ["gmail.read"],
    });
    const fetchStub = stubTokenExchangeSuccess(
      String((flow.metadata as Record<string, unknown>).oidcNonce),
      "different-google-subject"
    );

    await expect(
      manager.completeOAuth("google", { state: flow.state, code: "identity-mismatch" })
    ).rejects.toMatchObject({ code: "CONNECTOR_OAUTH_COMPLETION_FAILED" });

    expect(putSecret).not.toHaveBeenCalled();
    expect(fetchStub).toHaveBeenCalledTimes(2);
    await expect(manager.getAccount("google", account.id)).resolves.toMatchObject({
      status: "error",
      metadata: {
        marker: "identity-validation",
        oauthUnavailableReason: "reauthorization_compensation_revoked_combined_grant",
      },
    });
  });

  it("revokes the grant and creates no account when a new-account ID-token validation fails", async () => {
    const putSecret = vi.fn(async () => "should-not-write");
    const adapter = new InMemoryDatabaseAdapter();
    await adapter.initialize();
    const runtime = makeRuntime(putSecret, adapter);
    const manager: ConnectorAccountManager = getConnectorAccountManager(runtime);
    manager.registerProvider(createGoogleConnectorAccountProvider(runtime));
    const flow = await manager.startOAuth("google", {
      scopes: ["gmail.read"],
      metadata: { requestedRole: "OWNER" },
    });
    const fetchStub = stubTokenExchangeSuccess(
      String((flow.metadata as Record<string, unknown>).oidcNonce),
      "new-account-invalid-id-token",
      { id_token: "" }
    );

    await expect(
      manager.completeOAuth("google", { state: flow.state, code: "missing-id-token" })
    ).rejects.toMatchObject({ code: "CONNECTOR_OAUTH_COMPLETION_FAILED" });

    expect(putSecret).not.toHaveBeenCalled();
    expect(fetchStub).toHaveBeenCalledTimes(2);
    expect(fetchStub).toHaveBeenLastCalledWith(
      REVOKE_ENDPOINT,
      expect.objectContaining({ body: "token=writer-reject-refresh-token" })
    );
    await expect(manager.listAccounts("google")).resolves.toEqual([]);
  });

  it("removes a newly written secret, revokes the grant, and removes the provisional account when the ref writer rejects", async () => {
    const vault = new Map<string, string>();
    const putSecret = vi.fn(async (params: unknown) => {
      const input = params as { vaultRef: string; value: string };
      vault.set(input.vaultRef, input.value);
      return input.vaultRef;
    });
    const remove = vi.fn(async (vaultRef: string) => {
      vault.delete(vaultRef);
    });
    const adapter = new InMemoryDatabaseAdapter();
    await adapter.initialize();
    vi.spyOn(adapter, "setConnectorAccountCredentialRef").mockRejectedValue(
      new Error("credential ref table is read-only")
    );
    const runtime = makeRuntime(putSecret, adapter, remove, {
      get: async (key) => {
        const value = vault.get(key);
        if (!value) throw new Error(`missing ${key}`);
        return value;
      },
      has: async (key) => vault.has(key),
    });
    const manager: ConnectorAccountManager = getConnectorAccountManager(runtime);
    manager.registerProvider(createGoogleConnectorAccountProvider(runtime));
    const flow = await manager.startOAuth("google", {
      scopes: ["gmail.read"],
      metadata: { requestedRole: "OWNER" },
    });
    const fetchStub = stubTokenExchangeSuccess(
      String((flow.metadata as Record<string, unknown>).oidcNonce),
      "new-account-ref-writer-failure"
    );

    await expect(
      manager.completeOAuth("google", { state: flow.state, code: "ref-writer-failure" })
    ).rejects.toMatchObject({ code: "CONNECTOR_OAUTH_COMPLETION_FAILED" });

    expect(putSecret).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledOnce();
    expect(vault.size).toBe(0);
    expect(fetchStub).toHaveBeenCalledTimes(2);
    await expect(manager.listAccounts("google")).resolves.toEqual([]);
  });

  it("revokes and removes the grant when the manager's final connected-account write rejects", async () => {
    const vault = new Map<string, string>();
    const putSecret = vi.fn(async (params: unknown) => {
      const input = params as { vaultRef: string; value: string };
      vault.set(input.vaultRef, input.value);
      return input.vaultRef;
    });
    const remove = vi.fn(async (key: string) => void vault.delete(key));
    const adapter = new InMemoryDatabaseAdapter();
    await adapter.initialize();
    const runtime = makeRuntime(putSecret, adapter, remove, {
      get: async (key) => vault.get(key) ?? "",
      has: async (key) => vault.has(key),
    });
    const manager: ConnectorAccountManager = getConnectorAccountManager(runtime);
    manager.registerProvider(createGoogleConnectorAccountProvider(runtime));
    const flow = await manager.startOAuth("google", {
      scopes: ["gmail.read"],
      metadata: { requestedRole: "OWNER" },
    });
    const originalUpsert = manager.upsertAccount.bind(manager);
    vi.spyOn(manager, "upsertAccount")
      .mockImplementationOnce(originalUpsert)
      .mockRejectedValueOnce(new Error("authoritative connected write rejected"));
    const fetchStub = stubTokenExchangeSuccess(
      String((flow.metadata as Record<string, unknown>).oidcNonce),
      "final-writer-subject"
    );

    await expect(
      manager.completeOAuth("google", { state: flow.state, code: "final-writer-failure" })
    ).rejects.toMatchObject({ code: "CONNECTOR_OAUTH_ACCOUNT_PERSISTENCE_FAILED" });

    expect(fetchStub).toHaveBeenCalledTimes(2);
    expect(vault.size).toBe(0);
    await expect(manager.listAccounts("google")).resolves.toEqual([]);
    await expect(manager.getOAuthFlow("google", flow.id)).resolves.toMatchObject({
      status: "failed",
    });
  });

  it("marks the prior account unavailable when Google processes revoke but the response is lost", async () => {
    const adapter = new InMemoryDatabaseAdapter();
    await adapter.initialize();
    const runtime = makeRuntime(async () => {
      throw new Error(WRITER_ERROR);
    }, adapter);
    const manager: ConnectorAccountManager = getConnectorAccountManager(runtime);
    manager.registerProvider(createGoogleConnectorAccountProvider(runtime));
    const account = await manager.upsertAccount(
      "google",
      {
        provider: "google",
        role: "OWNER",
        purpose: ["messaging"],
        accessGate: "open",
        status: "connected",
        externalId: "google-sub-writer-reject",
      },
      "acct_response_lost"
    );
    const flow = await manager.startOAuth("google", {
      accountId: account.id,
      scopes: ["gmail.read"],
    });
    stubTokenExchangeSuccess(
      String((flow.metadata as Record<string, unknown>).oidcNonce),
      "google-sub-writer-reject",
      {},
      new Error("response lost after provider processed revoke")
    );

    await expect(
      manager.completeOAuth("google", { state: flow.state, code: "response-lost" })
    ).rejects.toMatchObject({ code: "CONNECTOR_OAUTH_COMPLETION_FAILED" });
    await expect(manager.getAccount("google", account.id)).resolves.toMatchObject({
      status: "error",
      metadata: {
        oauthUnavailableReason: "reauthorization_compensation_revoked_combined_grant",
      },
    });
  });
});
