/**
 * Route contract for direct-signup post-commit provisioning.
 *
 * The session exchange must pass the Worker lifetime into the shared identity
 * authority and must prime the first-request cache after identity and the
 * required default API key are ready, before independently self-healing
 * onboarding starts. The waitUntil-owned onboarding and audit tails must not
 * delay the response or the first authenticated Personal request.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

const emitAudit = mock(async (): Promise<void> => undefined);
const primeVerifiedUserSessionCache = mock(
  async (): Promise<void> => undefined,
);
const verifyStewardTokenCached = mock(async () => ({
  userId: "steward-user-1",
  email: "person@example.test",
  expiration: Math.floor(Date.now() / 1000) + 900,
  issuedAt: Math.floor(Date.now() / 1000) - 10,
}));
let postCommitTail = deferred<void>();
type MockSyncedUser = {
  id: string;
  organization_id: string;
  initialCreditsGranted?: boolean;
  initialFreeCreditsUsd?: number;
  postCommitProvisioningDeferred?: true;
};
const syncUserFromSteward = mock(
  async (params: {
    executionCtx?: { waitUntil(promise: Promise<unknown>): void };
    afterRequiredSignupProvisioning?: (user: MockSyncedUser) => Promise<void>;
  }): Promise<MockSyncedUser> => {
    const user = {
      id: "cloud-user-1",
      organization_id: "org-1",
      initialCreditsGranted: false,
      initialFreeCreditsUsd: 0,
      postCommitProvisioningDeferred: true as const,
    };
    await params.afterRequiredSignupProvisioning?.(user);
    params.executionCtx?.waitUntil(postCommitTail.promise);
    return user;
  },
);
const committedUser = {
  id: "cloud-user-1",
  created_at: new Date("2026-08-22T00:00:00.000Z"),
  email: "person@example.test",
  email_verified: true,
  organization_id: "org-1",
  organization: { id: "org-1", name: "Person Org", is_active: true },
  is_active: true,
  role: "owner",
  steward_user_id: "steward-user-1",
  wallet_address: null,
  is_anonymous: false,
};
const getByStewardId = mock(async () => committedUser);
const findActivePersonalDedicatedTarget = mock(async () => null);

class MockStewardPhoneOwnershipError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

class MockStewardPhoneAccountConflictError extends Error {}
class MockStewardTelegramAccountClaimError extends Error {}

mock.module("@/api-app/services/audit-dispatcher-singleton", () => ({
  getAuditDispatcher: () => ({ emit: emitAudit }),
}));
mock.module("@/lib/auth/staging-session-binding", () => ({
  loadVerifiedStagingSessionUser: async () => undefined,
}));
mock.module("@/lib/auth/session-user-cache", () => ({
  primeVerifiedUserSessionCache,
}));
mock.module("@/lib/auth/steward-client", () => ({
  isStagingSessionTokenCandidate: () => false,
  verifyStewardTokenCached,
}));
mock.module("@/lib/services/steward-client", () => ({
  StewardPhoneOwnershipError: MockStewardPhoneOwnershipError,
  verifyStewardBearerPhone: async () => ({ status: "not_linked" }),
}));
mock.module("@/lib/services/sso-bridge-codes", () => ({
  isBlockedBySsoBridgeLogout: async () => false,
}));
mock.module("@/lib/middleware/rate-limit-hono-cloudflare", () => ({
  getIpKey: () => "test-client",
  getRequestIp: () => "127.0.0.1",
  RateLimitPresets: { STRICT: {} },
  rateLimit: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));
mock.module("@/lib/steward-sync", () => ({
  describeSyncError: (error: unknown) =>
    error instanceof Error ? error.message : String(error),
  StewardPhoneAccountConflictError: MockStewardPhoneAccountConflictError,
  StewardTelegramAccountClaimError: MockStewardTelegramAccountClaimError,
  syncUserFromSteward,
}));
mock.module("@/lib/services/users", () => ({
  usersService: { getByStewardId },
}));
mock.module("@/lib/services/agent-tier-upgrade-target", () => ({
  findActivePersonalDedicatedTarget,
}));
mock.module("@/lib/services/account-lifecycle-authority", () => ({
  organizationLifecycleAllowsNewWork: () => true,
  readOrganizationLifecycleAuthority: async () => ({
    state: "active",
    revision: 0,
    active: true,
    deletionRequestId: null,
  }),
}));
mock.module("@/lib/utils/logger", () => ({
  logger: {
    debug: mock(() => undefined),
    error: mock(() => undefined),
    info: mock(() => undefined),
    warn: mock(() => undefined),
  },
}));

const { default: stewardSessionRoute } = await import("./route");
const { default: personalRoute } = await import(
  "../../v1/eliza/personal/route"
);
const { default: personalConversationsRoute } = await import(
  "../../v1/eliza/agents/[agentId]/api/conversations/route"
);

const ENV = {
  ENVIRONMENT: "staging",
  NODE_ENV: "production",
  STEWARD_SESSION_SECRET: "test-secret",
};

function sessionRequest(): Request {
  return new Request(
    "https://api-staging.elizacloud.ai/api/auth/steward-session",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://staging.elizacloud.ai",
      },
      body: JSON.stringify({ token: "valid-steward-token" }),
    },
  );
}

beforeEach(() => {
  postCommitTail = deferred<void>();
  emitAudit.mockReset();
  emitAudit.mockResolvedValue(undefined);
  primeVerifiedUserSessionCache.mockReset();
  primeVerifiedUserSessionCache.mockResolvedValue(undefined);
  syncUserFromSteward.mockClear();
  syncUserFromSteward.mockImplementation(async (params) => {
    const user = {
      id: "cloud-user-1",
      organization_id: "org-1",
      initialCreditsGranted: false,
      initialFreeCreditsUsd: 0,
      postCommitProvisioningDeferred: true as const,
    };
    await params.afterRequiredSignupProvisioning?.(user);
    params.executionCtx?.waitUntil(postCommitTail.promise);
    return user;
  });
  getByStewardId.mockClear();
  findActivePersonalDedicatedTarget.mockClear();
});

describe("POST /api/auth/steward-session post-commit tail", () => {
  test("primes cache before onboarding starts, then responds while audit and onboarding are pending", async () => {
    const cachePrimeStarted = deferred<void>();
    const cachePrimeTail = deferred<void>();
    const auditTail = deferred<void>();
    primeVerifiedUserSessionCache.mockImplementationOnce(async () => {
      cachePrimeStarted.resolve();
      await cachePrimeTail.promise;
    });
    emitAudit.mockImplementationOnce(async () => await auditTail.promise);
    const background: Promise<unknown>[] = [];
    const executionCtx = {
      waitUntil: (promise: Promise<unknown>) => background.push(promise),
      passThroughOnException: () => undefined,
    };
    const app = new Hono();
    app.route("/api/auth/steward-session", stewardSessionRoute);
    app.route("/api/v1/eliza/personal", personalRoute);
    app.route(
      "/api/v1/eliza/agents/:agentId/api/conversations",
      personalConversationsRoute,
    );

    let responseSettled = false;
    const responsePromise = Promise.resolve(
      app.fetch(sessionRequest(), ENV, executionCtx as never),
    ).then((response) => {
      responseSettled = true;
      return response;
    });

    await cachePrimeStarted.promise;
    expect(responseSettled).toBe(false);
    expect(background).toHaveLength(0);
    cachePrimeTail.resolve();

    const response = await responsePromise;

    expect(response.status).toBe(200);
    const setCookie = response.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("steward-token-staging=valid-steward-token");
    expect(setCookie).toContain("steward-authed-staging=1");
    expect(background[0]).toBe(postCommitTail.promise);
    expect(background).toHaveLength(2);
    expect(primeVerifiedUserSessionCache).toHaveBeenCalledWith(
      "valid-steward-token",
      expect.objectContaining({ id: "cloud-user-1", organization_id: "org-1" }),
    );
    expect(emitAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: { type: "user", id: "cloud-user-1" },
        action: "auth.login",
        result: "success",
      }),
    );

    const personalResponse = await app.fetch(
      new Request("https://api-staging.elizacloud.ai/api/v1/eliza/personal", {
        headers: {
          cookie: "steward-token-staging=valid-steward-token",
        },
      }),
      ENV,
      executionCtx as never,
    );
    expect(personalResponse.status).toBe(200);
    const personalBody = (await personalResponse.json()) as {
      data: { identity: { id: string; runtime: string } };
    };
    expect(personalBody).toMatchObject({
      success: true,
      data: { identity: { runtime: "shared" } },
    });
    const personalId = personalBody.data.identity.id;

    const conversationsResponse = await app.fetch(
      new Request(
        `https://api-staging.elizacloud.ai/api/v1/eliza/agents/${encodeURIComponent(personalId)}/api/conversations`,
        {
          headers: {
            cookie: "steward-token-staging=valid-steward-token",
          },
        },
      ),
      ENV,
      executionCtx as never,
    );
    expect(conversationsResponse.status).toBe(200);
    await expect(conversationsResponse.json()).resolves.toMatchObject({
      conversations: [{ id: personalId }],
    });
    expect(getByStewardId).toHaveBeenCalledTimes(2);
    expect(findActivePersonalDedicatedTarget).toHaveBeenCalledTimes(1);
    expect(background).toHaveLength(2);

    postCommitTail.resolve();
    auditTail.resolve();
    await expect(Promise.all(background)).resolves.toEqual([
      undefined,
      undefined,
    ]);
  });

  test("required default API-key failure remains fail-closed and plants no cookie or cache", async () => {
    syncUserFromSteward.mockRejectedValueOnce(
      new Error("required default API-key provisioning failed"),
    );
    const background: Promise<unknown>[] = [];
    const app = new Hono();
    app.route("/api/auth/steward-session", stewardSessionRoute);

    const response = await app.fetch(sessionRequest(), ENV, {
      waitUntil: (promise: Promise<unknown>) => background.push(promise),
      passThroughOnException: () => undefined,
    } as never);

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      code: "steward_user_sync_failed",
    });
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(background).toHaveLength(0);
    expect(primeVerifiedUserSessionCache).not.toHaveBeenCalled();
  });

  test("cache-prime failure stays fail-open after identity commit", async () => {
    primeVerifiedUserSessionCache.mockRejectedValueOnce(
      new Error("cache unavailable"),
    );
    const background: Promise<unknown>[] = [];
    const app = new Hono();
    app.route("/api/auth/steward-session", stewardSessionRoute);

    const response = await app.fetch(sessionRequest(), ENV, {
      waitUntil: (promise: Promise<unknown>) => background.push(promise),
      passThroughOnException: () => undefined,
    } as never);

    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain(
      "steward-token-staging=valid-steward-token",
    );
    expect(background).toHaveLength(2);

    postCommitTail.resolve();
    await expect(Promise.all(background)).resolves.toEqual([
      undefined,
      undefined,
    ]);
  });

  test("audit failure stays fail-open after cookie mint", async () => {
    emitAudit.mockRejectedValueOnce(new Error("audit unavailable"));
    const background: Promise<unknown>[] = [];
    const app = new Hono();
    app.route("/api/auth/steward-session", stewardSessionRoute);

    const response = await app.fetch(sessionRequest(), ENV, {
      waitUntil: (promise: Promise<unknown>) => background.push(promise),
      passThroughOnException: () => undefined,
    } as never);

    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain(
      "steward-token-staging=valid-steward-token",
    );
    expect(background).toHaveLength(2);

    postCommitTail.resolve();
    await expect(Promise.all(background)).resolves.toEqual([
      undefined,
      undefined,
    ]);
  });

  test("non-Worker callers retain inline cache and audit completion", async () => {
    const cachePrimeStarted = deferred<void>();
    const cachePrimeTail = deferred<void>();
    const auditStarted = deferred<void>();
    const auditTail = deferred<void>();
    primeVerifiedUserSessionCache.mockImplementationOnce(async () => {
      cachePrimeStarted.resolve();
      await cachePrimeTail.promise;
    });
    emitAudit.mockImplementationOnce(async () => {
      auditStarted.resolve();
      await auditTail.promise;
    });
    const app = new Hono();
    app.route("/api/auth/steward-session", stewardSessionRoute);

    let responseSettled = false;
    const responsePromise = Promise.resolve(
      app.fetch(sessionRequest(), ENV),
    ).then((response) => {
      responseSettled = true;
      return response;
    });

    await cachePrimeStarted.promise;
    expect(responseSettled).toBe(false);
    cachePrimeTail.resolve();

    await auditStarted.promise;
    expect(responseSettled).toBe(false);
    auditTail.resolve();

    const response = await responsePromise;
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain(
      "steward-token-staging=valid-steward-token",
    );
  });

  test("returning-user exchanges do not suppress cache-miss self-heal", async () => {
    syncUserFromSteward.mockImplementationOnce(async () => ({
      id: "cloud-user-1",
      organization_id: "org-1",
    }));
    const background: Promise<unknown>[] = [];
    const app = new Hono();
    app.route("/api/auth/steward-session", stewardSessionRoute);

    const response = await app.fetch(sessionRequest(), ENV, {
      waitUntil: (promise: Promise<unknown>) => background.push(promise),
      passThroughOnException: () => undefined,
    } as never);

    expect(response.status).toBe(200);
    expect(primeVerifiedUserSessionCache).not.toHaveBeenCalled();
    expect(background).toHaveLength(1);
    await expect(background[0]).resolves.toBeUndefined();
  });
});
