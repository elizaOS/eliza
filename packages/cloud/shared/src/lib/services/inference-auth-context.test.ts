/**
 * Exercises the inference hot-path auth resolver and low-level cache with the
 * real in-memory CacheClient. Authentication, moderation, API-key, admission,
 * and revocation collaborators are deterministic mocks.
 */

process.env.MOCK_REDIS = "1";
process.env.CACHE_ENABLED = "true";
process.env.INFERENCE_AUTH_CACHE_ENABLED = "true";
process.env.INFERENCE_STRONG_REVOCATION_ENABLED = "true";
process.env.INFERENCE_AUTH_HYDRATION_DEADLINE_MS = "60";

import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { redactLogArgs } from "@elizaos/core";

// --- Controllable seams -----------------------------------------------------
type AuthImpl = () => Promise<{
  user: { id: string; organization_id: string };
  apiKey?: { id: string } | null;
}>;

let authImpl: AuthImpl;
let shouldBlock: (userId: string) => Promise<boolean>;
let assertCredentialActive: (
  organizationId: string,
  credential: { kind: string; credentialId?: string; userId: string },
) => Promise<void>;
const incrementUsageCalls: string[] = [];
const authBoundaryCalls: string[] = [];
const moderationBypassCacheCalls: boolean[] = [];
const ADMISSION = {
  balance: { balanceUsd: 100, balanceAt: 1, balanceRevision: "1" },
  rateLimits: {
    completionsRpm: 60,
    embeddingsRpm: 100,
    standardRpm: 30,
    strictRpm: 5,
  },
};

mock.module("./inference-api-key-auth", () => ({
  requireInferenceApiKeyWithOrg: async (
    rawKey: string,
    options: {
      timing?: {
        keyLookup(durationMs: number): void;
        userOrgLookup(durationMs: number): void;
      };
    } = {},
  ) => {
    authBoundaryCalls.push(rawKey);
    options.timing?.keyLookup(1);
    options.timing?.userOrgLookup(2);
    return await authImpl();
  },
}));
mock.module("./admin", () => ({
  adminService: {
    shouldBlockUser: (userId: string) => {
      moderationBypassCacheCalls.push(true);
      return shouldBlock(userId);
    },
  },
}));
mock.module("./content-moderation", () => ({
  contentModerationService: {
    shouldBlockUser: (userId: string, options: { bypassCache?: boolean } = {}) => {
      moderationBypassCacheCalls.push(options.bypassCache === true);
      return shouldBlock(userId);
    },
  },
}));
mock.module("./api-keys", () => ({
  apiKeysService: {
    incrementUsageDebounced: async (id: string) => {
      incrementUsageCalls.push(id);
    },
  },
  isMobileApiKeySecret: (value: string) => /^eliza_mobile_[0-9a-f]{64}$/.test(value),
}));
mock.module("./inference-admission-snapshot", () => ({
  loadInferenceAdmissionSnapshot: async () => ADMISSION,
}));
mock.module("./inference-app-key-scope", () => ({
  loadInferenceAppKeyScope: async () => null,
}));
mock.module("./inference-credential-revocation", () => ({
  isInferenceStrongRevocationEnabled: () =>
    process.env.INFERENCE_STRONG_REVOCATION_ENABLED === "true",
  InferenceCredentialRevokedError: class InferenceCredentialRevokedError extends Error {
    constructor(readonly reason: string) {
      super("Inference credential is revoked");
      this.name = "InferenceCredentialRevokedError";
    }
  },
  assertInferenceCredentialActive: (
    organizationId: string,
    credential: { kind: string; credentialId?: string; userId: string },
  ) =>
    process.env.INFERENCE_STRONG_REVOCATION_ENABLED === "true"
      ? assertCredentialActive(organizationId, credential)
      : Promise.resolve(),
  inferenceCredentialRevocationReason: (reason: string) => {
    if (reason === "credential_revoked") return "credential_inactive";
    if (reason === "organization_disabled") return "organization_inactive";
    return "credential_invalid";
  },
  revokeInferenceApiKey: async () => undefined,
  setInferenceSessionBindingActive: async () => undefined,
  revokeInferenceSessionsThrough: async () => undefined,
  setInferenceOrganizationActive: async () => undefined,
  setInferenceSubjectActive: async () => undefined,
}));

const {
  __clearInferenceApiKeyHydrations,
  resolveInferenceAuthContext,
  extractApiKeyCredential,
  resolveInferenceAuthHydrationDeadlineMs,
} = await import("./inference-auth-context");
const { cache } = await import("../cache/client");
const { CacheKeys } = await import("../cache/keys");
const { logger } = await import("../utils/logger");
const {
  hashApiKey,
  readInferenceAuthContext,
  invalidateInferenceAuthContextByKeyHash,
  isInferenceAuthContext,
  writeInferenceAuthContext,
} = await import("./inference-auth-cache");

const KEY = "test-api-key";
const MOBILE_KEY = `eliza_mobile_${"a".repeat(64)}`;

function reqWithApiKey(key = KEY): Request {
  return new Request("https://api.example/api/v1/chat/completions", {
    method: "POST",
    headers: { "X-API-Key": key },
  });
}

beforeEach(async () => {
  process.env.INFERENCE_STRONG_REVOCATION_ENABLED = "true";
  authImpl = async () => ({
    user: { id: "user-1", organization_id: "org-1" },
    apiKey: { id: "key-1" },
  });
  shouldBlock = async () => false;
  assertCredentialActive = async () => undefined;
  incrementUsageCalls.length = 0;
  authBoundaryCalls.length = 0;
  moderationBypassCacheCalls.length = 0;
  __clearInferenceApiKeyHydrations();
  // Clear any cached entry from a prior test.
  await invalidateInferenceAuthContextByKeyHash(hashApiKey(KEY));
});

afterEach(() => {
  mock.restore();
});

describe("resolveInferenceAuthHydrationDeadlineMs", () => {
  test.each([
    [undefined, 10_000],
    ["", 10_000],
    ["  ", 10_000],
    ["1", 1],
    [" 60 ", 60],
    ["2147483647", 2_147_483_647],
  ])("resolves a timer-safe hydration deadline from %p", (raw, expected) => {
    expect(resolveInferenceAuthHydrationDeadlineMs(raw)).toBe(expected);
  });

  test.each([
    "0",
    "-1",
    "+1",
    "1.5",
    "1e3",
    "60ms",
    "NaN",
    "Infinity",
    "2147483648",
    "9007199254740992",
  ])("rejects an invalid hydration deadline %p", (raw) => {
    let thrown: unknown;
    try {
      resolveInferenceAuthHydrationDeadlineMs(raw);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({
      code: "INVALID_INFERENCE_AUTH_HYDRATION_DEADLINE",
      context: {
        envKey: "INFERENCE_AUTH_HYDRATION_DEADLINE_MS",
        configured: raw,
      },
    });
  });
});

describe("extractApiKeyCredential", () => {
  test("reads X-API-Key", () => {
    expect(extractApiKeyCredential(reqWithApiKey())).toBe(KEY);
  });

  test("reads eliza_* bearer", () => {
    const req = new Request("https://x/", {
      headers: { authorization: "Bearer eliza_bearer_key" },
    });
    expect(extractApiKeyCredential(req)).toBe("eliza_bearer_key");
  });

  test("rejects non-eliza bearer (JWT)", () => {
    const req = new Request("https://x/", {
      headers: { authorization: "Bearer eyJhbGci.payload.sig" },
    });
    expect(extractApiKeyCredential(req)).toBeNull();
  });

  test("rejects when wallet headers present (fail-closed, not cacheable)", () => {
    const req = new Request("https://x/", {
      headers: {
        "X-API-Key": KEY,
        "X-Wallet-Address": "0xabc",
        "X-Wallet-Signature": "0xsig",
        "X-Timestamp": "123",
      },
    });
    expect(extractApiKeyCredential(req)).toBeNull();
  });

  test("returns null with no credential", () => {
    expect(extractApiKeyCredential(new Request("https://x/"))).toBeNull();
  });
});

describe("resolveInferenceAuthContext", () => {
  test("non-API-key request -> slow_path", async () => {
    const res = await resolveInferenceAuthContext(new Request("https://x/"));
    expect(res.kind).toBe("slow_path");
  });

  test("mobile credentials bypass even a pre-existing positive inference cache entry", async () => {
    const keyHash = hashApiKey(MOBILE_KEY);
    await writeInferenceAuthContext({
      v: 1,
      cachedAt: Date.now(),
      userId: "stale-mobile-user",
      orgId: "stale-mobile-org",
      apiKeyId: "stale-mobile-key",
      keyHash,
    });
    const availability = spyOn(cache, "isAvailable");
    const cacheRead = spyOn(cache, "getWithOutcome");
    const cacheWrite = spyOn(cache, "setWithOutcome");

    try {
      const result = await resolveInferenceAuthContext(reqWithApiKey(MOBILE_KEY));

      expect(result).toEqual({
        kind: "slow_path",
        reason: "mobile_api_key",
      });
      expect(authBoundaryCalls).toEqual([]);
      expect(incrementUsageCalls).toEqual([]);
      expect(availability).not.toHaveBeenCalled();
      expect(cacheRead).not.toHaveBeenCalled();
      expect(cacheWrite).not.toHaveBeenCalled();
    } finally {
      availability.mockRestore();
      cacheRead.mockRestore();
      cacheWrite.mockRestore();
      await invalidateInferenceAuthContextByKeyHash(keyHash);
    }
  });

  test("miss -> runs authoritative chain, authorizes, and caches", async () => {
    let telemetry: import("./inference-auth-context").InferenceAuthTelemetry | undefined;
    const res = await resolveInferenceAuthContext(reqWithApiKey(), {
      traceId: "0190f2f1-8b5a-7000-8000-000000000001",
      onTelemetry: (value) => {
        telemetry = value;
      },
    });
    expect(res.kind).toBe("authorized");
    if (res.kind !== "authorized") throw new Error("unreachable");
    expect(res.source).toBe("origin");
    expect(res.ctx.userId).toBe("user-1");
    expect(res.ctx.orgId).toBe("org-1");
    expect(res.ctx.apiKeyId).toBe("key-1");
    expect(res.ctx.keyHash).toBe(hashApiKey(KEY));
    expect(res.ctx.admission).toEqual(ADMISSION);

    const cached = await readInferenceAuthContext(hashApiKey(KEY));
    expect(cached).not.toBeNull();
    expect(isInferenceAuthContext(cached)).toBe(true);
    expect(telemetry?.cacheRead).toBe("miss");
    expect(telemetry?.authoritative).toBe("authorized");
    expect(telemetry?.cacheWrite).toBe("written");
    expect(telemetry?.timings.keyLookupMs).toBe(1);
    expect(telemetry?.timings.userOrgLookupMs).toBe(2);
    expect(redactLogArgs([telemetry])).toMatchObject([{ authSource: "x_api_key" }]);
    const serialized = JSON.stringify(telemetry);
    expect(serialized).not.toContain(KEY);
    expect(serialized).not.toContain(hashApiKey(KEY));
    expect(serialized).not.toContain("user-1");
    expect(serialized).not.toContain("org-1");
  });

  test("cache-only miss consumes the authoritative continuation after one cache read", async () => {
    let chainCalls = 0;
    authImpl = async () => {
      chainCalls++;
      return {
        user: { id: "user-1", organization_id: "org-1" },
        apiKey: { id: "key-1" },
      };
    };
    const waited: Promise<unknown>[] = [];
    const cacheRead = spyOn(cache, "getWithOutcome");
    let finishWrite = (): void => {};
    const cacheWrite = spyOn(cache, "setWithOutcome").mockImplementation(
      async () =>
        await new Promise((resolve) => {
          finishWrite = () => resolve({ kind: "written" as const, backend: "memory" as const });
        }),
    );
    try {
      const result = await resolveInferenceAuthContext(reqWithApiKey(), {
        cacheOnly: true,
        deferStrongCredentialCheck: true,
        executionCtx: { waitUntil: (promise) => waited.push(promise) },
      });
      expect(result).toMatchObject({
        kind: "authorized",
        source: "origin",
        credential: {
          kind: "api_key",
          credentialId: "key-1",
          userId: "user-1",
        },
      });
      expect(waited.length).toBeGreaterThan(0);
      expect(chainCalls).toBe(1);
      expect(cacheRead).toHaveBeenCalledTimes(1);
      expect(cacheWrite).toHaveBeenCalledTimes(1);
      expect(incrementUsageCalls).toEqual(["key-1"]);

      const retryBeforeProjection = await resolveInferenceAuthContext(reqWithApiKey(), {
        cacheOnly: true,
        inlineContinuationDeadlineMs: 0,
        executionCtx: { waitUntil: (promise) => waited.push(promise) },
      });
      expect(retryBeforeProjection).toMatchObject({ kind: "warming" });
      expect(chainCalls).toBe(1);
      expect(cacheRead).toHaveBeenCalledTimes(2);
      expect(cacheWrite).toHaveBeenCalledTimes(1);
      expect(waited.length).toBeGreaterThanOrEqual(2);
      expect(waited[0]).toBe(waited.at(-1));

      finishWrite();
      await Promise.all(waited);
    } finally {
      finishWrite();
      cacheRead.mockRestore();
      cacheWrite.mockRestore();
    }
  });

  test("concurrent cache-only misses share one authoritative hydration", async () => {
    const gate = Promise.withResolvers<void>();
    let chainCalls = 0;
    authImpl = async () => {
      chainCalls++;
      await gate.promise;
      return {
        user: { id: "user-1", organization_id: "org-1" },
        apiKey: { id: "key-1" },
      };
    };
    const waited: Promise<unknown>[] = [];
    const executionCtx = {
      waitUntil: (promise: Promise<unknown>) => waited.push(promise),
    };

    const [first, second] = await Promise.all([
      resolveInferenceAuthContext(reqWithApiKey(), {
        cacheOnly: true,
        inlineContinuationDeadlineMs: 0,
        executionCtx,
      }),
      resolveInferenceAuthContext(reqWithApiKey(), {
        cacheOnly: true,
        inlineContinuationDeadlineMs: 0,
        executionCtx,
      }),
    ]);

    expect(first).toMatchObject({ kind: "warming" });
    expect(second).toMatchObject({ kind: "warming" });
    expect(waited).toHaveLength(2);
    expect(waited[0]).toBe(waited[1]);

    gate.resolve();
    await Promise.all(waited);
    expect(chainCalls).toBe(1);
    expect(await readInferenceAuthContext(hashApiKey(KEY))).not.toBeNull();
  });

  test("a cold consumer without an admission credential awaits its standalone strong check", async () => {
    const strongGate = Promise.withResolvers<void>();
    let strongChecks = 0;
    assertCredentialActive = async () => {
      strongChecks++;
      await strongGate.promise;
    };
    const waited: Promise<unknown>[] = [];
    let settled = false;
    const resolution = resolveInferenceAuthContext(reqWithApiKey(), {
      cacheOnly: true,
      executionCtx: { waitUntil: (promise) => waited.push(promise) },
    }).then((result) => {
      settled = true;
      return result;
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    strongGate.resolve();
    const result = await resolution;
    expect(result).toMatchObject({ kind: "authorized", source: "origin" });
    expect(result).not.toHaveProperty("credential");
    await Promise.all(waited);
    expect(strongChecks).toBe(2);
  });

  test("a cold request safely joins a refresh-created flight and retains its lease credential", async () => {
    await writeInferenceAuthContext({
      v: 2,
      cachedAt: 1,
      userId: "user-1",
      orgId: "org-1",
      apiKeyId: "key-1",
      keyHash: hashApiKey(KEY),
      appScopeId: null,
      admission: ADMISSION,
    });
    const originGate = Promise.withResolvers<void>();
    let chainCalls = 0;
    let strongChecks = 0;
    authImpl = async () => {
      chainCalls++;
      await originGate.promise;
      return {
        user: { id: "user-1", organization_id: "org-1" },
        apiKey: { id: "key-1" },
      };
    };
    assertCredentialActive = async () => {
      strongChecks++;
    };
    const waited: Promise<unknown>[] = [];
    const executionCtx = { waitUntil: (promise: Promise<unknown>) => waited.push(promise) };

    const warm = await resolveInferenceAuthContext(reqWithApiKey(), {
      cacheOnly: true,
      executionCtx,
    });
    expect(warm).toMatchObject({ kind: "authorized", source: "cache" });
    await invalidateInferenceAuthContextByKeyHash(hashApiKey(KEY));
    const coldPromise = resolveInferenceAuthContext(reqWithApiKey(), {
      cacheOnly: true,
      deferStrongCredentialCheck: true,
      executionCtx,
    });
    originGate.resolve();
    const cold = await coldPromise;

    expect(cold).toMatchObject({
      kind: "authorized",
      source: "origin",
      credential: { kind: "api_key", credentialId: "key-1", userId: "user-1" },
    });
    await Promise.all(waited);
    expect(chainCalls).toBe(1);
    // One check serves the warm cached request; the projection performs its
    // own check, while the cold request carries its proof to admission.
    expect(strongChecks).toBe(2);
  });

  test("definitive API-key rejection converges to cached 401 without another database lookup", async () => {
    let chainCalls = 0;
    authImpl = async () => {
      chainCalls++;
      const error = new Error("Invalid or expired API key");
      error.name = "AuthenticationError";
      throw error;
    };
    const waited: Promise<unknown>[] = [];

    const cold = await resolveInferenceAuthContext(reqWithApiKey(), {
      cacheOnly: true,
      inlineContinuationDeadlineMs: 0,
      executionCtx: { waitUntil: (promise) => waited.push(promise) },
    });
    expect(cold).toMatchObject({ kind: "warming" });
    await Promise.all(waited);
    expect(chainCalls).toBe(1);

    const errorSpy = spyOn(logger, "error").mockImplementation(() => undefined);
    const retry = await resolveInferenceAuthContext(reqWithApiKey(), {
      cacheOnly: true,
      executionCtx: { waitUntil: (promise) => waited.push(promise) },
    });
    expect(retry).toEqual({ kind: "rejected", status: 401, reason: "credential_invalid" });
    expect(chainCalls).toBe(1);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith(
      "[InferenceAuth] account standing denied inference",
      expect.objectContaining({
        status: 401,
        reason: "credential_invalid",
        authSource: "x_api_key",
        cacheBackend: "memory",
        cacheRead: "rejected",
        source: "cache",
      }),
    );
    const logged = JSON.stringify(errorSpy.mock.calls);
    expect(logged).not.toContain(KEY);
    expect(logged).not.toContain("user-1");
    errorSpy.mockRestore();
  });

  test("inline continuation returns an authoritative rejection after one cache read", async () => {
    authImpl = async () => {
      const error = new Error("Invalid or expired API key");
      error.name = "AuthenticationError";
      throw error;
    };
    const waited: Promise<unknown>[] = [];
    const cacheRead = spyOn(cache, "getWithOutcome");
    try {
      const result = await resolveInferenceAuthContext(reqWithApiKey(), {
        cacheOnly: true,
        executionCtx: { waitUntil: (promise) => waited.push(promise) },
      });

      expect(result).toEqual({
        kind: "rejected",
        status: 401,
        reason: "credential_invalid",
      });
      expect(cacheRead).toHaveBeenCalledTimes(1);
      await Promise.all(waited);
    } finally {
      cacheRead.mockRestore();
    }
  });

  test("authoritative suspension converges to a cached fail-closed decision", async () => {
    let moderationCalls = 0;
    shouldBlock = async () => {
      moderationCalls++;
      return true;
    };
    const waited: Promise<unknown>[] = [];

    const cold = await resolveInferenceAuthContext(reqWithApiKey(), {
      cacheOnly: true,
      executionCtx: { waitUntil: (promise) => waited.push(promise) },
    });
    expect(cold).toEqual({
      kind: "suspended",
      userId: "user-1",
      reason: "moderation_blocked",
    });
    await Promise.all(waited);
    expect(moderationCalls).toBe(1);

    const retry = await resolveInferenceAuthContext(reqWithApiKey(), {
      cacheOnly: true,
    });
    expect(retry).toEqual({ kind: "suspended", reason: "moderation_blocked" });
    expect(moderationCalls).toBe(1);
  });

  test("inline continuation deadline returns warming after one cache read", async () => {
    const gate = Promise.withResolvers<void>();
    authImpl = async () => {
      await gate.promise;
      return {
        user: { id: "user-1", organization_id: "org-1" },
        apiKey: { id: "key-1" },
      };
    };
    const waited: Promise<unknown>[] = [];
    const cacheRead = spyOn(cache, "getWithOutcome");
    const warning = spyOn(logger, "warn").mockImplementation(() => undefined);
    try {
      const result = await resolveInferenceAuthContext(reqWithApiKey(), {
        cacheOnly: true,
        inlineContinuationDeadlineMs: 10,
        executionCtx: { waitUntil: (promise) => waited.push(promise) },
      });

      expect(result).toMatchObject({ kind: "warming" });
      expect(cacheRead).toHaveBeenCalledTimes(1);
      expect(warning).toHaveBeenCalledWith(
        "[InferenceAuth] inline continuation exceeded deadline",
        expect.objectContaining({
          traceId: "unavailable",
          authSource: "x_api_key",
          deadlineMs: 10,
        }),
      );
    } finally {
      gate.resolve();
      await Promise.all(waited);
      cacheRead.mockRestore();
      warning.mockRestore();
    }
  });

  test("Worker execution context defers positive cache population and observes its outcome", async () => {
    let finishWrite = (): void => {};
    const readSpy = spyOn(cache, "getWithOutcome");
    const writeSpy = spyOn(cache, "setWithOutcome").mockImplementation(
      async () =>
        await new Promise((resolve) => {
          finishWrite = () => resolve({ kind: "written" as const, backend: "memory" as const });
        }),
    );
    const waited: Promise<unknown>[] = [];
    let resolutionTelemetry: import("./inference-auth-context").InferenceAuthTelemetry | undefined;
    let cacheWriteTelemetry:
      | import("./inference-auth-context").InferenceAuthCacheWriteTelemetry
      | undefined;
    try {
      const result = await resolveInferenceAuthContext(reqWithApiKey(), {
        traceId: "0190f2f1-8b5a-7000-8000-000000000002",
        executionCtx: {
          waitUntil: (promise) => {
            waited.push(promise);
          },
        },
        onTelemetry: (value) => {
          resolutionTelemetry = value;
        },
        onCacheWriteTelemetry: (value) => {
          cacheWriteTelemetry = value;
        },
      });

      expect(result.kind).toBe("authorized");
      expect(waited).toHaveLength(1);
      expect(resolutionTelemetry?.cacheWrite).toBe("deferred");
      expect(resolutionTelemetry?.timings.cacheWriteMs).toBeNull();
      expect(cacheWriteTelemetry).toBeUndefined();

      finishWrite();
      await Promise.all(waited);
      expect(cacheWriteTelemetry).toMatchObject({
        kind: "cache_write",
        traceId: "0190f2f1-8b5a-7000-8000-000000000002",
        cacheBackend: "memory",
        cacheWrite: "written",
      });
      expect(cacheWriteTelemetry?.durationMs).toBeGreaterThanOrEqual(0);
      expect(readSpy).toHaveBeenCalledTimes(1);
      expect(writeSpy).toHaveBeenCalledTimes(1);
    } finally {
      finishWrite();
      readSpy.mockRestore();
      writeSpy.mockRestore();
    }
  });

  test("a rejected deferred cache write is structured and does not reject waitUntil", async () => {
    const writeSpy = spyOn(cache, "setWithOutcome").mockRejectedValue(
      new TypeError("sensitive backend detail"),
    );
    const warning = spyOn(logger, "warn").mockImplementation(() => undefined);
    const waited: Promise<unknown>[] = [];
    try {
      const result = await resolveInferenceAuthContext(reqWithApiKey(), {
        traceId: "0190f2f1-8b5a-7000-8000-000000000003",
        executionCtx: { waitUntil: (promise) => waited.push(promise) },
      });
      expect(result).toMatchObject({ kind: "authorized", source: "origin" });
      await expect(Promise.all(waited)).resolves.toBeArray();
      expect(warning).toHaveBeenCalledWith("[InferenceAuth] deferred cache write rejected", {
        traceId: "0190f2f1-8b5a-7000-8000-000000000003",
        errorName: "TypeError",
      });
      expect(JSON.stringify(warning.mock.calls)).not.toContain("sensitive backend detail");
    } finally {
      writeSpy.mockRestore();
      warning.mockRestore();
    }
  });

  test("warm hit -> served from cache, no authoritative chain call", async () => {
    await resolveInferenceAuthContext(reqWithApiKey()); // populate
    let chainCalls = 0;
    authImpl = async () => {
      chainCalls++;
      return { user: { id: "user-1", organization_id: "org-1" }, apiKey: { id: "key-1" } };
    };
    const res = await resolveInferenceAuthContext(reqWithApiKey());
    expect(res.kind).toBe("authorized");
    if (res.kind !== "authorized") throw new Error("unreachable");
    expect(res.source).toBe("cache");
    expect(chainCalls).toBe(0); // zero auth/moderation DB work on warm hit
    expect(incrementUsageCalls).toContain("key-1"); // usage tracking preserved
  });

  test("warm hit can carry its strong credential into admission after one cache read", async () => {
    await resolveInferenceAuthContext(reqWithApiKey());
    let strongChecks = 0;
    assertCredentialActive = async () => {
      strongChecks++;
    };
    const cacheRead = spyOn(cache, "getWithOutcome");

    const result = await resolveInferenceAuthContext(reqWithApiKey(), {
      deferStrongCredentialCheck: true,
    });

    expect(result).toMatchObject({
      kind: "authorized",
      source: "cache",
      credential: {
        kind: "api_key",
        credentialId: "key-1",
        userId: "user-1",
      },
    });
    expect(cacheRead).toHaveBeenCalledTimes(1);
    expect(strongChecks).toBe(0);
  });

  test("flag-off origin auth never defers a credential into admission", async () => {
    process.env.INFERENCE_STRONG_REVOCATION_ENABLED = "false";
    let strongChecks = 0;
    assertCredentialActive = async () => {
      strongChecks++;
    };

    const result = await resolveInferenceAuthContext(reqWithApiKey(), {
      forceAuthoritative: true,
      deferStrongCredentialCheck: true,
    });

    expect(result).toMatchObject({
      kind: "authorized",
      source: "origin",
    });
    expect(result).not.toHaveProperty("credential");
    expect(strongChecks).toBe(0);
  });

  test("warm positive is denied immediately when the strong boundary revokes it", async () => {
    await resolveInferenceAuthContext(reqWithApiKey());
    let chainCalls = 0;
    authImpl = async () => {
      chainCalls++;
      return { user: { id: "user-1", organization_id: "org-1" }, apiKey: { id: "key-1" } };
    };
    assertCredentialActive = async () => {
      const { InferenceCredentialRevokedError } = await import("./inference-credential-revocation");
      throw new InferenceCredentialRevokedError("credential_revoked");
    };

    const result = await resolveInferenceAuthContext(reqWithApiKey());

    expect(result).toEqual({
      kind: "rejected",
      status: 401,
      reason: "credential_inactive",
    });
    expect(chainCalls).toBe(0);
  });

  test("default-off auth-cache gate ignores a populated positive entry", async () => {
    await resolveInferenceAuthContext(reqWithApiKey());
    let chainCalls = 0;
    authImpl = async () => {
      chainCalls++;
      return { user: { id: "user-1", organization_id: "org-1" }, apiKey: { id: "key-1" } };
    };
    process.env.INFERENCE_AUTH_CACHE_ENABLED = "false";
    try {
      const result = await resolveInferenceAuthContext(reqWithApiKey(), {
        cacheOnly: true,
        executionCtx: { waitUntil: () => undefined },
      });
      expect(result).toMatchObject({ kind: "authorized", source: "origin" });
      expect(chainCalls).toBe(1);
    } finally {
      process.env.INFERENCE_AUTH_CACHE_ENABLED = "true";
    }
  });

  test("authenticated probe bypasses the combined cache only after an actual IAC miss", async () => {
    const warm = await resolveInferenceAuthContext(reqWithApiKey());
    expect(warm.kind).toBe("authorized");
    authBoundaryCalls.length = 0;
    moderationBypassCacheCalls.length = 0;
    process.env.INFERENCE_AUTH_PROBE_TOKEN = "unit-probe-token";
    const request = reqWithApiKey();
    request.headers.set("X-Eliza-Auth-Probe", "unit-probe-token:0123456789abcdef0123456789abcdef");

    let telemetry: import("./inference-auth-context").InferenceAuthTelemetry | undefined;
    const controlled = await resolveInferenceAuthContext(request, {
      onTelemetry: (value) => {
        telemetry = value;
      },
    });
    expect(controlled.kind).toBe("authorized");
    if (controlled.kind === "authorized") expect(controlled.source).toBe("origin");
    expect(authBoundaryCalls).toEqual([KEY]);
    expect(moderationBypassCacheCalls).toEqual([true]);
    expect(telemetry?.cacheRead).toBe("miss");
    expect(telemetry?.controlledProbe).toBe("on");

    delete process.env.INFERENCE_AUTH_PROBE_TOKEN;
  });

  test("oversized probe control is ignored and cannot force the authoritative path", async () => {
    await resolveInferenceAuthContext(reqWithApiKey());
    authBoundaryCalls.length = 0;
    process.env.INFERENCE_AUTH_PROBE_TOKEN = "unit-probe-token";
    const request = reqWithApiKey();
    request.headers.set("X-Eliza-Auth-Probe", `unit-probe-token:${"a".repeat(600)}`);
    try {
      let telemetry: import("./inference-auth-context").InferenceAuthTelemetry | undefined;
      const result = await resolveInferenceAuthContext(request, {
        onTelemetry: (value) => {
          telemetry = value;
        },
      });
      expect(result.kind).toBe("authorized");
      if (result.kind === "authorized") expect(result.source).toBe("cache");
      expect(authBoundaryCalls).toEqual([]);
      expect(telemetry?.controlledProbe).toBe("off");
    } finally {
      delete process.env.INFERENCE_AUTH_PROBE_TOKEN;
    }
  });

  test("non-Worker cache outage stays observable and uses authoritative authorization", async () => {
    const availabilitySpy = spyOn(cache, "isAvailable").mockReturnValue(false);
    const writeSpy = spyOn(cache, "setWithOutcome").mockResolvedValue({
      kind: "unavailable",
      backend: "none",
    });
    try {
      let telemetry: import("./inference-auth-context").InferenceAuthTelemetry | undefined;
      const result = await resolveInferenceAuthContext(reqWithApiKey(), {
        onTelemetry: (value) => {
          telemetry = value;
        },
      });

      expect(result.kind).toBe("authorized");
      if (result.kind === "authorized") expect(result.source).toBe("origin");
      expect(authBoundaryCalls).toEqual([KEY]);
      expect(moderationBypassCacheCalls).toEqual([true]);
      expect(telemetry?.cacheAvailability).toBe("unavailable");
      expect(telemetry?.cacheRead).toBe("unavailable");
      expect(telemetry?.cacheWrite).toBe("unavailable");
      expect(telemetry?.result).toBe("authorized_origin");
    } finally {
      availabilitySpy.mockRestore();
      writeSpy.mockRestore();
    }
  });

  test("Worker cache outage fails closed without starting database authorization", async () => {
    const availabilitySpy = spyOn(cache, "isAvailable").mockReturnValue(false);
    let chainCalls = 0;
    authImpl = async () => {
      chainCalls++;
      return {
        user: { id: "user-1", organization_id: "org-1" },
        apiKey: { id: "key-1" },
      };
    };
    const waited: Promise<unknown>[] = [];
    try {
      const result = await resolveInferenceAuthContext(reqWithApiKey(), {
        cacheOnly: true,
        executionCtx: { waitUntil: (promise) => waited.push(promise) },
      });

      expect(result).toMatchObject({ kind: "warming" });
      expect(chainCalls).toBe(0);
      expect(waited).toHaveLength(0);
    } finally {
      availabilitySpy.mockRestore();
    }
  });

  test("cache outage never turns an authoritative rejection into a cached identity", async () => {
    const availabilitySpy = spyOn(cache, "isAvailable").mockReturnValue(false);
    const writeSpy = spyOn(cache, "setWithOutcome").mockResolvedValue({
      kind: "unavailable",
      backend: "none",
    });
    authImpl = async () => {
      throw new Error("Invalid or expired API key");
    };
    try {
      await expect(resolveInferenceAuthContext(reqWithApiKey())).rejects.toThrow(
        "Invalid or expired API key",
      );
      expect(authBoundaryCalls).toEqual([KEY]);
      expect(writeSpy).not.toHaveBeenCalled();
    } finally {
      availabilitySpy.mockRestore();
      writeSpy.mockRestore();
    }
  });

  test("suspended user -> never cached, returns suspended", async () => {
    shouldBlock = async () => true;
    const res = await resolveInferenceAuthContext(reqWithApiKey());
    expect(res.kind).toBe("suspended");
    expect(await readInferenceAuthContext(hashApiKey(KEY))).toBeNull();
  });

  test("malformed IAC is rejected and replaced only after authoritative auth", async () => {
    const keyHash = hashApiKey(KEY);
    await cache.set(
      CacheKeys.inference.authContext(keyHash),
      {
        v: 1,
        cachedAt: Date.now(),
        userId: "attacker-controlled-user",
        orgId: "attacker-controlled-org",
        apiKeyId: "attacker-controlled-key",
        keyHash: hashApiKey("different-key"),
      },
      60,
    );
    let telemetry: import("./inference-auth-context").InferenceAuthTelemetry | undefined;
    const result = await resolveInferenceAuthContext(reqWithApiKey(), {
      onTelemetry: (value) => {
        telemetry = value;
      },
    });

    expect(result.kind).toBe("authorized");
    if (result.kind === "authorized") expect(result.source).toBe("origin");
    expect(authBoundaryCalls).toEqual([KEY]);
    expect(moderationBypassCacheCalls).toEqual([true]);
    expect(telemetry?.cacheRead).toBe("invalid");
    expect((await readInferenceAuthContext(keyHash))?.userId).toBe("user-1");
  });

  test("auth failure propagates (never fail-open)", async () => {
    authImpl = async () => {
      throw new Error("Invalid or expired API key");
    };
    await expect(resolveInferenceAuthContext(reqWithApiKey())).rejects.toThrow(
      "Invalid or expired API key",
    );
    expect(await readInferenceAuthContext(hashApiKey(KEY))).toBeNull();
  });

  test("invalidation clears the cached entry", async () => {
    await resolveInferenceAuthContext(reqWithApiKey());
    expect(await readInferenceAuthContext(hashApiKey(KEY))).not.toBeNull();
    await invalidateInferenceAuthContextByKeyHash(hashApiKey(KEY));
    expect(await readInferenceAuthContext(hashApiKey(KEY))).toBeNull();
  });
});

describe("isInferenceAuthContext shape guard", () => {
  test("rejects wrong version / partial shapes", () => {
    expect(isInferenceAuthContext(null)).toBe(false);
    expect(
      isInferenceAuthContext({
        v: 2,
        userId: "u",
        orgId: "o",
        apiKeyId: "k",
        keyHash: hashApiKey(KEY),
        cachedAt: 1,
        appScopeId: null,
      }),
    ).toBe(false);
    expect(isInferenceAuthContext({ v: 1, userId: "u" })).toBe(false);
    expect(
      isInferenceAuthContext({
        v: 2,
        cachedAt: 1,
        userId: "u",
        orgId: "o",
        apiKeyId: "k",
        keyHash: hashApiKey(KEY),
        appScopeId: null,
        admission: ADMISSION,
      }),
    ).toBe(true);
  });
});

const { __clearInferenceApiKeyHydrationFailures } = await import("./inference-auth-context");

describe("hydration escape (#18246 — warming must not loop forever)", () => {
  function workerCtx(captured: Promise<unknown>[]) {
    return {
      waitUntil: (p: Promise<unknown>) => {
        captured.push(p);
      },
    } as never;
  }

  beforeEach(() => {
    __clearInferenceApiKeyHydrationFailures();
  });

  test("three failed hydrations flip the next cacheOnly request to inline authoritative", async () => {
    authImpl = async () => {
      throw new Error("postgres unreachable");
    };
    const hydrations: Promise<unknown>[] = [];
    for (let i = 0; i < 3; i++) {
      const res = await resolveInferenceAuthContext(reqWithApiKey(), {
        cacheOnly: true,
        inlineContinuationDeadlineMs: 0,
        executionCtx: workerCtx(hydrations),
      });
      expect(res.kind).toBe("warming");
      // Settle this round's hydration so the failure registers and the
      // single-flight slot frees before the next request.
      await Promise.all(hydrations.splice(0));
    }
    // Dependency recovered; a still-warming shortcut would 503 forever.
    authImpl = async () => ({
      user: { id: "user-1", organization_id: "org-1" },
      apiKey: { id: "key-1" },
    });
    const escaped = await resolveInferenceAuthContext(reqWithApiKey(), {
      cacheOnly: true,
      executionCtx: workerCtx(hydrations),
    });
    expect(escaped.kind).toBe("authorized");
    // The inline resolve wrote the cache — the loop self-healed.
    const cached = await readInferenceAuthContext(hashApiKey(KEY));
    expect(cached && isInferenceAuthContext(cached)).toBe(true);
  });

  test("a successful hydration resets the failure count", async () => {
    authImpl = async () => {
      throw new Error("blip");
    };
    const hydrations: Promise<unknown>[] = [];
    for (let i = 0; i < 2; i++) {
      await resolveInferenceAuthContext(reqWithApiKey(), {
        cacheOnly: true,
        inlineContinuationDeadlineMs: 0,
        executionCtx: workerCtx(hydrations),
      });
      await Promise.all(hydrations.splice(0));
    }
    authImpl = async () => ({
      user: { id: "user-1", organization_id: "org-1" },
      apiKey: { id: "key-1" },
    });
    // Successful hydration on round 3 clears the counter and the cache
    // now answers directly.
    await resolveInferenceAuthContext(reqWithApiKey(), {
      cacheOnly: true,
      inlineContinuationDeadlineMs: 0,
      executionCtx: workerCtx(hydrations),
    });
    await Promise.all(hydrations.splice(0));
    const res = await resolveInferenceAuthContext(reqWithApiKey(), {
      cacheOnly: true,
      executionCtx: workerCtx(hydrations),
    });
    expect(res.kind).toBe("authorized");
  });

  test("a hung hydration hits the deadline, frees the slot, and counts toward escape", async () => {
    let release: (() => void) | undefined;
    authImpl = () =>
      new Promise((resolve) => {
        release = () =>
          resolve({
            user: { id: "user-1", organization_id: "org-1" },
            apiKey: { id: "key-1" },
          });
      });
    const hydrations: Promise<unknown>[] = [];
    for (let i = 0; i < 3; i++) {
      const res = await resolveInferenceAuthContext(reqWithApiKey(), {
        cacheOnly: true,
        inlineContinuationDeadlineMs: 0,
        executionCtx: workerCtx(hydrations),
      });
      expect(res.kind).toBe("warming");
      // The deadline (env-shortened for tests) settles the raced
      // hydration even though the underlying resolve never returns.
      await Promise.all(hydrations.splice(0));
    }
    // After three deadline strikes the escape opens; a now-healthy
    // dependency resolves inline instead of warming.
    authImpl = async () => ({
      user: { id: "user-1", organization_id: "org-1" },
      apiKey: { id: "key-1" },
    });
    const escaped = await resolveInferenceAuthContext(reqWithApiKey(), {
      cacheOnly: true,
      executionCtx: workerCtx(hydrations),
    });
    expect(escaped.kind).toBe("authorized");
    release?.();
  });
});
