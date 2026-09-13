/**
 * Measures the warm inference authentication path with the real in-memory
 * CacheClient and deterministic boundary mocks. A fully authorized API-key
 * request must use one cache read, one strong-revocation check, and no
 * authoritative authentication or moderation reads. A positive cache hit also
 * reads current primary policy once; policy storage and admission are mocked.
 */

process.env.MOCK_REDIS = "1";
process.env.CACHE_ENABLED = "true";
// This benchmark measures the STAGED cache-on auth path. The flag is
// default-off in every checked-in environment (wrangler.toml) until #17093
// lands a strongly consistent revocation boundary; enabling it here exercises
// the gated single-cache-read contract without changing any shipped default.
const originalAuthCacheFlag = process.env.INFERENCE_AUTH_CACHE_ENABLED;
const originalStrongRevocationFlag = process.env.INFERENCE_STRONG_REVOCATION_ENABLED;
process.env.INFERENCE_AUTH_CACHE_ENABLED = "true";
process.env.INFERENCE_STRONG_REVOCATION_ENABLED = "true";

import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { InferenceAdmissionSnapshot } from "./inference-auth-cache";
import type { OrganizationPolicyStamp, OrganizationQuotaPolicy } from "./organization-quota-policy";
import * as quotaActual from "./organization-quota-policy";

const quotaSnapshot = { ...quotaActual };

let authChainCalls = 0;
let moderationCalls = 0;
let usageCalls = 0;
let admissionLoadCalls = 0;
let primaryPolicyReads = 0;
let policyAdmissionCalls = 0;
let appScopeCalls = 0;
let revocationBoundaryCalls = 0;

// Admission and app scope hydrate on cold misses. Positive warm reads still
// consult primary policy authority before trusting the cached projection.
const ADMISSION: InferenceAdmissionSnapshot = {
  authority: {
    generation: "0",
    source: "legacy",
    sourceSubscriptionId: null,
    sourceRevision: null,
    projectionRevision: null,
    catalogVersion: null,
    effectiveFrom: "2026-01-01T00:00:00.000Z",
    effectiveUntil: null,
  },
  subscriptionFunded: false,
  balance: { balanceUsd: 100, balanceAt: 1, balanceRevision: "1" },
  rateLimits: {
    completionsRpm: 60,
    embeddingsRpm: 100,
    standardRpm: 30,
    strictRpm: 5,
  },
};

const POLICY: OrganizationQuotaPolicy = {
  authority: ADMISSION.authority,
  tier: { status: "available", value: { tierName: "fixture", ...ADMISSION.rateLimits } },
  subscriptionFunded: ADMISSION.subscriptionFunded,
  tierSourceCreditTotal: "0",
  overrides: { completionsRpm: null, embeddingsRpm: null, standardRpm: null, strictRpm: null },
  limits: {
    characters: { status: "unavailable", code: "outside_test_scope" },
    nonEagerSandboxes: { status: "unavailable", code: "outside_test_scope" },
    sandboxes: { status: "unavailable", code: "outside_test_scope" },
    containers: { status: "unavailable", code: "outside_test_scope" },
    apps: { status: "unavailable", code: "outside_test_scope" },
    storage: { status: "unavailable", code: "outside_test_scope" },
  },
  observedAt: new Date(ADMISSION.balance.balanceAt).toISOString(),
  balance: {
    status: "available",
    value: {
      balanceUsd: ADMISSION.balance.balanceUsd,
      revision: ADMISSION.balance.balanceRevision,
    },
  },
};

// Cache behavior is real; primary policy reads and admission transactions are
// controlled boundaries. Migrated lifecycle tests own locking and publication.
mock.module("./organization-quota-policy", () => ({
  ...quotaSnapshot,
  readOrganizationQuotaPolicy: async () => {
    primaryPolicyReads++;
    return POLICY;
  },
  requireOrganizationRateTier: (policy: OrganizationQuotaPolicy) => {
    if (policy.tier.status !== "available") throw new Error("Fixture rate tier unavailable");
    return policy.tier.value;
  },
}));
mock.module("./organization-policy-admission", () => ({
  withOrganizationPolicyAdmission: async <T>(
    _orgId: string,
    _authority: OrganizationPolicyStamp | undefined,
    action: (policy: OrganizationQuotaPolicy) => Promise<T>,
  ): Promise<T> => {
    policyAdmissionCalls++;
    return action(POLICY);
  },
}));

mock.module("./inference-admission-snapshot", () => ({
  inferenceAdmissionSnapshotFromPolicy: (_policy: OrganizationQuotaPolicy) => ADMISSION,
  loadInferenceAdmissionSnapshot: async () => {
    admissionLoadCalls++;
    return ADMISSION;
  },
}));
mock.module("./inference-app-key-scope", () => ({
  loadInferenceAppKeyScope: async () => {
    appScopeCalls++;
    return null;
  },
}));
mock.module("./inference-credential-revocation", () => ({
  // `mock.module` is process-global: a partial mock of this module also
  // replaces it for every other file in the same Bun process, so an export
  // omitted here becomes a SyntaxError in whichever co-batched suite needs it.
  // `inference-auth-context.ts` and `proxy/engine.ts` both import this one.
  inferenceCredentialRevocationReason: (reason: string) => {
    if (reason === "credential_revoked") return "credential_inactive";
    if (reason === "organization_disabled") return "organization_inactive";
    return "credential_invalid";
  },
  isInferenceStrongRevocationEnabled: () =>
    process.env.INFERENCE_STRONG_REVOCATION_ENABLED === "true",
  InferenceCredentialRevokedError: class InferenceCredentialRevokedError extends Error {},
  inferenceCredentialRevocationReason: (reason: string) => {
    switch (reason) {
      case "organization_disabled":
        return "organization_inactive";
      case "subject_account_disabled":
        return "account_inactive";
      case "subject_membership_disabled":
        return "membership_missing";
      case "subject_moderation_disabled":
        return "moderation_blocked";
      case "credential_revoked":
        return "credential_inactive";
      default:
        return "credential_invalid";
    }
  },
  assertInferenceCredentialActive: async () => {
    revocationBoundaryCalls++;
  },
  revokeInferenceApiKey: async () => undefined,
  setInferenceSessionBindingActive: async () => undefined,
  revokeInferenceSessionsThrough: async () => undefined,
  setInferenceOrganizationActive: async () => undefined,
  setInferenceSubjectActive: async () => undefined,
}));

mock.module("./inference-api-key-auth", () => ({
  requireInferenceApiKeyWithOrg: async () => {
    authChainCalls++;
    return {
      user: { id: "user-bench", organization_id: "org-bench" },
      apiKey: { id: "key-bench" },
    };
  },
}));
mock.module("./admin", () => ({
  adminService: {
    shouldBlockUserConsistent: async () => {
      moderationCalls++;
      return false;
    },
    shouldBlockUser: async () => {
      throw new Error("Inference refresh must not use cached moderation standing");
    },
  },
}));
mock.module("./content-moderation", () => ({
  contentModerationService: {
    shouldBlockUser: async () => {
      throw new Error("Inference refresh must use primary admin moderation authority");
    },
  },
}));
mock.module("./api-keys", () => ({
  apiKeysService: {
    incrementUsageDebounced: async () => {
      usageCalls++;
    },
  },
  isMobileApiKeySecret: () => false,
}));
const { resolveInferenceAuthContext } = await import("./inference-auth-context");
const { hashApiKey, invalidateInferenceAuthContextByKeyHash, writeInferenceApiKeyAuthRejection } =
  await import("./inference-auth-cache");
const { cache } = await import("../cache/client");

const KEY = "eliza_bench_key";
function req(): Request {
  return new Request("https://api/api/v1/chat/completions", {
    method: "POST",
    headers: { "X-API-Key": KEY },
  });
}

beforeEach(async () => {
  authChainCalls = 0;
  moderationCalls = 0;
  usageCalls = 0;
  admissionLoadCalls = 0;
  primaryPolicyReads = 0;
  policyAdmissionCalls = 0;
  appScopeCalls = 0;
  revocationBoundaryCalls = 0;
  await invalidateInferenceAuthContextByKeyHash(hashApiKey(KEY));
});

afterEach(() => {
  mock.restore();
});

// Cloud-shared test files can share one bun process; leaving the staged flag
// enabled would silently flip later files onto the cache-on path.
afterAll(() => {
  mock.module("./organization-quota-policy", () => quotaSnapshot);
  if (originalAuthCacheFlag === undefined) {
    delete process.env.INFERENCE_AUTH_CACHE_ENABLED;
  } else {
    process.env.INFERENCE_AUTH_CACHE_ENABLED = originalAuthCacheFlag;
  }
  if (originalStrongRevocationFlag === undefined) {
    delete process.env.INFERENCE_STRONG_REVOCATION_ENABLED;
  } else {
    process.env.INFERENCE_STRONG_REVOCATION_ENABLED = originalStrongRevocationFlag;
  }
});

describe("inference hot-path benchmark", () => {
  test("cold miss performs one combined cache read before authoritative hydration", async () => {
    const getSpy = spyOn(cache, "getWithOutcome");
    const cold = await resolveInferenceAuthContext(req());
    expect(cold.kind).toBe("authorized");
    expect(getSpy).toHaveBeenCalledTimes(1);
    expect(authChainCalls).toBe(1); // one auth chain
    expect(moderationCalls).toBe(1); // one moderation read
    expect(primaryPolicyReads).toBe(0);
    expect(policyAdmissionCalls).toBe(1);
    expect(admissionLoadCalls).toBe(1); // one admission projection load (IAC v2)
    expect(appScopeCalls).toBe(1); // one app-key scope load (IAC v2)
    expect(revocationBoundaryCalls).toBe(1);
    expect(usageCalls).toBe(1);
    getSpy.mockRestore();
  });

  test("WARM hit = exactly 1 cache read, 0 writes, 0 auth, 0 moderation", async () => {
    await resolveInferenceAuthContext(req()); // populate (cold)
    expect(usageCalls).toBe(1);

    const getSpy = spyOn(cache, "getWithOutcome");
    const setSpy = spyOn(cache, "setWithOutcome");
    const delSpy = spyOn(cache, "del");
    authChainCalls = 0;
    moderationCalls = 0;
    admissionLoadCalls = 0;
    primaryPolicyReads = 0;
    policyAdmissionCalls = 0;
    appScopeCalls = 0;
    revocationBoundaryCalls = 0;
    usageCalls = 0;

    const warm = await resolveInferenceAuthContext(req());

    expect(warm.kind).toBe("authorized");
    if (warm.kind === "authorized") expect(warm.source).toBe("cache");
    // Primary policy authority and the strong denial fence accompany the cache read.
    expect(getSpy).toHaveBeenCalledTimes(1);
    expect(setSpy).toHaveBeenCalledTimes(0);
    expect(delSpy).toHaveBeenCalledTimes(0);
    expect(authChainCalls).toBe(0); // zero auth DB work
    expect(moderationCalls).toBe(0); // zero moderation DB work
    expect(primaryPolicyReads).toBe(1);
    expect(policyAdmissionCalls).toBe(0);
    expect(admissionLoadCalls).toBe(0); // admission rides in the single cache read (IAC v2)
    expect(appScopeCalls).toBe(0); // app scope rides in the single cache read (IAC v2)
    expect(revocationBoundaryCalls).toBe(1);
    expect(usageCalls).toBe(1); // usage tracking is fire-and-forget, not a hot read

    getSpy.mockRestore();
    setSpy.mockRestore();
    delSpy.mockRestore();
  });

  test("N warm hits use one cache and primary policy read each without auth hydration", async () => {
    await resolveInferenceAuthContext(req()); // populate

    const getSpy = spyOn(cache, "getWithOutcome");
    authChainCalls = 0;
    moderationCalls = 0;
    admissionLoadCalls = 0;
    primaryPolicyReads = 0;
    policyAdmissionCalls = 0;
    appScopeCalls = 0;
    revocationBoundaryCalls = 0;

    const N = 25;
    for (let i = 0; i < N; i++) await resolveInferenceAuthContext(req());

    expect(getSpy).toHaveBeenCalledTimes(N); // exactly one read per request
    expect(authChainCalls).toBe(0);
    expect(moderationCalls).toBe(0);
    expect(primaryPolicyReads).toBe(N);
    expect(policyAdmissionCalls).toBe(0);
    expect(admissionLoadCalls).toBe(0);
    expect(appScopeCalls).toBe(0);
    expect(revocationBoundaryCalls).toBe(N);

    getSpy.mockRestore();
  });

  test("bad standing is explained from the same single cache read", async () => {
    const keyHash = hashApiKey(KEY);
    await writeInferenceApiKeyAuthRejection(keyHash, "rejected", 403, "organization_inactive");

    const getSpy = spyOn(cache, "getWithOutcome");
    const setSpy = spyOn(cache, "setWithOutcome");
    authChainCalls = 0;
    moderationCalls = 0;
    revocationBoundaryCalls = 0;

    expect(await resolveInferenceAuthContext(req())).toEqual({
      kind: "rejected",
      status: 403,
      reason: "organization_inactive",
    });
    expect(getSpy).toHaveBeenCalledTimes(1);
    expect(setSpy).toHaveBeenCalledTimes(0);
    expect(authChainCalls).toBe(0);
    expect(moderationCalls).toBe(0);
    expect(revocationBoundaryCalls).toBe(0);
    expect(primaryPolicyReads).toBe(0);
    expect(policyAdmissionCalls).toBe(0);

    getSpy.mockRestore();
    setSpy.mockRestore();
  });
});
