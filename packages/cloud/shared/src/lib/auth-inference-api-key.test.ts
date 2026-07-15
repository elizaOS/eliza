/**
 * Exercises the inference API-key boundary's exact 401/403 taxonomy and cache
 * bypass contract with deterministic service seams; no live credentials or DB.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { createHash } from "node:crypto";

let apiKeyRecord: Record<string, unknown> | null;
let userRecord: Record<string, unknown> | undefined;
let repositoryError: Error | null;
let replicaMiss: boolean;
const validationCalls: string[] = [];
const serviceUserLookups: string[] = [];
const repositoryKeyLookups: string[] = [];
const consistentKeyLookups: string[] = [];
const repositoryUserLookups: string[] = [];
const usageCalls: string[] = [];

mock.module("../db/repositories/api-keys", () => ({
  apiKeysRepository: {
    findActiveByHash: async (keyHash: string) => {
      repositoryKeyLookups.push(keyHash);
      if (repositoryError) throw repositoryError;
      return replicaMiss ? undefined : apiKeyRecord;
    },
    findActiveByHashConsistent: async (keyHash: string) => {
      consistentKeyLookups.push(keyHash);
      return apiKeyRecord;
    },
  },
}));
mock.module("../db/repositories/users", () => ({
  usersRepository: {
    findWithOrganization: async (userId: string) => {
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
  replicaMiss = false;
  validationCalls.length = 0;
  serviceUserLookups.length = 0;
  repositoryKeyLookups.length = 0;
  consistentKeyLookups.length = 0;
  repositoryUserLookups.length = 0;
  usageCalls.length = 0;
});

describe("requireInferenceApiKeyWithOrg", () => {
  test("invalid key remains the existing 401 authentication error", async () => {
    apiKeyRecord = null;
    let rejected = false;
    await expect(
      requireInferenceApiKeyWithOrg("eliza_invalid", {
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
      requireInferenceApiKeyWithOrg("eliza_valid", {
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
    await expect(requireInferenceApiKeyWithOrg("eliza_valid")).rejects.toMatchObject({
      name: "ForbiddenError",
      status: 403,
      code: "access_denied",
      message: "Organization is inactive",
    });
    expect(usageCalls).toEqual([]);
  });

  test("cache bypass reaches repositories without changing usage accounting", async () => {
    const keyTimings: number[] = [];
    const userTimings: number[] = [];
    const result = await requireInferenceApiKeyWithOrg("eliza_valid", {
      bypassCache: true,
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
    expect(consistentKeyLookups).toEqual([]);
    expect(repositoryUserLookups).toEqual(["user-1"]);
    expect(keyTimings).toHaveLength(1);
    expect(userTimings).toHaveLength(1);
    expect(usageCalls).toEqual(["key-1"]);
  });

  test("cache bypass confirms a replica miss against the primary", async () => {
    replicaMiss = true;
    const result = await requireInferenceApiKeyWithOrg("eliza_valid", {
      bypassCache: true,
    });
    const keyHash = createHash("sha256").update("eliza_valid").digest("hex");

    expect(result.user.id).toBe("user-1");
    expect(repositoryKeyLookups).toEqual([keyHash]);
    expect(consistentKeyLookups).toEqual([keyHash]);
    expect(repositoryUserLookups).toEqual(["user-1"]);
    expect(usageCalls).toEqual(["key-1"]);
  });

  test("storage outage propagates and is not mislabeled as a credential rejection", async () => {
    repositoryError = new Error("database unavailable");
    let rejected = false;
    await expect(
      requireInferenceApiKeyWithOrg("eliza_valid", {
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
