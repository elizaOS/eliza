/**
 * Exercises the inference API-key boundary's exact 401/403 taxonomy and cache
 * bypass contract with deterministic service seams; no live credentials or DB.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

let apiKeyRecord: Record<string, unknown> | null;
let userRecord: Record<string, unknown> | undefined;
let validationError: Error | null;
const validationOptions: Array<{ bypassCache?: boolean }> = [];
const userLookupOptions: Array<{ bypassCache?: boolean }> = [];
const usageCalls: string[] = [];

mock.module("./cache/client", () => ({
  cache: {
    get: async () => null,
    set: async () => undefined,
    del: async () => undefined,
  },
}));
mock.module("./auth/steward-client", () => ({
  verifyStewardTokenCached: async () => null,
  invalidateStewardTokenCache: async () => undefined,
}));
mock.module("./auth/playwright-test-session", () => ({
  isPlaywrightTestAuthEnabled: () => false,
  verifyPlaywrightTestSessionToken: () => null,
  PLAYWRIGHT_TEST_SESSION_COOKIE_NAME: "pw-test-session",
}));
mock.module("./auth/wallet-auth", () => ({
  verifyWalletSignature: async () => false,
}));
mock.module("./services/admin", () => ({ adminService: {} }));
mock.module("./services/user-sessions", () => ({
  userSessionsService: { getOrCreateSession: async () => undefined },
}));
mock.module("./steward-sync", () => ({
  ensureDefaultCharacter: async () => undefined,
  syncUserFromSteward: async () => undefined,
}));
mock.module("./services/api-keys", () => ({
  apiKeysService: {
    validateApiKey: async (_rawKey: string, options: { bypassCache?: boolean } = {}) => {
      validationOptions.push(options);
      if (validationError) throw validationError;
      return apiKeyRecord;
    },
    incrementUsageDebounced: async (id: string) => {
      usageCalls.push(id);
    },
  },
}));
mock.module("./services/users", () => ({
  usersService: {
    getWithOrganization: async (_userId: string, options: { bypassCache?: boolean } = {}) => {
      userLookupOptions.push(options);
      return userRecord;
    },
  },
}));

const { requireApiKeyWithOrg } = await import("./auth");

const activeOrganization = {
  id: "org-1",
  name: "Test Organization",
  slug: "test-organization",
  is_active: true,
};

beforeEach(() => {
  apiKeyRecord = {
    id: "key-1",
    user_id: "user-1",
    organization_id: "org-1",
    is_active: true,
    expires_at: null,
  };
  userRecord = {
    id: "user-1",
    organization_id: "org-1",
    is_active: true,
    organization: activeOrganization,
  };
  validationError = null;
  validationOptions.length = 0;
  userLookupOptions.length = 0;
  usageCalls.length = 0;
});

describe("requireApiKeyWithOrg inference boundary", () => {
  test("invalid key remains the existing 401 authentication error", async () => {
    apiKeyRecord = null;
    let rejected = false;
    await expect(
      requireApiKeyWithOrg("eliza_invalid", {
        rejected: () => {
          rejected = true;
        },
      }),
    ).rejects.toMatchObject({
      name: "AuthenticationError",
      status: 401,
      code: "authentication_required",
      message: "Invalid or expired API key",
    });
    expect(rejected).toBe(true);
    expect(usageCalls).toEqual([]);
  });

  test("inactive user remains the existing 403 access error", async () => {
    userRecord = { ...userRecord, is_active: false };
    let rejected = false;
    await expect(
      requireApiKeyWithOrg("eliza_valid", {
        rejected: () => {
          rejected = true;
        },
      }),
    ).rejects.toMatchObject({
      name: "ForbiddenError",
      status: 403,
      code: "access_denied",
      message: "User account is inactive",
    });
    expect(rejected).toBe(true);
    expect(usageCalls).toEqual([]);
  });

  test("inactive organization remains the existing 403 access error", async () => {
    userRecord = {
      ...userRecord,
      organization: { ...activeOrganization, is_active: false },
    };
    await expect(requireApiKeyWithOrg("eliza_valid")).rejects.toMatchObject({
      name: "ForbiddenError",
      status: 403,
      code: "access_denied",
      message: "Organization is inactive",
    });
    expect(usageCalls).toEqual([]);
  });

  test("cache bypass reaches validation and user/org lookup without changing usage accounting", async () => {
    const keyTimings: number[] = [];
    const userTimings: number[] = [];
    const result = await requireApiKeyWithOrg("eliza_valid", {
      bypassCache: true,
      timing: {
        keyLookup: (durationMs) => keyTimings.push(durationMs),
        userOrgLookup: (durationMs) => userTimings.push(durationMs),
      },
    });

    expect(result.authMethod).toBe("api_key");
    expect(result.user.id).toBe("user-1");
    expect(validationOptions).toEqual([{ bypassCache: true }]);
    expect(userLookupOptions).toEqual([{ bypassCache: true }]);
    expect(keyTimings).toHaveLength(1);
    expect(userTimings).toHaveLength(1);
    expect(usageCalls).toEqual(["key-1"]);
  });

  test("storage outage propagates and is not mislabeled as a credential rejection", async () => {
    validationError = new Error("database unavailable");
    let rejected = false;
    await expect(
      requireApiKeyWithOrg("eliza_valid", {
        bypassCache: true,
        rejected: () => {
          rejected = true;
        },
      }),
    ).rejects.toThrow("database unavailable");
    expect(rejected).toBe(false);
    expect(usageCalls).toEqual([]);
  });
});
