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

function runtime() {
  const vault = new Map<string, string>();
  return {
    agentId: "agent-1",
    adapter: {
      listConnectorAccountCredentialRefs: vi.fn(async () => []),
      deleteConnectorAccountCredentialRefs: vi.fn(async () => 0),
      setConnectorAccountCredentialRef: vi.fn(async () => undefined),
    },
    getSetting: (key: string) =>
      ({
        GOOGLE_CLIENT_ID: "client-id",
        GOOGLE_CLIENT_SECRET: "client-secret",
        GOOGLE_REDIRECT_URI: "http://127.0.0.1:31437/api/connectors/google/oauth/callback",
      })[key],
    getService: (serviceType: string) =>
      serviceType === "vault"
        ? {
            set: vi.fn(async (key: string, value: string) => {
              vault.set(key, value);
            }),
            get: vi.fn(async (key: string) => vault.get(key) ?? null),
            has: vi.fn(async (key: string) => vault.has(key)),
            remove: vi.fn(async (key: string) => {
              vault.delete(key);
            }),
          }
        : null,
  } as never;
}

function manager(existing: ConnectorAccount | null = null) {
  const setConnectorAccountCredentialRef = vi.fn(async () => undefined);
  const restoreAccount = vi.fn(async (account: ConnectorAccount) => account);
  const deleteAccount = vi.fn(async () => true);
  const getAccount = vi.fn(async () => existing);
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
      upsertAccount,
      getStorage: () => ({
        setConnectorAccountCredentialRef,
        upsertAccount: restoreAccount,
        deleteAccount,
      }),
    } as unknown as ConnectorAccountManager,
    getAccount,
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
    expect(harness.upsertAccount).toHaveBeenCalledWith(
      "google",
      expect.objectContaining({ externalId: "subject-1" }),
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
      expect.objectContaining({ role: "AGENT" }),
      "existing-account"
    );
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
