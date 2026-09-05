/**
 * Exercises moderation ban/unban transitions through the real AdminService and
 * real mock-Redis inference cache. Only database and strong-fence boundaries
 * are deterministic substitutes; cached API-key and Steward-session decisions
 * are written, invalidated, and refreshed through their production helpers.
 */

process.env.MOCK_REDIS = "1";
process.env.CACHE_ENABLED = "true";

import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";

const USER_ID = "user-1";
const ORG_ID = "org-1";
const KEY_HASH = "a".repeat(64);
const KEY_ID = "key-1";
const STEWARD_USER_ID = "steward-user-1";

const lifecycleEvents: string[] = [];
let replicaModerationStatus = "banned";
let primaryModerationStatus = "banned";
let subjectFenceError: Error | null = null;

function moderationRecord(status: string | null) {
  return status
    ? {
        status,
        totalViolations: 0,
        warningCount: 0,
        riskScore: status === "banned" ? 100 : 0,
        lastWarningAt: null,
      }
    : undefined;
}

mock.module("../../db/client", () => ({
  dbRead: {
    query: {
      userModerationStatus: {
        findFirst: async () => moderationRecord(replicaModerationStatus),
      },
      users: {
        findFirst: async () => ({
          id: USER_ID,
          organization_id: "stale-replica-org",
          steward_user_id: "stale-replica-steward-user",
        }),
      },
    },
  },
  dbWrite: {
    query: {
      userModerationStatus: {
        findFirst: async () => moderationRecord(primaryModerationStatus),
      },
      users: {
        findFirst: async () => ({
          id: USER_ID,
          organization_id: ORG_ID,
          steward_user_id: STEWARD_USER_ID,
        }),
      },
    },
    insert: () => ({
      values: async (data: { status?: string }) => {
        primaryModerationStatus = data.status ?? primaryModerationStatus;
        lifecycleEvents.push(`db:${primaryModerationStatus}`);
      },
    }),
    update: () => ({
      set: (data: { status?: string }) => ({
        where: async () => {
          primaryModerationStatus = data.status ?? primaryModerationStatus;
          lifecycleEvents.push(`db:${primaryModerationStatus}`);
        },
      }),
    }),
  },
}));

mock.module("../../db/repositories", () => ({
  apiKeysRepository: {
    listByUser: async () => [],
    listByUserConsistent: async () => [{ key_hash: KEY_HASH }],
  },
  organizationsRepository: {},
  usersRepository: {},
}));

mock.module("./inference-credential-revocation", () => ({
  setInferenceSubjectActive: async (
    organizationId: string,
    userId: string,
    active: boolean,
    reason: string,
  ) => {
    lifecycleEvents.push(`fence:${organizationId}:${userId}:${active}:${reason}`);
    if (subjectFenceError) throw subjectFenceError;
  },
}));

mock.module("./outbound-message-standing", () => ({
  invalidateOutboundMessageStanding: async (organizationId: string, userId: string) => {
    lifecycleEvents.push(`outbound:${organizationId}:${userId}`);
    return true;
  },
}));

const { cache } = await import("../cache/client");
const {
  INFERENCE_AUTH_CONTEXT_VERSION,
  invalidateInferenceAuthContextByKeyHash,
  invalidateInferenceSessionAuthContext,
  readInferenceAuthContextWithOutcome,
  readInferenceSessionAuthDecision,
  writeInferenceApiKeyAuthRejection,
  writeInferenceAuthContext,
  writeInferenceSessionAuthDecision,
} = await import("./inference-auth-cache");
const { adminService } = await import("./admin");

const admission = {
  subscriptionFunded: false,
  balance: { balanceUsd: 5, balanceAt: 1, balanceRevision: "0" },
  rateLimits: {
    completionsRpm: 60,
    embeddingsRpm: 100,
    standardRpm: 30,
    strictRpm: 5,
  },
};

async function seedModerationDenials(): Promise<void> {
  await writeInferenceApiKeyAuthRejection(KEY_HASH, "suspended", 403, "moderation_blocked");
  await writeInferenceSessionAuthDecision({
    v: INFERENCE_AUTH_CONTEXT_VERSION,
    cachedAt: Date.now(),
    stewardUserId: STEWARD_USER_ID,
    decision: "suspended",
    status: 403,
    reason: "moderation_blocked",
  });
}

async function expectModerationDenials(): Promise<void> {
  await expect(readInferenceAuthContextWithOutcome(KEY_HASH)).resolves.toMatchObject({
    kind: "rejected",
    decision: "suspended",
    reason: "moderation_blocked",
  });
  await expect(readInferenceSessionAuthDecision(STEWARD_USER_ID)).resolves.toMatchObject({
    decision: "suspended",
    reason: "moderation_blocked",
  });
}

async function expectInferenceCachesEmpty(): Promise<void> {
  await expect(readInferenceAuthContextWithOutcome(KEY_HASH)).resolves.toMatchObject({
    kind: "miss",
  });
  await expect(readInferenceSessionAuthDecision(STEWARD_USER_ID)).resolves.toBeNull();
}

beforeEach(async () => {
  lifecycleEvents.length = 0;
  replicaModerationStatus = "banned";
  primaryModerationStatus = "banned";
  subjectFenceError = null;
  await invalidateInferenceAuthContextByKeyHash(KEY_HASH);
  await invalidateInferenceSessionAuthContext(STEWARD_USER_ID);
});

afterEach(() => {
  mock.restore();
});

describe("AdminService moderation cache transitions", () => {
  test("authorization standing ignores a stale moderation replica", async () => {
    replicaModerationStatus = "banned";
    primaryModerationStatus = "clean";

    await expect(adminService.shouldBlockUser(USER_ID)).resolves.toBe(true);
    await expect(adminService.shouldBlockUserConsistent(USER_ID)).resolves.toBe(false);
  });

  test("unban evicts API-key and session denials before the next authorized refresh", async () => {
    await seedModerationDenials();
    await expectModerationDenials();

    await adminService.unbanUser(USER_ID, "admin-1");

    await expectInferenceCachesEmpty();
    await expect(adminService.shouldBlockUserConsistent(USER_ID)).resolves.toBe(false);
    expect(lifecycleEvents.indexOf("db:clean")).toBeLessThan(
      lifecycleEvents.indexOf(`fence:${ORG_ID}:${USER_ID}:true:moderation`),
    );

    await writeInferenceAuthContext({
      v: INFERENCE_AUTH_CONTEXT_VERSION,
      cachedAt: Date.now(),
      userId: USER_ID,
      orgId: ORG_ID,
      apiKeyId: KEY_ID,
      keyHash: KEY_HASH,
      appScopeId: null,
      admission,
    });
    await writeInferenceSessionAuthDecision({
      v: INFERENCE_AUTH_CONTEXT_VERSION,
      cachedAt: Date.now(),
      userId: USER_ID,
      orgId: ORG_ID,
      apiKeyId: null,
      stewardUserId: STEWARD_USER_ID,
      admission,
    });

    await expect(readInferenceAuthContextWithOutcome(KEY_HASH)).resolves.toMatchObject({
      kind: "hit",
      ctx: { userId: USER_ID, orgId: ORG_ID, apiKeyId: KEY_ID },
    });
    await expect(readInferenceSessionAuthDecision(STEWARD_USER_ID)).resolves.toMatchObject({
      userId: USER_ID,
      orgId: ORG_ID,
      apiKeyId: null,
    });
  });

  test("ban then unban invalidates both sides of the standing transition", async () => {
    replicaModerationStatus = "clean";
    primaryModerationStatus = "clean";
    await writeInferenceAuthContext({
      v: INFERENCE_AUTH_CONTEXT_VERSION,
      cachedAt: Date.now(),
      userId: USER_ID,
      orgId: ORG_ID,
      apiKeyId: KEY_ID,
      keyHash: KEY_HASH,
      appScopeId: null,
      admission,
    });
    await writeInferenceSessionAuthDecision({
      v: INFERENCE_AUTH_CONTEXT_VERSION,
      cachedAt: Date.now(),
      userId: USER_ID,
      orgId: ORG_ID,
      apiKeyId: null,
      stewardUserId: STEWARD_USER_ID,
      admission,
    });

    await adminService.banUser({ userId: USER_ID, adminUserId: "admin-1", reason: "test" });
    await expectInferenceCachesEmpty();
    await seedModerationDenials();
    await adminService.unbanUser(USER_ID, "admin-1");
    await expectInferenceCachesEmpty();

    expect(lifecycleEvents.filter((event) => event.startsWith("fence:"))).toEqual([
      `fence:${ORG_ID}:${USER_ID}:false:moderation`,
      `fence:${ORG_ID}:${USER_ID}:true:moderation`,
    ]);
  });

  test.each([
    ["iac:auth:", /auth-context invalidation not confirmed/i],
    ["iac:session-auth:", /session auth-context invalidation not confirmed/i],
  ])("unban fails explicitly when %s cannot be invalidated", async (failedPrefix, failure) => {
    await seedModerationDenials();
    const originalDelete = cache.delConfirmed.bind(cache);
    const attemptedKeys: string[] = [];
    const deleteSpy = spyOn(cache, "delConfirmed").mockImplementation(async (key, options) => {
      attemptedKeys.push(key);
      lifecycleEvents.push(`cache:${key}`);
      if (key.startsWith(failedPrefix)) return false;
      return await originalDelete(key, options);
    });

    await expect(adminService.unbanUser(USER_ID, "admin-1")).rejects.toThrow(failure);
    expect(attemptedKeys.some((key) => key.startsWith("iac:auth:"))).toBe(true);
    expect(attemptedKeys.some((key) => key.startsWith("iac:session-auth:"))).toBe(true);
    const fenceIndex = lifecycleEvents.indexOf(`fence:${ORG_ID}:${USER_ID}:true:moderation`);
    expect(lifecycleEvents.indexOf("db:clean")).toBeLessThan(fenceIndex);
    expect(lifecycleEvents.findIndex((event) => event.startsWith("cache:"))).toBeGreaterThan(
      fenceIndex,
    );
    deleteSpy.mockRestore();
  });

  test("strong-fence failure leaves cached denials intact and skips invalidation", async () => {
    await seedModerationDenials();
    subjectFenceError = new Error("strong fence unavailable");
    const deleteSpy = spyOn(cache, "delConfirmed");

    await expect(adminService.unbanUser(USER_ID, "admin-1")).rejects.toThrow(
      "strong fence unavailable",
    );

    expect(deleteSpy).not.toHaveBeenCalled();
    await expectModerationDenials();
    expect(lifecycleEvents).toEqual(["db:clean", `fence:${ORG_ID}:${USER_ID}:true:moderation`]);
    deleteSpy.mockRestore();
  });
});
