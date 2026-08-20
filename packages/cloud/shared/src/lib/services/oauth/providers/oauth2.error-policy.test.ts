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

let stateData: Record<string, unknown> | null;
let userInfoBody: Record<string, unknown>;
let tokenBody: Record<string, unknown>;
let storedConnection: Record<string, unknown> | null;
let cachedState: Record<string, unknown> | null;
let originalFetch: typeof globalThis.fetch;

mock.module("../../../cache/client", () => ({
  cache: {
    get: async () => stateData,
    del: async () => {},
    set: async (_key: string, value: Record<string, unknown>) => {
      cachedState = value;
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
  getAllowedScopes: realProviderRegistry.getAllowedScopes,
  resolveOAuthCapabilityRequest: realProviderRegistry.resolveOAuthCapabilityRequest,
  resolveRequestedScopes: realProviderRegistry.resolveRequestedScopes,
  getNestedValue: realProviderRegistry.getNestedValue,
  projectOAuthConnectedAccount: realProviderRegistry.projectOAuthConnectedAccount,
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
          storedConnection = values;
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

function jsonResponse(body: unknown, headers?: HeadersInit) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
    headers: new Headers(headers),
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
  defaultScopes: ["a"],
  allowedScopes: ["a", "b"],
  capabilityScopes: {
    "test.write": { scopes: ["b"], riskLevel: "R2" },
  },
  userScopes: ["user:read"],
  allowedUserScopes: ["user:read"],
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
      userScopes: ["user:read"],
      connectionRole: "OWNER",
      createdAt: Date.now(),
    };
    tokenBody = {
      access_token: "at-123",
      token_type: "Bearer",
      authed_user: { access_token: "user-at-123" },
    };
    storedConnection = null;
    cachedState = null;
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
    expect(storedConnection?.source_context).toEqual({
      connectionRole: "OWNER",
      oauthUserScopes: [],
    });
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
        return jsonResponse({
          access_token: "at-123",
          token_type: "Bearer",
          authed_user: { access_token: "user-at-123" },
        });
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

  it("stores provider-confirmed grants and drops malformed added scopes", async () => {
    const { handleOAuth2Callback } = await import("./oauth2");
    userInfoBody = { id: "real-user-42" };
    tokenBody = {
      access_token: "at-123",
      token_type: "Bearer",
      scope: "a provider:unexpected",
      authed_user: {
        access_token: "user-at-123",
        scope: "user:read rogue:scope",
      },
    };

    await handleOAuth2Callback(provider, "auth-code", "state-token");

    expect(storedConnection?.scopes).toEqual(["a"]);
    expect(storedConnection?.source_context).toEqual({
      connectionRole: "OWNER",
      oauthUserScopes: ["user:read"],
    });
  });

  it("rejects a different account returned during bound incremental consent", async () => {
    const { handleOAuth2Callback } = await import("./oauth2");
    stateData = {
      organizationId: "org-1",
      userId: "user-1",
      providerId: "testprov",
      redirectUrl: "/done",
      scopes: ["a"],
      userScopes: ["user:read"],
      expectedPlatformUserId: "expected-user",
      connectionRole: "OWNER",
      createdAt: Date.now(),
    };
    userInfoBody = { id: "different-user" };

    await expect(handleOAuth2Callback(provider, "auth-code", "state-token")).rejects.toThrow(
      "permission",
    );
    expect(insertReturning).not.toHaveBeenCalled();
  });

  it("rejects an OWNER grant when the provider omits the user-authority token", async () => {
    const { handleOAuth2Callback } = await import("./oauth2");
    userInfoBody = { id: "real-user-42" };
    tokenBody = { access_token: "bot-at-123", token_type: "Bearer" };

    await expect(handleOAuth2Callback(provider, "auth-code", "state-token")).rejects.toThrow(
      "permission",
    );
    expect(secretsCreateCalls).toHaveLength(0);
    expect(insertReturning).not.toHaveBeenCalled();
  });

  it("binds Slack OWNER identity to workspace plus authorizing user without identity scopes", async () => {
    const { handleOAuth2Callback } = await import("./oauth2");
    const slackProvider = {
      ...provider,
      id: "slack",
      endpoints: {
        authorization: "https://slack.com/oauth/v2/authorize",
        token: "https://test.example/token",
      },
      defaultScopes: ["users:read"],
      allowedScopes: ["users:read", "chat:write"],
      userScopes: undefined,
      allowedUserScopes: ["users:read", "chat:write"],
      tokenIdentityMappings: {
        OWNER: { idParts: ["team.id", "authed_user.id"] },
      },
    } as never;
    stateData = {
      organizationId: "org-1",
      userId: "user-1",
      providerId: "slack",
      redirectUrl: "/done",
      scopes: [],
      userScopes: ["users:read", "chat:write"],
      connectionRole: "OWNER",
      createdAt: Date.now(),
    };
    tokenBody = {
      ok: true,
      team: { id: "T123", name: "Workspace" },
      authed_user: {
        id: "U456",
        access_token: "user-secret-must-not-reach-profile",
        refresh_token: "refresh-secret-must-not-reach-profile",
        expires_in: 43_200,
        scope: "users:read,chat:write",
      },
    };

    const result = await handleOAuth2Callback(slackProvider, "auth-code", "state-token");

    expect(result.platformUserId).toBe("T123:U456");
    expect(storedConnection?.platform_user_id).toBe("T123:U456");
    expect(storedConnection?.source_context).toEqual({
      connectionRole: "OWNER",
      oauthUserScopes: ["users:read", "chat:write"],
    });
    expect(JSON.stringify(storedConnection?.profile_data)).not.toContain("secret-must-not");
  });

  it("fails closed when Slack omits the workspace component of its role-bound identity", async () => {
    const { handleOAuth2Callback } = await import("./oauth2");
    const slackProvider = {
      ...provider,
      id: "slack",
      endpoints: {
        authorization: "https://slack.com/oauth/v2/authorize",
        token: "https://test.example/token",
      },
      userScopes: undefined,
      allowedUserScopes: [],
      tokenIdentityMappings: {
        OWNER: { idParts: ["team.id", "authed_user.id"] },
      },
    } as never;
    stateData = {
      organizationId: "org-1",
      userId: "user-1",
      providerId: "slack",
      redirectUrl: "/done",
      scopes: ["a"],
      userScopes: [],
      connectionRole: "OWNER",
      createdAt: Date.now(),
    };
    tokenBody = {
      access_token: "bot-at-123",
      authed_user: { id: "U456" },
    };

    await expect(handleOAuth2Callback(slackProvider, "auth-code", "state-token")).rejects.toThrow(
      "role-bound identity",
    );
    expect(secretsCreateCalls).toHaveLength(0);
    expect(insertReturning).not.toHaveBeenCalled();
  });

  it("redacts nested token material from token-response profile metadata", async () => {
    const { handleOAuth2Callback } = await import("./oauth2");
    const tokenIdentityProvider = {
      ...provider,
      userScopes: undefined,
      allowedUserScopes: undefined,
      tokenIdentityMappings: {
        OWNER: { idParts: ["owner.id"] },
      },
    } as never;
    stateData = {
      organizationId: "org-1",
      userId: "user-1",
      providerId: "testprov",
      redirectUrl: "/done",
      scopes: ["a"],
      userScopes: [],
      connectionRole: "OWNER",
      createdAt: Date.now(),
    };
    tokenBody = {
      access_token: "top-level-secret",
      refresh_token: "refresh-secret",
      id_token: "identity-secret",
      owner: {
        id: "owner-1",
        accessToken: "nested-secret",
      },
    };

    await handleOAuth2Callback(tokenIdentityProvider, "auth-code", "state-token");

    expect(storedConnection?.profile_data).toEqual({ owner: { id: "owner-1" } });
  });

  it("uses GitHub's confirmed grant header and never continues on a merely requested repo scope", async () => {
    const { handleOAuth2Callback } = await import("./oauth2");
    const githubProvider = {
      ...provider,
      id: "github",
      userScopes: undefined,
      allowedUserScopes: undefined,
      defaultScopes: ["read:user"],
      allowedScopes: ["read:user", "repo"],
      capabilityScopes: {
        "repositories.full_control": { scopes: ["repo"], riskLevel: "R3" },
      },
      grantedScopeAuthority: { source: "user_info_header", header: "x-oauth-scopes" },
    } as never;
    stateData = {
      organizationId: "org-1",
      userId: "user-1",
      providerId: "github",
      redirectUrl: "/auth/success",
      scopes: ["read:user", "repo"],
      capabilities: ["repositories.full_control"],
      capabilityRequest: {
        contractVersion: 2,
        requestId: "req_repo_1",
        capabilityId: "repositories.full_control",
        operation: "repository.write",
        riskLevel: "R3",
        accountId: null,
        inputDigest: "a".repeat(64),
      },
      connectionRole: "OWNER",
      createdAt: Date.now(),
    };
    tokenBody = { access_token: "github-at", token_type: "Bearer", scope: "repo" };
    globalThis.fetch = mock(async (url: unknown) => {
      if (String(url).includes("/token")) return jsonResponse(tokenBody);
      if (String(url).includes("/userinfo")) {
        return jsonResponse({ id: "github-user" }, { "x-oauth-scopes": "read:user" });
      }
      throw new Error(`unexpected fetch ${String(url)}`);
    }) as unknown as typeof globalThis.fetch;

    const result = await handleOAuth2Callback(githubProvider, "auth-code", "state-token");

    expect(storedConnection?.scopes).toEqual(["read:user"]);
    expect(result.capabilityAccess).toMatchObject([
      { capabilityId: "repositories.full_control", riskLevel: "R3", status: "needs_admin" },
    ]);
    expect(result.capabilityContinuation).toBeUndefined();
  });
});

describe("initiateOAuth2 — incremental capability protocol (#19879)", () => {
  it("preserves grants, binds the account, and emits PKCE plus capability state", async () => {
    const { initiateOAuth2 } = await import("./oauth2");
    cachedState = null;
    const result = await initiateOAuth2({ ...provider, pkce: true } as never, {
      organizationId: "org-1",
      userId: "user-1",
      capabilities: ["test.write"],
      grantedScopes: ["a"],
      expectedPlatformUserId: "platform-user-1",
      connectionRole: "OWNER",
    });

    const url = new URL(result.authUrl);
    expect(url.searchParams.get("scope")?.split(" ")).toEqual(["a", "b"]);
    expect(url.searchParams.get("user_scope")).toBe("user:read");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url.searchParams.get("state")).toBe(result.state);
    expect(result.capabilityAccess).toEqual([
      {
        capabilityId: "test.write",
        riskLevel: "R2",
        status: "needs_review",
        missingScopes: ["b"],
        missingUserScopes: [],
      },
    ]);
    expect(cachedState).toMatchObject({
      organizationId: "org-1",
      userId: "user-1",
      scopes: ["a", "b"],
      userScopes: ["user:read"],
      expectedPlatformUserId: "platform-user-1",
    });
  });

  it("keeps Slack OWNER and bot grants in separate OAuth installations", async () => {
    const { initiateOAuth2 } = await import("./oauth2");
    const slackProvider = {
      ...provider,
      id: "slack",
      defaultScopes: ["users:read"],
      allowedScopes: ["users:read", "chat:write"],
      userScopes: undefined,
      allowedUserScopes: ["users:read", "chat:write"],
      roleScopeDefaults: {
        OWNER: { scopes: [], userScopes: ["users:read"] },
        AGENT: { scopes: ["users:read"], userScopes: [] },
      },
    } as never;

    const owner = await initiateOAuth2(slackProvider, {
      organizationId: "org-1",
      userId: "user-1",
      connectionRole: "OWNER",
    });
    const ownerUrl = new URL(owner.authUrl);
    expect(ownerUrl.searchParams.has("scope")).toBe(false);
    expect(ownerUrl.searchParams.get("user_scope")).toBe("users:read");

    const agent = await initiateOAuth2(slackProvider, {
      organizationId: "org-1",
      userId: "user-1",
      connectionRole: "AGENT",
    });
    const agentUrl = new URL(agent.authUrl);
    expect(agentUrl.searchParams.get("scope")).toBe("users:read");
    expect(agentUrl.searchParams.has("user_scope")).toBe(false);
  });
});

describe("OAuth2 provider credential lifecycle (#19879)", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("refreshes a Slack user grant from the nested authed_user response", async () => {
    const { refreshOAuth2Token } = await import("./oauth2");
    globalThis.fetch = mock(async () =>
      jsonResponse({
        ok: true,
        authed_user: {
          access_token: "rotated-user-token",
          refresh_token: "rotated-user-refresh",
          expires_in: 43_200,
          scope: "users:read,chat:write",
        },
      }),
    ) as unknown as typeof globalThis.fetch;

    await expect(refreshOAuth2Token(provider as never, "old-user-refresh")).resolves.toEqual({
      accessToken: "rotated-user-token",
      expiresIn: 43_200,
      newRefreshToken: "rotated-user-refresh",
      grantedScopes: undefined,
      grantedUserScopes: ["users:read", "chat:write"],
    });
  });

  it("revokes only the selected GitHub token with authenticated app credentials", async () => {
    const { revokeOAuth2Credential } = await import("./oauth2");
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    globalThis.fetch = mock(async (url: unknown, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedInit = init;
      return jsonResponse({});
    }) as unknown as typeof globalThis.fetch;

    await expect(
      revokeOAuth2Credential(
        {
          ...provider,
          id: "github",
          revocation: { transport: "github_token", token: "access", response: "http_ok" },
        } as never,
        { accessToken: "selected-token" },
      ),
    ).resolves.toEqual({ remoteRevoked: true });

    expect(capturedUrl).toBe("https://api.github.com/applications/client-id/token");
    expect(capturedInit?.method).toBe("DELETE");
    expect(capturedInit?.body).toBe(JSON.stringify({ access_token: "selected-token" }));
    expect(new Headers(capturedInit?.headers).get("authorization")).toBe(
      `Basic ${Buffer.from("client-id:client-secret").toString("base64")}`,
    );
  });

  it("does not treat Slack HTTP 200 as revocation without an affirmative body", async () => {
    const { revokeOAuth2Credential } = await import("./oauth2");
    globalThis.fetch = mock(async () =>
      jsonResponse({ ok: false, error: "not_authed" }),
    ) as unknown as typeof globalThis.fetch;

    await expect(
      revokeOAuth2Credential(
        {
          ...provider,
          endpoints: { ...provider.endpoints, revoke: "https://slack.com/api/auth.revoke" },
          revocation: { transport: "bearer", token: "access", response: "slack_json" },
        } as never,
        { accessToken: "slack-token" },
      ),
    ).rejects.toThrow("did not confirm");
  });
});
