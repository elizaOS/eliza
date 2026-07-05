/**
 * Error-policy regression for #13415: OAuth identity extraction must fail closed.
 * Drives the real handleOAuth2Callback (token exchange + userInfo fetch mocked at
 * the HTTP boundary; db/secrets/cache mocked) to prove a provider response with no
 * id/sub PROPAGATES a thrown error instead of fabricating an "unknown" platform
 * user id, while a minimal-but-valid response (id present, no email) still succeeds
 * — the failure and the legitimately-sparse case are distinguishable.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

const secretsCreateCalls: unknown[] = [];
const insertReturning = mock(async () => [{ id: "conn-1" }]);

let stateData: Record<string, unknown> | null;
let userInfoBody: Record<string, unknown>;
let originalFetch: typeof globalThis.fetch;

mock.module("../../../cache/client", () => ({
  cache: {
    get: async () => stateData,
    del: async () => {},
    set: async () => {},
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
        values: () => ({
          onConflictDoUpdate: () => ({ returning: insertReturning }),
        }),
      }),
    }),
}));

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
});
