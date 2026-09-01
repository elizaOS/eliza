/**
 * Verifies Google OAuth completion assigns a stable account identity and
 * refuses to rebind an existing connector account to another Google subject.
 * Token exchange and credential persistence are deterministic local doubles.
 */

import type {
  ConnectorAccount,
  ConnectorAccountManager,
  ConnectorAccountPatch,
} from "@elizaos/core";
import { OAuth2Client } from "google-auth-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createGoogleConnectorAccountProvider,
  stableGoogleConnectorAccountId,
} from "./connector-account-provider.js";
import { GOOGLE_OAUTH_SCOPES } from "./scopes.js";

function signedJwtShape(payload: Record<string, unknown>): string {
  return `${Buffer.from(JSON.stringify({ alg: "RS256", kid: "test-key" })).toString("base64url")}.${Buffer.from(
    JSON.stringify(payload)
  ).toString("base64url")}.signature`;
}

function verifiedClaims(identity: Record<string, unknown>): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: "https://accounts.google.com",
    aud: "client-id",
    iat: now - 10,
    exp: now + 3600,
    ...identity,
  };
}

function stubIdTokenVerification(payload: Record<string, unknown>) {
  vi.spyOn(OAuth2Client.prototype, "verifyIdToken").mockResolvedValue({
    getPayload: () => payload,
  } as never);
}

function createRuntimeHarness(options?: {
  credentialRefs?: Array<Record<string, unknown>>;
  failVaultSet?: boolean;
  vaultEntries?: Record<string, string>;
}) {
  const vault = new Map<string, string>();
  for (const [key, value] of Object.entries(options?.vaultEntries ?? {})) {
    vault.set(key, value);
  }
  const adapter = {
    listConnectorAccountCredentialRefs: vi.fn(async () => options?.credentialRefs ?? []),
    deleteConnectorAccountCredentialRefs: vi.fn(async () => options?.credentialRefs?.length ?? 0),
    setConnectorAccountCredentialRef: vi.fn(async () => undefined),
  };
  const vaultService = {
    set: vi.fn(async (key: string, value: string) => {
      if (options?.failVaultSet) throw new Error("vault write rejected");
      vault.set(key, value);
    }),
    get: vi.fn(async (key: string) => vault.get(key) ?? null),
    has: vi.fn(async (key: string) => vault.has(key)),
    remove: vi.fn(async (key: string) => {
      vault.delete(key);
    }),
  };
  const value = {
    agentId: "agent-1",
    adapter,
    getSetting: (key: string) =>
      ({
        GOOGLE_CLIENT_ID: "client-id",
        GOOGLE_CLIENT_SECRET: "client-secret",
        GOOGLE_REDIRECT_URI: "http://127.0.0.1:31437/api/connectors/google/oauth/callback",
      })[key],
    getService: (serviceType: string) => (serviceType === "vault" ? vaultService : null),
  } as never;
  return { value, adapter, vault, vaultService };
}

function runtime() {
  return createRuntimeHarness().value;
}

function manager(existing: ConnectorAccount | null = null) {
  const setConnectorAccountCredentialRef = vi.fn(async () => undefined);
  const restoreAccount = vi.fn(async (account: ConnectorAccount) => account);
  const deleteAccount = vi.fn(async () => true);
  const getAccount = vi.fn(async () => existing);
  const listAccounts = vi.fn(async () => (existing ? [existing] : []));
  const upsertAccount = vi.fn(
    async (
      provider: string,
      input: ConnectorAccountPatch & Partial<ConnectorAccount>,
      accountId?: string
    ): Promise<ConnectorAccount> => {
      if (!accountId) throw new Error("Connector account requires an id");
      return {
        id: accountId,
        provider,
        accountKey: input.accountKey,
        role: input.role ?? "OWNER",
        purpose: Array.isArray(input.purpose)
          ? input.purpose
          : input.purpose
            ? [input.purpose]
            : [],
        accessGate: input.accessGate ?? "open",
        status: input.status ?? "pending",
        externalId: input.externalId ?? undefined,
        createdAt: input.createdAt ?? Date.now(),
        updatedAt: Date.now(),
        metadata: input.metadata,
      };
    }
  );
  return {
    value: {
      getAccount,
      listAccounts,
      upsertAccount,
      getStorage: () => ({
        setConnectorAccountCredentialRef,
        upsertAccount: restoreAccount,
        deleteAccount,
      }),
    } as unknown as ConnectorAccountManager,
    getAccount,
    listAccounts,
    restoreAccount,
    deleteAccount,
    upsertAccount,
  };
}

function stubToken(subject: string, nonce: string) {
  const identity = verifiedClaims({
    sub: subject,
    email: `${subject}@example.com`,
    nonce,
  });
  stubIdTokenVerification(identity);
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: "access-token",
            refresh_token: "refresh-token",
            expires_in: 3600,
            scope: GOOGLE_OAUTH_SCOPES.gmail.read,
            id_token: signedJwtShape(identity),
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(identity), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      )
  );
}

function stubTokenAndUserInfo(
  tokenIdentity: Record<string, unknown>,
  userInfo: Record<string, unknown>
) {
  const verifiedIdentity = verifiedClaims(tokenIdentity);
  stubIdTokenVerification(verifiedIdentity);
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: "access-token",
            refresh_token: "refresh-token",
            expires_in: 3600,
            scope: GOOGLE_OAUTH_SCOPES.gmail.read,
            id_token: signedJwtShape(verifiedIdentity),
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(userInfo), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      )
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
  );
}

function callback(accountId?: string, requestedRole: string | undefined = "OWNER") {
  return {
    provider: "google",
    code: "authorization-code",
    query: {},
    flow: {
      id: "flow-id",
      provider: "google",
      state: "state",
      status: "pending" as const,
      accountId,
      codeVerifier: "verifier",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      metadata: {
        ...(requestedRole ? { requestedRole } : {}),
        requestedCapabilities: ["gmail.read"],
        requestedScopes: [GOOGLE_OAUTH_SCOPES.gmail.read],
        oidcNonce: "expected-nonce",
      },
    },
  };
}

describe("Google OAuth connector-account identity binding", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("completes a new-account callback with a stable provider-subject id", async () => {
    stubToken("subject-1", "expected-nonce");
    const provider = createGoogleConnectorAccountProvider(runtime());
    const harness = manager();

    const result = await provider.completeOAuth?.(callback(), harness.value);

    const expected = stableGoogleConnectorAccountId("subject-1", "OWNER");
    expect(result?.account?.id).toBe(expected);
    expect(result?.account?.accountKey).toBe(expected);
    expect(harness.upsertAccount).toHaveBeenCalledWith(
      "google",
      expect.objectContaining({ accountKey: expected, externalId: "subject-1" }),
      expected
    );
  });

  it("fetches userinfo when the ID token has email but no stable subject", async () => {
    stubTokenAndUserInfo(
      { email: "ada@example.com", nonce: "expected-nonce" },
      { sub: "userinfo-subject", email: "ada@example.com" }
    );
    const provider = createGoogleConnectorAccountProvider(runtime());
    const harness = manager();

    const result = await provider.completeOAuth?.(callback(), harness.value);

    expect(result?.account?.id).toBe(stableGoogleConnectorAccountId("userinfo-subject", "OWNER"));
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  it("rejects an identity that has email but no stable subject anywhere", async () => {
    stubTokenAndUserInfo(
      { email: "ada@example.com", nonce: "expected-nonce" },
      { email: "ada@example.com" }
    );
    const provider = createGoogleConnectorAccountProvider(runtime());
    const harness = manager();

    await expect(provider.completeOAuth?.(callback(), harness.value)).rejects.toMatchObject({
      code: "GOOGLE_OAUTH_IDENTITY_SUBJECT_MISSING",
    });
    expect(harness.upsertAccount).not.toHaveBeenCalled();
  });

  it("rejects choosing a different Google subject during reauthorization", async () => {
    stubToken("different-subject", "expected-nonce");
    const provider = createGoogleConnectorAccountProvider(runtime());
    const harness = manager({
      id: "existing-account",
      provider: "google",
      role: "OWNER",
      purpose: ["messaging"],
      accessGate: "open",
      status: "connected",
      externalId: "original-subject",
      createdAt: 1,
      updatedAt: 1,
    });

    await expect(
      provider.completeOAuth?.(callback("existing-account"), harness.value)
    ).rejects.toMatchObject({
      code: "GOOGLE_OAUTH_ACCOUNT_IDENTITY_MISMATCH",
    });
    expect(harness.upsertAccount).not.toHaveBeenCalled();
  });

  it("retains the stored role when reauthorization metadata omits it", async () => {
    stubToken("original-subject", "expected-nonce");
    const provider = createGoogleConnectorAccountProvider(runtime());
    const harness = manager({
      id: "existing-account",
      provider: "google",
      role: "AGENT",
      purpose: ["messaging"],
      accessGate: "open",
      status: "connected",
      externalId: "original-subject",
      createdAt: 1,
      updatedAt: 1,
    });

    const result = await provider.completeOAuth?.(
      callback("existing-account", undefined),
      harness.value
    );

    expect(result?.account?.role).toBe("AGENT");
    expect(harness.upsertAccount).toHaveBeenCalledWith(
      "google",
      expect.objectContaining({
        accountKey: stableGoogleConnectorAccountId("original-subject", "AGENT"),
        role: "AGENT",
      }),
      "existing-account"
    );
  });

  it("lazy-upgrades a role-matched legacy account and removes its prior credential", async () => {
    stubToken("legacy-subject", "expected-nonce");
    const priorVaultRef = "connector.agent-1.google.legacy-account.oauth.tokens";
    const runtimeHarness = createRuntimeHarness({
      credentialRefs: [
        {
          accountId: "00000000-0000-0000-0000-000000000042",
          credentialType: "oauth.tokens",
          vaultRef: priorVaultRef,
        },
      ],
      vaultEntries: { [priorVaultRef]: "old-token-set" },
    });
    const provider = createGoogleConnectorAccountProvider(runtimeHarness.value);
    const legacyAccount: ConnectorAccount = {
      id: "00000000-0000-0000-0000-000000000042",
      provider: "google",
      accountKey: "legacy-subject",
      role: "OWNER",
      purpose: ["messaging"],
      accessGate: "open",
      status: "connected",
      externalId: "legacy-subject",
      createdAt: 1,
      updatedAt: 1,
    };
    const harness = manager(legacyAccount);

    const result = await provider.completeOAuth?.(callback(), harness.value);

    expect(result?.account?.id).toBe(legacyAccount.id);
    expect(result?.account?.accountKey).toBe(
      stableGoogleConnectorAccountId("legacy-subject", "OWNER")
    );
    expect(runtimeHarness.adapter.listConnectorAccountCredentialRefs).toHaveBeenCalledWith({
      accountId: legacyAccount.id,
    });
    expect(runtimeHarness.vault.has(priorVaultRef)).toBe(false);
    expect(harness.upsertAccount).toHaveBeenCalledWith(
      "google",
      expect.objectContaining({
        accountKey: stableGoogleConnectorAccountId("legacy-subject", "OWNER"),
      }),
      legacyAccount.id
    );
  });

  it("loads reauthorization credential refs by the resolved canonical account id", async () => {
    stubToken("original-subject", "expected-nonce");
    const runtimeHarness = createRuntimeHarness();
    const provider = createGoogleConnectorAccountProvider(runtimeHarness.value);
    const existing: ConnectorAccount = {
      id: "00000000-0000-0000-0000-000000000043",
      provider: "google",
      accountKey: stableGoogleConnectorAccountId("original-subject", "OWNER"),
      role: "OWNER",
      purpose: ["messaging"],
      accessGate: "open",
      status: "connected",
      externalId: "original-subject",
      createdAt: 1,
      updatedAt: 1,
    };
    const harness = manager(existing);

    await provider.completeOAuth?.(callback(existing.accountKey), harness.value);

    expect(runtimeHarness.adapter.listConnectorAccountCredentialRefs).toHaveBeenCalledWith({
      accountId: existing.id,
    });
    expect(harness.upsertAccount).toHaveBeenCalledWith("google", expect.any(Object), existing.id);
  });

  it("does not delete a lazy-matched legacy account when credential persistence fails", async () => {
    stubToken("legacy-subject", "expected-nonce");
    const priorVaultRef = "connector.agent-1.google.legacy-account.oauth.tokens";
    const runtimeHarness = createRuntimeHarness({
      credentialRefs: [
        {
          accountId: "00000000-0000-0000-0000-000000000044",
          credentialType: "oauth.tokens",
          vaultRef: priorVaultRef,
        },
      ],
      failVaultSet: true,
      vaultEntries: { [priorVaultRef]: "old-token-set" },
    });
    const provider = createGoogleConnectorAccountProvider(runtimeHarness.value);
    const legacyAccount: ConnectorAccount = {
      id: "00000000-0000-0000-0000-000000000044",
      provider: "google",
      accountKey: "legacy-subject",
      role: "OWNER",
      purpose: ["messaging"],
      accessGate: "open",
      status: "connected",
      externalId: "legacy-subject",
      createdAt: 1,
      updatedAt: 1,
    };
    const harness = manager(legacyAccount);

    await expect(provider.completeOAuth?.(callback(), harness.value)).rejects.toThrow(
      "vault write rejected"
    );

    expect(harness.deleteAccount).not.toHaveBeenCalled();
    expect(harness.restoreAccount).toHaveBeenCalledWith(
      expect.objectContaining({ id: legacyAccount.id, status: "error" })
    );
    expect(runtimeHarness.vault.has(priorVaultRef)).toBe(false);
  });

  it("rejects a reauthorization flow for an account that was deleted", async () => {
    stubToken("subject-1", "expected-nonce");
    const provider = createGoogleConnectorAccountProvider(runtime());
    const harness = manager();

    await expect(
      provider.completeOAuth?.(callback("deleted-account"), harness.value)
    ).rejects.toMatchObject({
      code: "GOOGLE_OAUTH_REAUTH_ACCOUNT_NOT_FOUND",
    });
    expect(harness.upsertAccount).not.toHaveBeenCalled();
  });
});
