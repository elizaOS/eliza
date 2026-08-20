/**
 * Drives the production OAuth callback and refresh boundaries with deterministic
 * HTTP, database, secret, and cache collaborators. The suite proves identity
 * extraction fails closed and every provider request receives the shared deadline.
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
const dbWriteMock = {
  select: () => ({
    from: () => ({
      where: () => ({
        limit: async () => [] as unknown[],
      }),
    }),
  }),
};

let stateData: Record<string, unknown> | null;
let storedState: unknown;
let userInfoBody: Record<string, unknown>;
let originalFetch: typeof globalThis.fetch;

mock.module("../../../cache/client", () => ({
  cache: {
    get: async () => stateData,
    del: async () => {},
    set: async (_key: string, value: unknown) => {
      storedState = value;
    },
  },
}));

mock.module("../../../runtime/cloud-bindings", () => ({
  getCloudAwareEnv: () => ({ NEXT_PUBLIC_APP_URL: "https://test.example" }),
  getCloudBinding: () => undefined,
  hasCloudBindingsContext: () => false,
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
  dbWrite: dbWriteMock,
}));

mock.module("../../../../db/helpers", () => ({
  dbRead: {},
  dbWrite: dbWriteMock,
  writeTransaction: async (fn: (tx: unknown) => Promise<unknown>) =>
    fn({
      insert: () => ({
        values: () => ({
          onConflictDoUpdate: () => ({ returning: insertReturning }),
        }),
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
    storedState = undefined;
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

  it("applies the shared 15-second deadline to callback and refresh requests", async () => {
    const { handleOAuth2Callback, OAUTH2_REQUEST_TIMEOUT_MS, refreshOAuth2Token } = await import(
      "./oauth2"
    );
    expect(OAUTH2_REQUEST_TIMEOUT_MS).toBe(15_000);

    userInfoBody = { id: "real-user-42" };
    const fetchedSignals: unknown[] = [];
    const timeoutCalls: number[] = [];
    const originalTimeout = AbortSignal.timeout;
    AbortSignal.timeout = mock((milliseconds: number) => {
      timeoutCalls.push(milliseconds);
      return originalTimeout(milliseconds);
    }) as typeof AbortSignal.timeout;
    globalThis.fetch = mock(async (url: unknown, init?: RequestInit) => {
      fetchedSignals.push(init?.signal);
      const u = String(url);
      if (u.includes("/token")) {
        return jsonResponse({ access_token: "at-123", token_type: "Bearer" });
      }
      if (u.includes("/userinfo")) {
        return jsonResponse(userInfoBody);
      }
      throw new Error(`unexpected fetch ${u}`);
    }) as unknown as typeof globalThis.fetch;

    try {
      await handleOAuth2Callback(provider, "auth-code", "state-token");
      await expect(refreshOAuth2Token(provider, "refresh-token")).resolves.toMatchObject({
        accessToken: "at-123",
      });
      expect(timeoutCalls).toEqual([15_000, 15_000, 15_000]);
      expect(fetchedSignals).toHaveLength(3);
      for (const sig of fetchedSignals) {
        expect(sig).toBeInstanceOf(AbortSignal);
      }
    } finally {
      AbortSignal.timeout = originalTimeout;
    }
  });

  it("propagates a provider deadline before storing callback credentials", async () => {
    const { handleOAuth2Callback } = await import("./oauth2");
    const controller = new AbortController();
    const timeoutCalls: number[] = [];
    const originalTimeout = AbortSignal.timeout;
    AbortSignal.timeout = mock((milliseconds: number) => {
      timeoutCalls.push(milliseconds);
      return controller.signal;
    }) as typeof AbortSignal.timeout;
    let markFetchStarted: (() => void) | undefined;
    const fetchStarted = new Promise<void>((resolve) => {
      markFetchStarted = resolve;
    });
    globalThis.fetch = mock(
      async (_url: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          markFetchStarted?.();
          const signal = init?.signal;
          if (signal?.aborted) {
            reject(signal.reason);
            return;
          }
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
    ) as unknown as typeof globalThis.fetch;

    try {
      const pending = handleOAuth2Callback(provider, "auth-code", "state-token");
      await fetchStarted;
      controller.abort(new DOMException("OAuth provider deadline exceeded", "TimeoutError"));

      await expect(pending).rejects.toMatchObject({ name: "TimeoutError" });
      expect(timeoutCalls).toEqual([15_000]);
      expect(secretsCreateCalls).toHaveLength(0);
      expect(insertReturning).not.toHaveBeenCalled();
    } finally {
      AbortSignal.timeout = originalTimeout;
    }
  });

  it("keeps bounded capability intent in server state and out of the OAuth URL", async () => {
    const { initiateOAuth2 } = await import("./oauth2");
    const result = await initiateOAuth2(provider, {
      organizationId: "org-1",
      userId: "user-1",
      capabilityContinuation: {
        agentId: "agent-1",
        connectorId: "testprov",
        expiresAt: Date.now() + 60_000,
        continuation: {
          originalIntent: "schedule lunch with Maya",
          capabilityId: "calendar",
          clientMessageId: "turn-1",
          requiresConfirmation: true,
        },
      },
    });

    expect(result.authUrl).not.toContain("schedule");
    expect(result.authUrl).not.toContain("turn-1");
    expect(storedState).toMatchObject({
      organizationId: "org-1",
      userId: "user-1",
      capabilityContinuation: {
        agentId: "agent-1",
        connectorId: "testprov",
      },
    });
  });

  it("returns an unexpired server-bound continuation after callback", async () => {
    const { handleOAuth2Callback } = await import("./oauth2");
    userInfoBody = { id: "real-user-42" };
    stateData = {
      ...stateData,
      capabilityContinuation: {
        agentId: "agent-1",
        connectorId: "testprov",
        expiresAt: Date.now() + 60_000,
        continuation: {
          originalIntent: "schedule lunch with Maya",
          capabilityId: "calendar",
          requiresConfirmation: true,
        },
      },
    };

    const result = await handleOAuth2Callback(provider, "auth-code", "state-token");
    expect(result).toMatchObject({
      agentId: "agent-1",
      capabilityContinuation: {
        originalIntent: "schedule lunch with Maya",
        capabilityId: "calendar",
        requiresConfirmation: true,
      },
    });
  });
});
