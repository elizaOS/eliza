/**
 * API-key auth boundary coverage keeps storage outages distinct from invalid
 * credentials so clients retry instead of prompting users to rotate good keys:
 * a validateApiKey THROW (datastore down) must map to 503 on BOTH guards, while
 * a null return (genuinely invalid key) stays a 401.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

let cookieBehavior: () => string | null = () => null;
mock.module("hono/cookie", () => ({
  getCookie: mock(() => cookieBehavior()),
}));

mock.module("hono/http-exception", () => ({
  HTTPException: class HTTPException extends Error {
    public readonly status: number;

    constructor(status: number, options?: { message?: string }) {
      super(options?.message);
      this.status = status;
    }
  },
}));

let validateBehavior: () => Promise<unknown> = async () => {
  throw new Error("database unavailable");
};
const validateApiKey = mock(() => validateBehavior());
let incrementBehavior: () => Promise<void> = async () => undefined;
let userBehavior: () => Promise<unknown> = async () => null;
let stewardUserBehavior: () => Promise<unknown> = async () => null;
const getWithOrganization = mock(() => userBehavior());
const getByStewardId = mock(() => stewardUserBehavior());
let stewardTokenBehavior: () => Promise<unknown> = async () => null;
const verifyStewardTokenCached = mock(() => stewardTokenBehavior());
let primaryUserBehavior: () => Promise<unknown> = async () => null;
const findWithOrganizationForWrite = mock(() => primaryUserBehavior());
let playwrightTokenBehavior: () => unknown = () => null;
const verifyPlaywrightTestSessionToken = mock(() => playwrightTokenBehavior());
// Mirrors the real gate's contract (production hard-fail + flag) so the
// import added to workers-hono-auth resolves and the enabled/disabled paths
// below stay exercisable.
let playwrightEnabledBehavior: (env: {
  NODE_ENV?: string;
  ENVIRONMENT?: string;
  PLAYWRIGHT_TEST_AUTH?: string;
}) => boolean = (env) =>
  env.NODE_ENV !== "production" &&
  env.ENVIRONMENT !== "production" &&
  env.PLAYWRIGHT_TEST_AUTH === "true";
const isPlaywrightTestAuthEnabled = mock(
  (env: { NODE_ENV?: string; ENVIRONMENT?: string; PLAYWRIGHT_TEST_AUTH?: string }) =>
    playwrightEnabledBehavior(env),
);
let adminBehavior: () => Promise<unknown> = async () => ({ isAdmin: false, role: null });
const getAdminStatusForUser = mock(() => adminBehavior());

mock.module("../services/api-keys", () => ({
  apiKeysService: {
    validateApiKey,
    incrementUsageDebounced: mock(() => incrementBehavior()),
  },
}));

mock.module("../services/users", () => ({
  usersService: {
    getWithOrganization,
    getByStewardId,
  },
}));

mock.module("../../db/repositories/users", () => ({
  usersRepository: {
    findWithOrganizationForWrite,
  },
}));

mock.module("../services/admin", () => ({
  adminService: {
    getAdminStatusForUser,
  },
}));

mock.module("./steward-client", () => ({
  isStagingSessionTokenCandidate: () => false,
  verifyStewardTokenCached,
}));

mock.module("./staging-session-binding", () => ({
  loadVerifiedStagingSessionUser: mock(async () => null),
}));

mock.module("./playwright-test-session", () => ({
  isPlaywrightTestAuthEnabled,
  PLAYWRIGHT_TEST_SESSION_COOKIE_NAME: "pw-test-session",
  verifyPlaywrightTestSessionToken,
}));

mock.module("../utils/logger", () => ({
  logger: {
    error: mock(() => undefined),
    warn: mock(() => undefined),
  },
}));

const {
  apiKeyScopeHashPrefix,
  getCurrentUser,
  requireAdmin,
  requireApiKeyCredential,
  requireCurrentBillingManagerSession,
  requireCronSecret,
  requireSessionUserWithOrg,
  requireUser,
  requireUserOrApiKey,
  requireUserOrApiKeyWithOrg,
  requireUserOrApiKeyWithOrgLookup,
} = await import("./workers-hono-auth");

function contextWithHeaders(
  headers: Record<string, string | null> = {},
  env: Record<string, unknown> = {},
) {
  const state = new Map<string, unknown>();
  const normalizedHeaders = new Map(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
  );
  return {
    env,
    executionCtx: { waitUntil: mock(() => undefined) },
    req: {
      url: "https://api.example.test/v1/models",
      header: (name: string) => normalizedHeaders.get(name.toLowerCase()) ?? null,
    },
    get: (key: string) => state.get(key),
    set: (key: string, value: unknown) => state.set(key, value),
  };
}

function contextWithApiKey(apiKey: string) {
  return contextWithHeaders({ "x-api-key": apiKey });
}

function activeUser(overrides: Record<string, unknown> = {}) {
  return {
    id: "user-1",
    email: "user@example.test",
    email_verified: true,
    organization_id: "org-1",
    organization: { id: "org-1", name: "Org", is_active: true },
    is_active: true,
    deleted_at: null,
    role: "member",
    steward_user_id: "steward-1",
    wallet_address: null,
    is_anonymous: false,
    ...overrides,
  };
}

beforeEach(() => {
  cookieBehavior = () => null;
  validateBehavior = async () => {
    throw new Error("database unavailable");
  };
  incrementBehavior = async () => undefined;
  userBehavior = async () => null;
  stewardUserBehavior = async () => null;
  stewardTokenBehavior = async () => null;
  primaryUserBehavior = async () => null;
  playwrightTokenBehavior = () => null;
  playwrightEnabledBehavior = (env) =>
    env.NODE_ENV !== "production" &&
    env.ENVIRONMENT !== "production" &&
    env.PLAYWRIGHT_TEST_AUTH === "true";
  adminBehavior = async () => ({ isAdmin: false, role: null });
  validateApiKey.mockClear();
  getWithOrganization.mockClear();
  getByStewardId.mockClear();
  verifyStewardTokenCached.mockClear();
  findWithOrganizationForWrite.mockClear();
  verifyPlaywrightTestSessionToken.mockClear();
  getAdminStatusForUser.mockClear();
});

describe("Workers API-key auth", () => {
  test("returns a service-unavailable error when API-key storage throws", async () => {
    await expect(
      requireUserOrApiKey(contextWithApiKey("eliza_live_key") as never),
    ).rejects.toMatchObject({
      status: 503,
      code: "service_unavailable",
      message: "API key validation is temporarily unavailable. Please retry.",
    });
  });

  test("requireUserOrApiKeyWithOrg maps the same storage throw to 503", async () => {
    await expect(
      requireUserOrApiKeyWithOrg(contextWithApiKey("eliza_live_key") as never),
    ).rejects.toMatchObject({
      status: 503,
      code: "service_unavailable",
    });
  });

  test("a null validation result stays 401 invalid-key on requireUserOrApiKey", async () => {
    validateBehavior = async () => null;
    await expect(
      requireUserOrApiKey(contextWithApiKey("eliza_bad_key") as never),
    ).rejects.toMatchObject({
      status: 401,
      code: "authentication_required",
    });
  });

  test("a null validation result stays 401 invalid-key on requireUserOrApiKeyWithOrg", async () => {
    validateBehavior = async () => null;
    await expect(
      requireUserOrApiKeyWithOrg(contextWithApiKey("eliza_bad_key") as never),
    ).rejects.toMatchObject({
      status: 401,
      code: "authentication_required",
    });
  });

  test("overlaps an org-scoped lookup with user/org hydration after key validation", async () => {
    let releaseUser!: () => void;
    const userBlocked = new Promise<void>((resolve) => {
      releaseUser = resolve;
    });
    validateBehavior = async () => ({
      id: "key-1",
      user_id: "user-1",
      organization_id: "org-1",
      is_active: true,
      expires_at: null,
    });
    userBehavior = async () => {
      await userBlocked;
      return {
        id: "user-1",
        organization_id: "org-1",
        organization: { id: "org-1", name: "Org", is_active: true },
        is_active: true,
        role: "member",
      };
    };
    const lookup = mock(async () => "agent-1");

    const pending = requireUserOrApiKeyWithOrgLookup(
      contextWithApiKey("eliza_live_key") as never,
      lookup,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(lookup).toHaveBeenCalledWith("org-1");
    releaseUser();

    await expect(pending).resolves.toMatchObject({ orgLookupResult: "agent-1" });
  });

  test("falls back to the hydrated user org when an API key row carries a stale org", async () => {
    validateBehavior = async () => ({
      id: "key-1",
      user_id: "user-1",
      organization_id: "stale-org",
      is_active: true,
      expires_at: null,
    });
    userBehavior = async () => ({
      id: "user-1",
      organization_id: "current-org",
      organization: { id: "current-org", name: "Org", is_active: true },
      is_active: true,
      role: "member",
    });
    const lookup = mock(async (orgId: string) => `agent-for-${orgId}`);

    await expect(
      requireUserOrApiKeyWithOrgLookup(contextWithApiKey("eliza_live_key") as never, lookup),
    ).resolves.toMatchObject({ orgLookupResult: "agent-for-current-org" });
    expect(lookup.mock.calls.map((call) => call[0])).toEqual(["stale-org", "current-org"]);
  });

  test("propagates a same-org overlapped lookup failure", async () => {
    validateBehavior = async () => ({
      id: "key-1",
      user_id: "user-1",
      organization_id: "org-1",
      is_active: true,
      expires_at: null,
    });
    userBehavior = async () => ({
      id: "user-1",
      organization_id: "org-1",
      organization: { id: "org-1", name: "Org", is_active: true },
      is_active: true,
      role: "member",
    });

    await expect(
      requireUserOrApiKeyWithOrgLookup(
        contextWithApiKey("eliza_live_key") as never,
        mock(async () => {
          throw new Error("lookup unavailable");
        }),
      ),
    ).rejects.toThrow("lookup unavailable");
  });

  test("rejects inactive, expired, or incomplete API-key accounts before returning a user", async () => {
    validateBehavior = async () => ({
      id: "key-1",
      user_id: "user-1",
      organization_id: "org-1",
      is_active: false,
      expires_at: null,
    });
    await expect(
      requireUserOrApiKeyWithOrg(contextWithApiKey("eliza_live_key") as never),
    ).rejects.toMatchObject({ status: 403, code: "access_denied" });

    validateBehavior = async () => ({
      id: "key-1",
      user_id: "user-1",
      organization_id: "org-1",
      is_active: true,
      expires_at: "2000-01-01T00:00:00.000Z",
    });
    await expect(
      requireUserOrApiKeyWithOrg(contextWithApiKey("eliza_live_key") as never),
    ).rejects.toMatchObject({ status: 401, code: "authentication_required" });

    validateBehavior = async () => ({
      id: "key-1",
      user_id: "user-1",
      organization_id: "org-1",
      is_active: true,
      expires_at: null,
    });
    userBehavior = async () => null;
    await expect(
      requireUserOrApiKeyWithOrg(contextWithApiKey("eliza_live_key") as never),
    ).rejects.toMatchObject({ status: 401, code: "authentication_required" });

    userBehavior = async () => ({
      id: "user-1",
      organization_id: "org-1",
      organization: { id: "org-1", name: "Org", is_active: true },
      is_active: false,
      role: "member",
    });
    await expect(
      requireUserOrApiKeyWithOrg(contextWithApiKey("eliza_live_key") as never),
    ).rejects.toMatchObject({ status: 403, code: "access_denied" });

    userBehavior = async () => ({
      id: "user-1",
      organization_id: "org-1",
      organization: { id: "org-1", name: "Org", is_active: false },
      is_active: true,
      role: "member",
    });
    await expect(
      requireUserOrApiKeyWithOrg(contextWithApiKey("eliza_live_key") as never),
    ).rejects.toMatchObject({ status: 403, code: "access_denied" });

    userBehavior = async () => ({
      id: "user-1",
      organization_id: null,
      organization: null,
      is_active: true,
      role: "member",
    });
    await expect(
      requireUserOrApiKeyWithOrg(contextWithApiKey("eliza_live_key") as never),
    ).rejects.toMatchObject({ status: 403, code: "access_denied" });
  });

  test("accepts bearer eliza API keys and records debounced usage failures out of band", async () => {
    validateBehavior = async () => ({
      id: "key-1",
      user_id: "user-1",
      organization_id: "org-1",
      is_active: true,
      expires_at: null,
    });
    userBehavior = async () => activeUser();
    incrementBehavior = async () => {
      throw new Error("usage write failed");
    };
    const c = contextWithHeaders({ authorization: "Bearer eliza_live_key" });

    await expect(requireUserOrApiKey(c as never)).resolves.toMatchObject({
      id: "user-1",
      organization_id: "org-1",
    });
    expect(c.get("authMethod")).toBe("api_key");
    expect(c.get("apiKeyId")).toBe("key-1");
    expect(c.executionCtx.waitUntil).toHaveBeenCalledTimes(1);
  });

  test("resolves and caches a Steward bearer session user", async () => {
    stewardTokenBehavior = async () => ({
      userId: "steward-1",
      email: "user@example.test",
      walletAddress: null,
      walletChain: null,
    });
    stewardUserBehavior = async () => activeUser();
    const c = contextWithHeaders({ authorization: "Bearer a.b.c" });

    await expect(getCurrentUser(c as never)).resolves.toMatchObject({
      id: "user-1",
      steward_id: "steward-1",
    });
    await expect(getCurrentUser(c as never)).resolves.toMatchObject({ id: "user-1" });
    expect(verifyStewardTokenCached).toHaveBeenCalledTimes(1);
  });

  test("accepts a Playwright test session only when the cookie claims match the hydrated org", async () => {
    cookieBehavior = () => "test-session-token";
    playwrightTokenBehavior = () => ({ userId: "user-1", organizationId: "org-1" });
    userBehavior = async () => activeUser();
    const c = contextWithHeaders(
      {},
      { PLAYWRIGHT_TEST_AUTH: "true", PLAYWRIGHT_TEST_AUTH_SECRET: "secret" },
    );

    await expect(getCurrentUser(c as never)).resolves.toMatchObject({
      id: "user-1",
      organization_id: "org-1",
    });
    expect(verifyPlaywrightTestSessionToken).toHaveBeenCalledTimes(1);
    expect(getWithOrganization).toHaveBeenCalledTimes(1);
  });

  test("keeps session-auth org lookup serialized after the session user is authorized", async () => {
    stewardTokenBehavior = async () => ({ userId: "steward-1" });
    stewardUserBehavior = async () => activeUser();
    const lookup = mock(async (orgId: string) => `agent-for-${orgId}`);

    await expect(
      requireUserOrApiKeyWithOrgLookup(
        contextWithHeaders({ authorization: "Bearer a.b.c" }) as never,
        lookup,
      ),
    ).resolves.toMatchObject({ orgLookupResult: "agent-for-org-1" });
    expect(lookup).toHaveBeenCalledWith("org-1");
  });

  test("rejects missing, inactive, and org-less session users", async () => {
    await expect(requireUser(contextWithHeaders() as never)).rejects.toMatchObject({
      status: 401,
      code: "authentication_required",
    });

    stewardTokenBehavior = async () => ({ userId: "steward-1" });
    stewardUserBehavior = async () => activeUser({ is_active: false });
    await expect(
      requireUser(contextWithHeaders({ authorization: "Bearer a.b.c" }) as never),
    ).rejects.toMatchObject({ status: 403, code: "access_denied" });

    stewardUserBehavior = async () => activeUser({ organization_id: null, organization: null });
    await expect(
      requireUserOrApiKeyWithOrg(contextWithHeaders({ authorization: "Bearer a.b.c" }) as never),
    ).rejects.toMatchObject({ status: 403, code: "access_denied" });
  });

  test("allows localhost local-dev admin without a session", async () => {
    const c = contextWithHeaders(
      {},
      { ELIZA_CLOUD_LOCAL_DEV_ADMIN: "true", NODE_ENV: "development" },
    );
    c.req.url = "http://localhost:8787/admin";

    await expect(requireAdmin(c as never)).resolves.toMatchObject({
      role: "super_admin",
      user: { email: "local-dev-admin@localhost" },
    });
    expect(getAdminStatusForUser).not.toHaveBeenCalled();
  });

  test("requires admin status and fails closed when admin lookup errors", async () => {
    validateBehavior = async () => ({
      id: "key-1",
      user_id: "user-1",
      organization_id: "org-1",
      is_active: true,
      expires_at: null,
    });
    userBehavior = async () => activeUser();
    adminBehavior = async () => ({ isAdmin: true, role: "support" });
    await expect(requireAdmin(contextWithApiKey("eliza_live_key") as never)).resolves.toMatchObject(
      {
        role: "support",
      },
    );

    adminBehavior = async () => {
      throw new Error("admin db unavailable");
    };
    await expect(requireAdmin(contextWithApiKey("eliza_live_key") as never)).rejects.toMatchObject({
      status: 403,
      code: "access_denied",
    });
  });

  test("API-key org auth resolves the key owner, records context, and tracks usage", async () => {
    validateBehavior = async () => ({
      id: "key-1",
      user_id: "user-1",
      organization_id: "org-1",
      is_active: true,
      expires_at: new Date(Date.now() + 60_000),
    });
    userBehavior = async () => activeUser();
    const c = contextWithApiKey("eliza_live_key");

    await expect(requireUserOrApiKeyWithOrg(c as never)).resolves.toMatchObject({
      id: "user-1",
      organization_id: "org-1",
    });
    expect(c.get("authMethod")).toBe("api_key");
    expect(c.get("apiKeyId")).toBe("key-1");
    expect(c.executionCtx.waitUntil).toHaveBeenCalled();
  });

  test("API-key org auth rejects missing, inactive, and organizationless owners", async () => {
    validateBehavior = async () => ({
      id: "key-1",
      user_id: "user-1",
      organization_id: "org-1",
      is_active: true,
      expires_at: new Date(Date.now() + 60_000),
    });

    userBehavior = async () => null;
    await expect(
      requireUserOrApiKeyWithOrg(contextWithApiKey("eliza_live_key") as never),
    ).rejects.toMatchObject({ status: 401 });

    userBehavior = async () => activeUser({ is_active: false });
    await expect(
      requireUserOrApiKeyWithOrg(contextWithApiKey("eliza_live_key") as never),
    ).rejects.toMatchObject({ status: 403 });

    userBehavior = async () => activeUser({ organization_id: null, organization: null });
    await expect(
      requireUserOrApiKeyWithOrg(contextWithApiKey("eliza_live_key") as never),
    ).rejects.toMatchObject({ status: 403 });
  });

  test("session-only API-key management rejects API keys and accepts cached sessions", async () => {
    await expect(
      requireSessionUserWithOrg(contextWithApiKey("eliza_live_key") as never),
    ).rejects.toMatchObject({
      status: 401,
      code: "session_auth_required",
    });

    const c = contextWithHeaders({});
    c.set("user", activeUser());
    c.set("authMethod", "session");
    await expect(requireSessionUserWithOrg(c as never)).resolves.toMatchObject({
      organization_id: "org-1",
    });
  });

  test("billing cancellation admits only current primary owner or admin sessions", async () => {
    cookieBehavior = () => "steward-session";
    stewardTokenBehavior = async () => ({ userId: "steward-1" });

    for (const role of ["owner", "admin"] as const) {
      const c = contextWithHeaders({ cookie: "steward-token=steward-session" });
      c.set("user", activeUser({ role, steward_id: "steward-1" }));
      c.set("authMethod", "session");
      primaryUserBehavior = async () => activeUser({ role });

      await expect(requireCurrentBillingManagerSession(c as never)).resolves.toMatchObject({
        organization_id: "org-1",
        role,
      });
    }

    expect(findWithOrganizationForWrite).toHaveBeenCalledTimes(2);
  });

  test("billing cancellation rejects keys, stale roles, moved tenants, and invalid sessions", async () => {
    await expect(
      requireCurrentBillingManagerSession(contextWithApiKey("eliza_live_key") as never),
    ).rejects.toMatchObject({ status: 401, code: "session_auth_required" });
    expect(findWithOrganizationForWrite).not.toHaveBeenCalled();

    cookieBehavior = () => "steward-session";
    stewardTokenBehavior = async () => ({ userId: "steward-1" });
    const staleOwner = contextWithHeaders({ cookie: "steward-token=steward-session" });
    staleOwner.set("user", activeUser({ role: "owner", steward_id: "steward-1" }));
    staleOwner.set("authMethod", "session");
    primaryUserBehavior = async () => activeUser({ role: "member" });
    await expect(requireCurrentBillingManagerSession(staleOwner as never)).rejects.toMatchObject({
      status: 403,
    });

    const movedOwner = contextWithHeaders({ cookie: "steward-token=steward-session" });
    movedOwner.set("user", activeUser({ role: "owner", steward_id: "steward-1" }));
    movedOwner.set("authMethod", "session");
    primaryUserBehavior = async () =>
      activeUser({
        role: "owner",
        organization_id: "org-2",
        organization: { id: "org-2", name: "Other", is_active: true },
      });
    await expect(requireCurrentBillingManagerSession(movedOwner as never)).rejects.toMatchObject({
      status: 403,
    });

    const invalidSession = contextWithHeaders({ cookie: "steward-token=steward-session" });
    invalidSession.set("user", activeUser({ role: "owner", steward_id: "steward-1" }));
    invalidSession.set("authMethod", "session");
    stewardTokenBehavior = async () => null;
    await expect(
      requireCurrentBillingManagerSession(invalidSession as never),
    ).rejects.toMatchObject({ status: 401 });
  });

  test("billing cancellation rejects ineligible current users and organizations", async () => {
    cookieBehavior = () => "steward-session";
    stewardTokenBehavior = async () => ({ userId: "steward-1" });

    const cases = [
      { current: undefined, status: 401, message: "The signed-in session is no longer valid" },
      {
        current: activeUser({ role: "owner", steward_user_id: "steward-2" }),
        status: 401,
        message: "The signed-in session is no longer valid",
      },
      {
        current: activeUser({ role: "owner", is_active: false }),
        status: 403,
        message: "User account is not eligible for billing management",
      },
      {
        current: activeUser({ role: "owner", is_anonymous: true }),
        status: 403,
        message: "User account is not eligible for billing management",
      },
      {
        current: activeUser({ role: "owner", deleted_at: new Date() }),
        status: 403,
        message: "User account is not eligible for billing management",
      },
      {
        current: activeUser({ role: "owner", expires_at: new Date(Date.now() - 60_000) }),
        status: 403,
        message: "User account is not eligible for billing management",
      },
      {
        current: activeUser({
          role: "owner",
          organization: { id: "org-1", name: "Inactive", is_active: false },
        }),
        status: 403,
        message: "Organization billing authority changed",
      },
    ];

    for (const { current, status, message } of cases) {
      const c = contextWithHeaders({ cookie: "steward-token=steward-session" });
      c.set("user", activeUser({ role: "owner", steward_id: "steward-1" }));
      c.set("authMethod", "session");
      primaryUserBehavior = async () => current;

      await expect(requireCurrentBillingManagerSession(c as never)).rejects.toMatchObject({
        status,
        message,
      });
    }
  });

  test("billing cancellation fails closed when primary authority is unavailable", async () => {
    cookieBehavior = () => "steward-session";
    stewardTokenBehavior = async () => ({ userId: "steward-1" });
    primaryUserBehavior = async () => {
      throw new Error("primary unavailable");
    };
    const c = contextWithHeaders({ cookie: "steward-token=steward-session" });
    c.set("user", activeUser({ role: "owner", steward_id: "steward-1" }));
    c.set("authMethod", "session");

    await expect(requireCurrentBillingManagerSession(c as never)).rejects.toMatchObject({
      status: 503,
      code: "service_unavailable",
    });
  });

  test("billing cancellation revalidates enabled Playwright sessions before primary role", async () => {
    cookieBehavior = () => "playwright-session";
    playwrightEnabledBehavior = () => true;
    playwrightTokenBehavior = () => ({
      userId: "user-1",
      organizationId: "org-1",
      exp: Math.floor(Date.now() / 1000) + 60,
    });
    primaryUserBehavior = async () => activeUser({ role: "admin" });
    const c = contextWithHeaders(
      { cookie: "pw-test-session=playwright-session" },
      { PLAYWRIGHT_TEST_AUTH: "true" },
    );
    c.set("user", activeUser({ role: "admin", steward_id: "steward-1" }));
    c.set("authMethod", "session");

    await expect(requireCurrentBillingManagerSession(c as never)).resolves.toMatchObject({
      role: "admin",
    });
    expect(verifyPlaywrightTestSessionToken).toHaveBeenCalled();
  });

  test("getCurrentUser caches null when no Steward token is present", async () => {
    const c = contextWithHeaders({});
    await expect(getCurrentUser(c as never)).resolves.toBeNull();
    await expect(getCurrentUser(c as never)).resolves.toBeNull();
    expect(c.get("user")).toBeNull();
  });

  test("checks cron secrets from bearer or x-cron-secret headers", () => {
    expect(() =>
      requireCronSecret(
        contextWithHeaders(
          { authorization: "Bearer cron-ok" },
          { CRON_SECRET: "cron-ok" },
        ) as never,
      ),
    ).not.toThrow();
    expect(() =>
      requireCronSecret(
        contextWithHeaders({ "x-cron-secret": "cron-ok" }, { CRON_SECRET: "cron-ok" }) as never,
      ),
    ).not.toThrow();
    expect(() => requireCronSecret(contextWithHeaders({}, {}) as never)).toThrow(
      "Cron secret not configured",
    );
    expect(() =>
      requireCronSecret(
        contextWithHeaders({ authorization: "Bearer wrong" }, { CRON_SECRET: "cron-ok" }) as never,
      ),
    ).toThrow("Invalid cron secret");
  });
});

describe("apiKeyScopeHashPrefix (shared-agent scope cache key — COLDPATH-FIX-2026-07-21)", () => {
  test("derives the 16-char sha256 prefix of the X-API-Key credential", async () => {
    // Same sha256 + 16-char-prefix derivation the api-key validation cache uses,
    // so the scope cache is keyed by the exact same credential identity.
    const prefix = await apiKeyScopeHashPrefix(
      contextWithApiKey("eliza_test_key_abcdef0123456789") as never,
    );
    expect(prefix).toBe("9b98f179eb88406b");
    expect(prefix).toHaveLength(16);
  });

  test("also keys off an eliza_ bearer token (same credential, same prefix)", async () => {
    const prefix = await apiKeyScopeHashPrefix(
      contextWithHeaders({ authorization: "Bearer eliza_test_key_abcdef0123456789" }) as never,
    );
    expect(prefix).toBe("9b98f179eb88406b");
  });

  test("returns null when the request is not API-key authenticated", async () => {
    // Session/JWT/cookie requests scope on the authoritative gate, never a hash
    // of an empty string.
    expect(await apiKeyScopeHashPrefix(contextWithHeaders({}) as never)).toBeNull();
    expect(
      await apiKeyScopeHashPrefix(
        contextWithHeaders({ authorization: "Bearer not-an-eliza-key" }) as never,
      ),
    ).toBeNull();
  });

  test("distinct keys yield distinct prefixes", async () => {
    const a = await apiKeyScopeHashPrefix(contextWithApiKey("eliza_key_one") as never);
    const b = await apiKeyScopeHashPrefix(contextWithApiKey("eliza_key_two") as never);
    expect(a).not.toBe(b);
    expect(a).toHaveLength(16);
    expect(b).toHaveLength(16);
  });
});

describe("requireApiKeyCredential", () => {
  test("rejects missing and JWT session auth before validating an API key", async () => {
    await expect(requireApiKeyCredential(contextWithHeaders({}) as never)).rejects.toMatchObject({
      status: 401,
      code: "authentication_required",
    });
    await expect(
      requireApiKeyCredential(
        contextWithHeaders({ authorization: "Bearer header.payload.signature" }) as never,
      ),
    ).rejects.toMatchObject({ status: 401, code: "authentication_required" });
    expect(validateApiKey).not.toHaveBeenCalled();
  });

  test("rejects ambiguous API-key headers before validating either credential", async () => {
    await expect(
      requireApiKeyCredential(
        contextWithHeaders({
          authorization: "Bearer eliza_bearer_key",
          "x-api-key": "eliza_header_key",
        }) as never,
      ),
    ).rejects.toMatchObject({ status: 401, code: "authentication_required" });
    expect(validateApiKey).not.toHaveBeenCalled();
  });

  test("records the API-key identity proven by the exact presented credential", async () => {
    const validated = {
      id: "11111111-1111-4111-8111-111111111111",
      key_hash: "a".repeat(64),
      is_active: true,
      expires_at: new Date(Date.now() + 60_000),
    };
    validateBehavior = async () => validated;
    const context = contextWithHeaders({ authorization: "Bearer eliza_exact_key" });

    expect(await requireApiKeyCredential(context as never)).toBe(validated);
    expect(context.get("authMethod")).toBe("api_key");
    expect(context.get("apiKeyId")).toBe(validated.id);
    expect(validateApiKey).toHaveBeenCalledWith("eliza_exact_key");
  });

  test("distinguishes an invalid key from a validation storage outage", async () => {
    validateBehavior = async () => null;
    await expect(
      requireApiKeyCredential(contextWithApiKey("eliza_invalid") as never),
    ).rejects.toMatchObject({ status: 401, code: "authentication_required" });

    validateBehavior = async () => {
      throw new Error("database unavailable");
    };
    await expect(
      requireApiKeyCredential(contextWithApiKey("eliza_valid_shape") as never),
    ).rejects.toMatchObject({ status: 503, code: "service_unavailable" });
  });
});
