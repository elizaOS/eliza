/**
 * The local-dev-admin bypass must fail closed in production at BOTH layers:
 * the global middleware's isLocalDevAdminRequest already refuses when
 * NODE_ENV=production, and the requireAdmin-side isLocalDevAdminEnabled in
 * this module must do the same so a stray ELIZA_CLOUD_LOCAL_DEV_ADMIN /
 * LOCAL_DEV=true in a production deployment cannot mint a super_admin on a
 * loopback Host. Services are mocked; the real module under test decides.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("hono/cookie", () => ({
  getCookie: mock(() => null),
}));

mock.module("../services/api-keys", () => ({
  apiKeysService: {
    validateApiKey: mock(async () => null),
    incrementUsageDebounced: mock(async () => undefined),
  },
}));

mock.module("../services/users", () => ({
  usersService: {
    getWithOrganization: mock(async () => null),
    getByStewardId: mock(async () => null),
  },
}));

mock.module("../services/admin", () => ({
  adminService: {
    getAdminStatusForUser: mock(async () => ({ isAdmin: false, role: null })),
  },
}));

mock.module("./steward-client", () => ({
  isStagingSessionTokenCandidate: () => false,
  verifyStewardTokenCached: mock(async () => null),
}));

mock.module("./playwright-test-session", () => ({
  // Playwright path is inert in these tests (no cookie is ever presented);
  // the export must exist because workers-hono-auth imports it.
  isPlaywrightTestAuthEnabled: mock(() => false),
  PLAYWRIGHT_TEST_SESSION_COOKIE_NAME: "pw-test-session",
  verifyPlaywrightTestSessionToken: mock(() => null),
}));

const errorLog = mock(() => undefined);
mock.module("../utils/logger", () => ({
  logger: {
    error: errorLog,
    warn: mock(() => undefined),
  },
}));

const { requireAdmin } = await import("./workers-hono-auth");

function loopbackContext(env: Record<string, unknown>) {
  const state = new Map<string, unknown>();
  return {
    env,
    executionCtx: { waitUntil: mock(() => undefined) },
    req: {
      url: "http://localhost:8787/api/v1/admin/users",
      header: () => null,
    },
    get: (key: string) => state.get(key),
    set: (key: string, value: unknown) => state.set(key, value),
  };
}

beforeEach(() => {
  errorLog.mockClear();
});

describe("isLocalDevAdminEnabled production hard-fail", () => {
  test("NODE_ENV=production refuses the explicit dev-admin flag and never grants super_admin", async () => {
    const c = loopbackContext({
      NODE_ENV: "production",
      ELIZA_CLOUD_LOCAL_DEV_ADMIN: "true",
    });
    await expect(requireAdmin(c as never)).rejects.toMatchObject({
      status: 401,
    });
    expect(errorLog).toHaveBeenCalledTimes(1);
  });

  test("NODE_ENV=production refuses the LOCAL_DEV dev-mode flag", async () => {
    const c = loopbackContext({
      NODE_ENV: "production",
      LOCAL_DEV: "true",
    });
    await expect(requireAdmin(c as never)).rejects.toMatchObject({
      status: 401,
    });
    expect(errorLog).toHaveBeenCalledTimes(1);
  });

  test("outside production the loopback dev-admin bypass still works", async () => {
    const c = loopbackContext({
      NODE_ENV: "development",
      ELIZA_CLOUD_LOCAL_DEV_ADMIN: "true",
    });
    const { user, role } = await requireAdmin(c as never);
    expect(role).toBe("super_admin");
    expect(user.email).toBe("local-dev-admin@localhost");
  });
});
