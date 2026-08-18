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

const secretsCreateCalls: unknown[] = [];
const insertReturning = mock(async () => [{ id: "conn-1" }]);
const cacheSetCalls: unknown[][] = [];
const insertValuesCalls: Array<Record<string, unknown>> = [];

let stateData: Record<string, unknown> | null;
let userInfoBody: Record<string, unknown>;
let originalFetch: typeof globalThis.fetch;

mock.module("../../../cache/client", () => ({
  cache: {
    get: async () => stateData,
    del: async () => {},
    set: async (...args: unknown[]) => {
      cacheSetCalls.push(args);
    },
  },
}));

mock.module("../../../runtime/cloud-bindings", () => ({
  getCloudAwareEnv: () => ({ NEXT_PUBLIC_APP_URL: "https://test.example" }),
}));

mock.module("../provider-registry", () => ({
  getClientId: () => "client-id",
  getClientSecret: () => "client-secret",
  getCallbackUrl: () => "https://test.example/callback",
  resolveRequestedScopes: (_p: unknown, s?: string[]) => s ?? [],
  resolveCapabilityScopes: (_p: unknown, capabilities?: string[]) => ({
    status: "needs_review",
    capabilities: capabilities ?? [],
    scopes: ["identity", "messages.write"],
    userScopes: ["identity.basic"],
    missingScopes: ["identity", "messages.write", "identity.basic"],
    retryAfterConsent: true,
  }),
  getNestedValue: () => undefined,
}));

mock.module("../../secrets", () => ({
  secretsService: {
    create: async (input: unknown) => {
      secretsCreateCalls.push(input);
      return { id: `secret-${secretsCreateCalls.length}` };
    },
    list: async () => [],
    rotate: async () => {},
    delete: async () => {},
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
          insertValuesCalls.push(values);
          return {
            onConflictDoUpdate: () => ({ returning: insertReturning }),
          };
        },
      }),
    }),
}));

afterAll(() => {
  mock.module("../../../cache/client", () => realCacheClientExports);
  mock.module("../../../runtime/cloud-bindings", () => realCloudBindingsExports);
  mock.module("../provider-registry", () => realProviderRegistryExports);
  mock.module("../../secrets", () => realSecretsExports);
  mock.module("../../../../db/client", () => realDbClientExports);
  mock.module("../../../../db/helpers", () => realDbHelpersExports);
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
    cacheSetCalls.length = 0;
    insertValuesCalls.length = 0;
    insertReturning.mockClear();
    stateData = {
      organizationId: "org-1",
      userId: "user-1",
      providerId: "testprov",
      redirectUrl: "/done",
      scopes: ["a"],
      connectionRole: "OWNER",
      createdAt: Date.now(),
    };
    originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async (url: unknown) => {
      const u = String(url);
      if (u.includes("/token")) {
        return jsonResponse({ access_token: "at-123", token_type: "Bearer" });
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

  it("never persists Slack user scopes omitted from an AGENT authorization", async () => {
    const { handleOAuth2Callback, initiateOAuth2 } = await import("./oauth2");
    const slackProvider = {
      ...provider,
      id: "slack",
      userScopes: ["identity.basic"],
    };
    const initiated = await initiateOAuth2(slackProvider, {
      organizationId: "org-1",
      userId: "user-1",
      capabilities: ["messages.write"],
      connectionRole: "agent",
    });
    const authUrl = new URL(initiated.authUrl);
    const [, storedState] = cacheSetCalls[0] as [string, Record<string, unknown>];

    expect(authUrl.searchParams.has("user_scope")).toBe(false);
    expect(storedState.userScopes).toEqual([]);
    expect(initiated.scopeAccess.userScopes).toEqual([]);
    expect(initiated.scopeAccess.missingScopes).not.toContain("identity.basic");

    stateData = storedState;
    userInfoBody = { id: "slack-bot-42" };
    await handleOAuth2Callback(slackProvider, "auth-code", initiated.state);

    expect(insertValuesCalls).toHaveLength(1);
    expect(insertValuesCalls[0]?.scopes).toEqual(["identity", "messages.write"]);
    expect(insertValuesCalls[0]?.scopes).not.toContain("identity.basic");
  });
});

describe("initiateOAuth2 — incremental consent protocol", () => {
  beforeEach(() => {
    cacheSetCalls.length = 0;
  });

  it("binds capability scopes, redirect state, and PKCE into the authorization request", async () => {
    const { initiateOAuth2 } = await import("./oauth2");
    const result = await initiateOAuth2(
      {
        ...provider,
        id: "slack",
        pkce: true,
        userScopes: ["identity.basic"],
      },
      {
        organizationId: "org-1",
        userId: "user-1",
        redirectUrl: "/settings/connections",
        capabilities: ["messages.write"],
        connectionRole: "owner",
      },
    );
    const authUrl = new URL(result.authUrl);

    expect(authUrl.searchParams.get("redirect_uri")).toBe("https://test.example/callback");
    expect(authUrl.searchParams.get("scope")).toBe("identity messages.write");
    expect(authUrl.searchParams.get("user_scope")).toBe("identity.basic");
    expect(authUrl.searchParams.get("state")).toBe(result.state);
    expect(authUrl.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authUrl.searchParams.get("code_challenge")).toBeTruthy();
    expect(result.scopeAccess).toMatchObject({
      status: "needs_review",
      capabilities: ["messages.write"],
      retryAfterConsent: true,
    });

    const [key, storedState, ttl] = cacheSetCalls[0] as [string, Record<string, unknown>, number];
    expect(key).toBe(`oauth2:slack:${result.state}`);
    expect(ttl).toBe(600);
    expect(storedState).toMatchObject({
      redirectUrl: "/settings/connections",
      scopes: ["identity", "messages.write"],
      userScopes: ["identity.basic"],
      capabilities: ["messages.write"],
      connectionRole: "OWNER",
    });
    expect(storedState.codeVerifier).toBeTruthy();
  });

  it("preserves the raw scopes protocol when no capability request is supplied", async () => {
    const { initiateOAuth2 } = await import("./oauth2");
    const result = await initiateOAuth2(provider, {
      organizationId: "org-1",
      userId: "user-1",
      scopes: ["legacy.read"],
    });

    expect(new URL(result.authUrl).searchParams.get("scope")).toBe("legacy.read");
    expect(result.scopeAccess).toMatchObject({
      capabilities: [],
      scopes: ["legacy.read"],
      retryAfterConsent: true,
    });
  });
});
