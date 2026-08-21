/**
 * Pins the IAC entry shape guards against the real (mock-Redis) cache: positive
 * and rejection validators are mutually exclusive, so a hybrid entry carrying
 * both identity fields and a rejection decision is dropped as malformed instead
 * of resolving by field order into an authorization.
 */

process.env.MOCK_REDIS = "1";
process.env.CACHE_ENABLED = "true";

import { beforeEach, describe, expect, test } from "bun:test";

const { cache } = await import("../cache/client");
const { CacheKeys } = await import("../cache/keys");
const {
  INFERENCE_AUTH_CONTEXT_VERSION,
  hashApiKey,
  hashStewardUserId,
  invalidateInferenceAuthContextByKeyHash,
  invalidateInferenceSessionAuthContext,
  readInferenceAuthContextWithOutcome,
  readInferenceSessionAuthDecision,
  writeInferenceAuthContext,
  writeInferenceApiKeyAuthRejection,
  writeInferenceSessionAuthDecision,
} = await import("./inference-auth-cache");

const KEY_HASH = hashApiKey("eliza_validator_test_key");
const STEWARD_USER_ID = "steward-validator-1";
const ADMISSION = {
  balance: { balanceUsd: 100, balanceAt: 1, balanceRevision: "1" },
  rateLimits: {
    completionsRpm: 60,
    embeddingsRpm: 100,
    standardRpm: 30,
    strictRpm: 5,
    catalogVersion: "v1",
    entitlementVersion: "free:v1",
    manualOverrideVersion: null,
  },
};

beforeEach(async () => {
  await invalidateInferenceAuthContextByKeyHash(KEY_HASH);
  await invalidateInferenceSessionAuthContext(STEWARD_USER_ID);
});

describe("session decision validators", () => {
  test("a typed positive entry and a typed rejection both round-trip", async () => {
    await writeInferenceSessionAuthDecision({
      v: INFERENCE_AUTH_CONTEXT_VERSION,
      cachedAt: Date.now(),
      userId: "user-1",
      orgId: "org-1",
      apiKeyId: null,
      stewardUserId: STEWARD_USER_ID,
      admission: ADMISSION,
    });
    await expect(readInferenceSessionAuthDecision(STEWARD_USER_ID)).resolves.toMatchObject({
      userId: "user-1",
      orgId: "org-1",
      apiKeyId: null,
    });

    await writeInferenceSessionAuthDecision({
      v: INFERENCE_AUTH_CONTEXT_VERSION,
      cachedAt: Date.now(),
      stewardUserId: STEWARD_USER_ID,
      decision: "rejected",
      status: 401,
    });
    await expect(readInferenceSessionAuthDecision(STEWARD_USER_ID)).resolves.toMatchObject({
      decision: "rejected",
      status: 401,
    });
  });

  test("a hybrid entry (identity fields + rejection decision) is dropped, never authorized", async () => {
    const key = CacheKeys.inference.sessionAuthContext(hashStewardUserId(STEWARD_USER_ID));
    await cache.set(
      key,
      {
        v: INFERENCE_AUTH_CONTEXT_VERSION,
        cachedAt: Date.now(),
        userId: "user-1",
        orgId: "org-1",
        apiKeyId: null,
        stewardUserId: STEWARD_USER_ID,
        decision: "rejected",
        status: 403,
      },
      60,
    );

    await expect(readInferenceSessionAuthDecision(STEWARD_USER_ID)).resolves.toBeNull();
    // The malformed entry was evicted, not left behind for a later read.
    await expect(cache.get(key)).resolves.toBeNull();
  });
});

describe("api-key IAC validators", () => {
  test("a typed positive entry and a typed rejection both round-trip", async () => {
    await writeInferenceAuthContext({
      v: INFERENCE_AUTH_CONTEXT_VERSION,
      cachedAt: Date.now(),
      userId: "user-1",
      orgId: "org-1",
      apiKeyId: "key-1",
      keyHash: KEY_HASH,
      appScopeId: null,
      admission: ADMISSION,
    });
    await expect(readInferenceAuthContextWithOutcome(KEY_HASH)).resolves.toMatchObject({
      kind: "hit",
      ctx: { apiKeyId: "key-1", orgId: "org-1" },
    });

    await writeInferenceApiKeyAuthRejection(KEY_HASH, "suspended", 403);
    await expect(readInferenceAuthContextWithOutcome(KEY_HASH)).resolves.toMatchObject({
      kind: "rejected",
      decision: "suspended",
      status: 403,
    });
  });

  test("a hybrid entry (identity fields + rejection decision) reads as invalid, never a hit", async () => {
    const key = CacheKeys.inference.authContext(KEY_HASH);
    await cache.set(
      key,
      {
        v: INFERENCE_AUTH_CONTEXT_VERSION,
        cachedAt: Date.now(),
        userId: "user-1",
        orgId: "org-1",
        apiKeyId: "key-1",
        keyHash: KEY_HASH,
        decision: "rejected",
        status: 401,
      },
      60,
    );

    await expect(readInferenceAuthContextWithOutcome(KEY_HASH)).resolves.toMatchObject({
      kind: "invalid",
    });
    await expect(cache.get(key)).resolves.toBeNull();
  });

  test("an admission snapshot with an old catalog fence is invalid and evicted", async () => {
    const key = CacheKeys.inference.authContext(KEY_HASH);
    await cache.set(
      key,
      {
        v: INFERENCE_AUTH_CONTEXT_VERSION,
        cachedAt: Date.now(),
        userId: "user-1",
        orgId: "org-1",
        apiKeyId: "key-1",
        keyHash: KEY_HASH,
        appScopeId: null,
        admission: {
          ...ADMISSION,
          rateLimits: { ...ADMISSION.rateLimits, catalogVersion: "v0" },
        },
      },
      60,
    );

    await expect(readInferenceAuthContextWithOutcome(KEY_HASH)).resolves.toMatchObject({
      kind: "invalid",
    });
    await expect(cache.get(key)).resolves.toBeNull();
  });
});
