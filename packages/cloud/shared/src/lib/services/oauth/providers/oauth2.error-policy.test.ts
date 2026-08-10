/**
 * Error-policy regression for #13415: OAuth identity extraction must fail closed.
 * Drives the real handleOAuth2Callback (token exchange + userInfo fetch mocked at
 * the HTTP boundary; db/secrets/cache mocked) to prove a provider response with no
 * id/sub PROPAGATES a thrown error instead of fabricating an "unknown" platform
 * user id, while a minimal-but-valid response (id present, no email) still succeeds
 * — the failure and the legitimately-sparse case are distinguishable.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import * as realDbClient from "../../../../db/client";
import * as realDbHelpers from "../../../../db/helpers";
import * as realAgentConnectorBindingRepository from "../../../../db/repositories/agent-connector-bindings";
import * as realCacheClient from "../../../cache/client";
import * as realCloudBindings from "../../../runtime/cloud-bindings";
import * as realSecrets from "../../secrets";
import * as realProviderRegistry from "../provider-registry";

// bun's `mock.module` patches the process-global module registry, and this file
// only restored `globalThis.fetch` in afterEach — it never reinstalled the six
// modules stubbed below. Under the batched cloud-unit runner (`--isolate`
// occasionally fails to contain these on a memory-pressured runner) those
// db/client + db/helpers + cache/secrets doubles otherwise bleed into later
// suites (e.g. the oxapay payment adapter and orphan reconcilers, whose import
// chains pull the real db layer), turning them red. Snapshot the real exports
// now and reinstall them in afterAll so this file's stubs are strictly local.
const realCacheClientExports = { ...realCacheClient };
const realCloudBindingsExports = { ...realCloudBindings };
const realProviderRegistryExports = { ...realProviderRegistry };
const realSecretsExports = { ...realSecrets };
const realDbClientExports = { ...realDbClient };
const realDbHelpersExports = { ...realDbHelpers };
const realAgentConnectorBindingRepositoryExports = {
  ...realAgentConnectorBindingRepository,
};

const secretsCreateCalls: unknown[] = [];
const secretValues = new Map<string, string>();
const deletedSecretIds: string[] = [];
const insertReturning = mock(async () => [{ id: "conn-1" }]);
const bindConnector = mock(async () => ({ id: "binding-1" }));
const insertedCredentialValues: Array<Record<string, unknown>> = [];

let stateData: Record<string, unknown> | null;
let userInfoBody: Record<string, unknown>;
let tokenBody: Record<string, unknown>;
let originalFetch: typeof globalThis.fetch;

mock.module("../../../cache/client", () => ({
  cache: {
    get: async () => stateData,
    del: async () => {},
    set: async (_key: string, value: Record<string, unknown>) => {
      stateData = value;
    },
  },
}));

mock.module("../../../runtime/cloud-bindings", () => ({
  getCloudAwareEnv: () => ({ NEXT_PUBLIC_APP_URL: "https://test.example" }),
}));

mock.module("../provider-registry", () => ({
  getCallbackUrl: () => "https://test.example/callback",
  resolveRequestedScopes: (_p: unknown, s?: string[]) => s ?? [],
  resolveOAuthClientCredentials: async () => ({
    clientId: "client-id",
    clientSecret: "client-secret",
  }),
  getNestedValue: () => undefined,
}));

mock.module("../../secrets", () => ({
  secretsService: {
    create: async (input: unknown) => {
      secretsCreateCalls.push(input);
      const id = `secret-${secretsCreateCalls.length}`;
      const value = (input as { value?: unknown }).value;
      if (typeof value === "string") secretValues.set(id, value);
      return { id };
    },
    getDecryptedValue: async (id: string) => secretValues.get(id),
    list: async () => [],
    rotate: async () => {},
    delete: async (id: string) => {
      deletedSecretIds.push(id);
      secretValues.delete(id);
    },
  },
}));

mock.module("../../../../db/client", () => ({
  dbWrite: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => [] as unknown[],
        }),
      }),
    }),
  },
}));

mock.module("../../../../db/helpers", () => ({
  writeTransaction: async (fn: (tx: unknown) => Promise<unknown>) =>
    fn({
      insert: () => ({
        values: (values: Record<string, unknown>) => {
          insertedCredentialValues.push(values);
          return {
            onConflictDoUpdate: () => ({ returning: insertReturning }),
          };
        },
      }),
    }),
}));

mock.module("../../../../db/repositories/agent-connector-bindings", () => ({
  bindAgentConnectorWithTransaction: bindConnector,
}));

afterAll(() => {
  mock.module("../../../cache/client", () => realCacheClientExports);
  mock.module("../../../runtime/cloud-bindings", () => realCloudBindingsExports);
  mock.module("../provider-registry", () => realProviderRegistryExports);
  mock.module("../../secrets", () => realSecretsExports);
  mock.module("../../../../db/client", () => realDbClientExports);
  mock.module("../../../../db/helpers", () => realDbHelpersExports);
  mock.module(
    "../../../../db/repositories/agent-connector-bindings",
    () => realAgentConnectorBindingRepositoryExports,
  );
});

function jsonResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

const provider = {
  id: "testprov",
  endpoints: {
    authorization: "https://test.example/auth",
    token: "https://test.example/token",
    userInfo: "https://test.example/userinfo",
  },
  pkce: false,
} as never;

describe("handleOAuth2Callback — identity extraction fails closed (#13415)", () => {
  beforeEach(() => {
    secretsCreateCalls.length = 0;
    secretValues.clear();
    deletedSecretIds.length = 0;
    insertedCredentialValues.length = 0;
    insertReturning.mockClear();
    bindConnector.mockClear();
    stateData = {
      organizationId: "org-1",
      userId: "user-1",
      providerId: "testprov",
      redirectUrl: "/done",
      scopes: ["a"],
      connectionRole: "OWNER",
      createdAt: Date.now(),
    };
    tokenBody = { access_token: "at-123", token_type: "Bearer" };
    originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async (url: unknown) => {
      const u = String(url);
      if (u.includes("/token")) {
        return jsonResponse(tokenBody);
      }
      if (u.includes("/userinfo")) {
        return jsonResponse(userInfoBody);
      }
      throw new Error(`unexpected fetch ${u}`);
    }) as unknown as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("propagates a thrown error when the provider returns no id/sub (no fabricated 'unknown')", async () => {
    const { handleOAuth2Callback } = await import("./oauth2");
    userInfoBody = {}; // internal failure: identity missing

    let caught: unknown;
    try {
      await handleOAuth2Callback(provider, "auth-code", "state-token");
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("Could not extract user ID");
    // Fail-closed proof: we threw BEFORE reaching connection storage, so no
    // bogus "unknown"-identity secret/row was written.
    expect(secretsCreateCalls).toHaveLength(0);
    expect(insertReturning).not.toHaveBeenCalled();
  });

  it("succeeds for a minimal-but-valid response (id present, no email) — sparse is not failure", async () => {
    const { handleOAuth2Callback } = await import("./oauth2");
    userInfoBody = { id: "real-user-42" }; // legitimately sparse, but a real identity

    const result = await handleOAuth2Callback(provider, "auth-code", "state-token");

    expect(result.platformUserId).toBe("real-user-42");
    expect(result.email).toBeUndefined();
    expect(result.connectionId).toBe("conn-1");
    // The real id flowed through storage untouched (never coerced to "unknown").
    expect(insertReturning).toHaveBeenCalledTimes(1);
  });

  it("creates the server-validated agent binding after storing the credential", async () => {
    const { handleOAuth2Callback } = await import("./oauth2");
    userInfoBody = { id: "real-user-42" };
    stateData = {
      ...stateData,
      agentBinding: {
        agentId: "agent-1",
        role: "OWNER",
        selectedProducts: ["gmail"],
        isDefault: true,
      },
    };

    const result = await handleOAuth2Callback(provider, "auth-code", "state-token");

    expect(result.connectorBindingId).toBe("binding-1");
    expect(bindConnector).toHaveBeenCalledWith(expect.anything(), {
      organizationId: "org-1",
      agentId: "agent-1",
      platformCredentialId: "conn-1",
      provider: "testprov",
      role: "OWNER",
      purposes: ["automation"],
      accessGate: "owner_binding",
      selectedProducts: ["gmail"],
      isDefault: true,
      authorizedByUserId: "user-1",
      requireVerifiedOwner: true,
    });
  });

  it("stores only the scopes Google reports as granted", async () => {
    const { handleOAuth2Callback } = await import("./oauth2");
    const googleProvider = { ...provider, id: "google" } as never;
    stateData = {
      ...stateData,
      providerId: "google",
      scopes: [
        "https://www.googleapis.com/auth/gmail.readonly",
        "https://www.googleapis.com/auth/gmail.compose",
      ],
    };
    tokenBody = {
      access_token: "at-123",
      token_type: "Bearer",
      scope: "https://www.googleapis.com/auth/gmail.readonly",
    };
    userInfoBody = { id: "real-user-42" };

    await handleOAuth2Callback(googleProvider, "auth-code", "state-token");

    expect(insertedCredentialValues).toHaveLength(1);
    expect(insertedCredentialValues[0]?.scopes).toEqual([
      "https://www.googleapis.com/auth/gmail.readonly",
    ]);
  });

  it("stores Google credentials as OWNER while preserving an independent agent binding role", async () => {
    const { handleOAuth2Callback } = await import("./oauth2");
    const googleProvider = { ...provider, id: "google" } as never;
    stateData = {
      ...stateData,
      providerId: "google",
      connectionRole: "AGENT",
      agentBinding: {
        agentId: "agent-1",
        role: "AGENT",
        selectedProducts: ["gmail"],
      },
    };
    tokenBody = {
      access_token: "at-123",
      token_type: "Bearer",
      scope: "a",
    };
    userInfoBody = { id: "real-user-42" };

    await handleOAuth2Callback(googleProvider, "auth-code", "state-token");

    expect(insertedCredentialValues[0]?.source_context).toEqual({
      connectionRole: "OWNER",
    });
    expect(insertedCredentialValues[0]?.user_id).toBe("user-1");
    expect(bindConnector).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        provider: "google",
        role: "AGENT",
        authorizedByUserId: "user-1",
        requireVerifiedOwner: true,
      }),
    );
  });

  it("stores PKCE in the vault and resolves it after state survives a restart", async () => {
    const { handleOAuth2Callback, initiateOAuth2 } = await import("./oauth2");
    const pkceProvider = { ...provider, pkce: true } as never;

    const initiated = await initiateOAuth2(pkceProvider, {
      organizationId: "org-1",
      userId: "user-1",
      scopes: ["a"],
    });
    const persistedState = stateData as Record<string, unknown>;
    expect(persistedState).not.toHaveProperty("codeVerifier");
    expect(persistedState.codeVerifierSecretId).toBe("secret-1");
    expect(secretValues.get("secret-1")).toMatch(/^[A-Za-z0-9_-]{43}$/);

    userInfoBody = { id: "real-user-42" };
    await expect(
      handleOAuth2Callback(pkceProvider, "auth-code", initiated.state),
    ).resolves.toMatchObject({ platformUserId: "real-user-42" });
    expect(deletedSecretIds).toContain("secret-1");
  });
});
