/**
 * Exercises the inference API-key boundary's exact 401/403 taxonomy and direct
 * authoritative-storage contract with deterministic seams; no live credentials or DB.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { createHash } from "node:crypto";

let apiKeyRecord: Record<string, unknown> | null;
let userRecord: Record<string, unknown> | undefined;
let repositoryError: Error | null;
const validationCalls: string[] = [];
const serviceUserLookups: string[] = [];
const repositoryKeyLookups: string[] = [];
const repositoryUserLookups: string[] = [];
const usageCalls: string[] = [];

mock.module("../db/repositories/api-keys", () => ({
  apiKeysRepository: {
    findByHashConsistent: async (keyHash: string) => {
      repositoryKeyLookups.push(keyHash);
      if (repositoryError) throw repositoryError;
      return apiKeyRecord;
    },
  },
}));
mock.module("../db/repositories/users", () => ({
  usersRepository: {
    findWithOrganizationForWrite: async (userId: string) => {
      repositoryUserLookups.push(userId);
      return userRecord;
    },
  },
}));
mock.module("./services/api-keys", () => ({
  apiKeysService: {
    validateApiKey: async (rawKey: string) => {
      validationCalls.push(rawKey);
      return apiKeyRecord;
    },
    incrementUsageDebounced: async (id: string) => {
      usageCalls.push(id);
    },
  },
}));
mock.module("./services/users", () => ({
  usersService: {
    getWithOrganization: async (userId: string) => {
      serviceUserLookups.push(userId);
      return userRecord;
    },
  },
}));

const { requireInferenceApiKeyWithOrg } = await import("./services/inference-api-key-auth");

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
  repositoryError = null;
  validationCalls.length = 0;
  serviceUserLookups.length = 0;
  repositoryKeyLookups.length = 0;
  repositoryUserLookups.length = 0;
  usageCalls.length = 0;
});

describe("requireInferenceApiKeyWithOrg", () => {
  test("invalid key remains the existing 401 authentication error", async () => {
    apiKeyRecord = null;
    const rejected: string[] = [];
    await expect(
      requireInferenceApiKeyWithOrg("eliza_invalid", {
        rejected: (reason) => rejected.push(reason),
      }),
    ).rejects.toMatchObject({
      name: "AuthenticationError",
      status: 401,
      code: "authentication_required",
      message: "Invalid or expired API key",
    });
    expect(rejected).toEqual(["credential_invalid"]);
    expect(usageCalls).toEqual([]);
  });

  test("inactive user remains the existing 403 access error", async () => {
    userRecord = { ...userRecord, is_active: false };
    const rejected: string[] = [];
    await expect(
      requireInferenceApiKeyWithOrg("eliza_valid", {
        rejected: (reason) => rejected.push(reason),
      }),
    ).rejects.toMatchObject({
      name: "ForbiddenError",
      status: 403,
      code: "access_denied",
      message: "User account is inactive",
    });
    expect(rejected).toEqual(["account_inactive"]);
    expect(usageCalls).toEqual([]);
  });

  test("inactive organization remains the existing 403 access error", async () => {
    userRecord = {
      ...userRecord,
      organization: { ...activeOrganization, is_active: false },
    };
    const rejected: string[] = [];
    await expect(
      requireInferenceApiKeyWithOrg("eliza_valid", {
        rejected: (reason) => rejected.push(reason),
      }),
    ).rejects.toMatchObject({
      name: "ForbiddenError",
      status: 403,
      code: "access_denied",
      message: "Organization is inactive",
    });
    expect(rejected).toEqual(["organization_inactive"]);
    expect(usageCalls).toEqual([]);
  });

  test("authoritative inference auth skips secondary service caches", async () => {
    const keyTimings: number[] = [];
    const userTimings: number[] = [];
    const result = await requireInferenceApiKeyWithOrg("eliza_valid", {
      timing: {
        keyLookup: (durationMs) => keyTimings.push(durationMs),
        userOrgLookup: (durationMs) => userTimings.push(durationMs),
      },
    });

    expect(result.authMethod).toBe("api_key");
    expect(result.user.id).toBe("user-1");
    const keyHash = createHash("sha256").update("eliza_valid").digest("hex");
    expect(validationCalls).toEqual([]);
    expect(serviceUserLookups).toEqual([]);
    expect(repositoryKeyLookups).toEqual([keyHash]);
    expect(repositoryUserLookups).toEqual(["user-1"]);
    expect(keyTimings).toHaveLength(1);
    expect(userTimings).toHaveLength(1);
    expect(usageCalls).toEqual(["key-1"]);
  });

  test("inactive API key returns the authoritative standing reason", async () => {
    apiKeyRecord = { ...apiKeyRecord, is_active: false };
    const rejected: string[] = [];
    await expect(
      requireInferenceApiKeyWithOrg("eliza_valid", {
        rejected: (reason) => rejected.push(reason),
      }),
    ).rejects.toMatchObject({
      status: 403,
      message: "API key is inactive",
    });
    expect(rejected).toEqual(["credential_inactive"]);
    expect(repositoryUserLookups).toEqual([]);
    expect(usageCalls).toEqual([]);
  });

  test("expired API key remains invalid even when it is also inactive", async () => {
    apiKeyRecord = {
      ...apiKeyRecord,
      is_active: false,
      expires_at: new Date(Date.now() - 1_000),
    };
    const rejected: string[] = [];
    await expect(
      requireInferenceApiKeyWithOrg("eliza_valid", {
        rejected: (reason) => rejected.push(reason),
      }),
    ).rejects.toMatchObject({ status: 401, message: "API key has expired" });
    expect(rejected).toEqual(["credential_invalid"]);
    expect(repositoryUserLookups).toEqual([]);
    expect(usageCalls).toEqual([]);
  });

  test("deleted API key remains invalid instead of exposing lifecycle state", async () => {
    apiKeyRecord = {
      ...apiKeyRecord,
      is_active: false,
      deleted_at: new Date(),
    };
    const rejected: string[] = [];
    await expect(
      requireInferenceApiKeyWithOrg("eliza_valid", {
        rejected: (reason) => rejected.push(reason),
      }),
    ).rejects.toMatchObject({ status: 401, message: "Invalid or expired API key" });
    expect(rejected).toEqual(["credential_invalid"]);
    expect(repositoryUserLookups).toEqual([]);
    expect(usageCalls).toEqual([]);
  });

  test("missing organization membership is not mislabeled as organization inactivity", async () => {
    userRecord = { ...userRecord, organization_id: null, organization: null };
    const rejected: string[] = [];
    await expect(
      requireInferenceApiKeyWithOrg("eliza_valid", {
        rejected: (reason) => rejected.push(reason),
      }),
    ).rejects.toMatchObject({
      status: 403,
      message: "This feature requires a full account. Please sign up to continue.",
    });
    expect(rejected).toEqual(["membership_missing"]);
    expect(usageCalls).toEqual([]);
  });

  test("storage outage propagates and is not mislabeled as a credential rejection", async () => {
    repositoryError = new Error("database unavailable");
    let rejected = false;
    await expect(
      requireInferenceApiKeyWithOrg("eliza_valid", {
        rejected: () => {
          rejected = true;
        },
      }),
    ).rejects.toThrow("database unavailable");
    expect(rejected).toBe(false);
    expect(usageCalls).toEqual([]);
  });
});
