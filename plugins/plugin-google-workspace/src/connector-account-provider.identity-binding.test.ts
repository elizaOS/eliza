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
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createGoogleConnectorAccountProvider,
  stableGoogleConnectorAccountId,
} from "./connector-account-provider.js";
import { GOOGLE_OAUTH_SCOPES } from "./scopes.js";

function unsignedJwt(payload: Record<string, unknown>): string {
  return `${Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url")}.${Buffer.from(
    JSON.stringify(payload)
  ).toString("base64url")}.signature`;
}

function runtime() {
  return {
    agentId: "agent-1",
    getSetting: (key: string) =>
      ({
        GOOGLE_CLIENT_ID: "client-id",
        GOOGLE_CLIENT_SECRET: "client-secret",
        GOOGLE_REDIRECT_URI: "http://127.0.0.1:31437/api/connectors/google/oauth/callback",
      })[key],
    getService: (serviceType: string) =>
      serviceType === "vault" ? { set: vi.fn(async () => undefined) } : null,
  } as never;
}

function manager(existing: ConnectorAccount | null = null) {
  const setConnectorAccountCredentialRef = vi.fn(async () => undefined);
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
      getStorage: () => ({ setConnectorAccountCredentialRef }),
    } as unknown as ConnectorAccountManager,
    getAccount,
    upsertAccount,
  };
}

function stubToken(subject: string, nonce: string) {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            access_token: "access-token",
            refresh_token: "refresh-token",
            expires_in: 3600,
            scope: GOOGLE_OAUTH_SCOPES.gmail.read,
            id_token: unsignedJwt({
              sub: subject,
              email: `${subject}@example.com`,
              nonce,
            }),
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
    )
  );
}

function stubTokenAndUserInfo(
  tokenIdentity: Record<string, unknown>,
  userInfo: Record<string, unknown>
) {
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
            id_token: unsignedJwt(tokenIdentity),
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
  );
}

function callback(accountId?: string) {
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
        requestedRole: "OWNER",
        requestedCapabilities: ["gmail.read"],
        requestedScopes: [GOOGLE_OAUTH_SCOPES.gmail.read],
        oidcNonce: "expected-nonce",
      },
    },
  };
}

describe("Google OAuth connector-account identity binding", () => {
  afterEach(() => vi.unstubAllGlobals());

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
