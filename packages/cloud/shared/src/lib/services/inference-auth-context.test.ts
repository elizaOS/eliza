/**
 * Unit tests for the inference hot-path auth resolver + low-level cache (#9899).
 *
 * Uses the REAL CacheClient with MOCK_REDIS=1 (in-memory adapter) so the
 * read/write/invalidate round-trip is exercised end-to-end, and mocks only the
 * auth + moderation + api-key seams the resolver calls on a miss.
 */

process.env.MOCK_REDIS = "1";
process.env.CACHE_ENABLED = "true";

import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { redactLogArgs } from "@elizaos/core";

// --- Controllable seams -----------------------------------------------------
type AuthImpl = () => Promise<{
  user: { id: string; organization_id: string };
  apiKey?: { id: string } | null;
}>;

let authImpl: AuthImpl;
let shouldBlock: (userId: string) => Promise<boolean>;
const incrementUsageCalls: string[] = [];
const bypassCacheCalls: boolean[] = [];
const moderationBypassCacheCalls: boolean[] = [];

mock.module("./inference-api-key-auth", () => ({
  requireInferenceApiKeyWithOrg: async (
    _rawKey: string,
    options: {
      bypassCache?: boolean;
      timing?: {
        keyLookup(durationMs: number): void;
        userOrgLookup(durationMs: number): void;
      };
    } = {},
  ) => {
    bypassCacheCalls.push(options.bypassCache === true);
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
}));

const { resolveInferenceAuthContext, extractApiKeyCredential } = await import(
  "./inference-auth-context"
);
const { cache } = await import("../cache/client");
const { CacheKeys } = await import("../cache/keys");
const {
  hashApiKey,
  readInferenceAuthContext,
  invalidateInferenceAuthContextByKeyHash,
  isInferenceAuthContext,
} = await import("./inference-auth-cache");

const KEY = "test-api-key";

function reqWithApiKey(key = KEY): Request {
  return new Request("https://api.example/api/v1/chat/completions", {
    method: "POST",
    headers: { "X-API-Key": key },
  });
}

beforeEach(async () => {
  authImpl = async () => ({
    user: { id: "user-1", organization_id: "org-1" },
    apiKey: { id: "key-1" },
  });
  shouldBlock = async () => false;
  incrementUsageCalls.length = 0;
  bypassCacheCalls.length = 0;
  moderationBypassCacheCalls.length = 0;
  // Clear any cached entry from a prior test.
  await invalidateInferenceAuthContextByKeyHash(hashApiKey(KEY));
});

afterEach(() => {
  mock.restore();
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

  test("Worker execution context defers positive cache population and observes its outcome", async () => {
    let finishWrite = (): void => {};
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
    } finally {
      finishWrite();
      writeSpy.mockRestore();
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

  test("authenticated probe bypasses lower caches only after an actual IAC miss", async () => {
    const warm = await resolveInferenceAuthContext(reqWithApiKey());
    expect(warm.kind).toBe("authorized");
    bypassCacheCalls.length = 0;
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
    expect(bypassCacheCalls).toEqual([true]);
    expect(moderationBypassCacheCalls).toEqual([true]);
    expect(telemetry?.cacheRead).toBe("miss");
    expect(telemetry?.controlledProbe).toBe("on");

    delete process.env.INFERENCE_AUTH_PROBE_TOKEN;
  });

  test("oversized probe control is ignored and cannot force the authoritative path", async () => {
    await resolveInferenceAuthContext(reqWithApiKey());
    bypassCacheCalls.length = 0;
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
      expect(bypassCacheCalls).toEqual([]);
      expect(telemetry?.controlledProbe).toBe("off");
    } finally {
      delete process.env.INFERENCE_AUTH_PROBE_TOKEN;
    }
  });

  test("cache outage stays observable and authorizes only through the database path", async () => {
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
      expect(bypassCacheCalls).toEqual([true]);
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
      expect(bypassCacheCalls).toEqual([true]);
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
    expect(bypassCacheCalls).toEqual([true]);
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
      }),
    ).toBe(false);
    expect(isInferenceAuthContext({ v: 1, userId: "u" })).toBe(false);
    expect(
      isInferenceAuthContext({
        v: 1,
        cachedAt: 1,
        userId: "u",
        orgId: "o",
        apiKeyId: "k",
        keyHash: hashApiKey(KEY),
      }),
    ).toBe(true);
  });
});
