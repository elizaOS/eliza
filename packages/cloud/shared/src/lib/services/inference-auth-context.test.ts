/**
 * Unit tests for the inference hot-path auth resolver + low-level cache (#9899).
 *
 * Uses the REAL CacheClient with MOCK_REDIS=1 (in-memory adapter) so the
 * read/write/invalidate round-trip is exercised end-to-end, and mocks only the
 * auth + moderation + api-key seams the resolver calls on a miss.
 */

process.env.MOCK_REDIS = "1";
process.env.CACHE_ENABLED = "true";

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// --- Controllable seams -----------------------------------------------------
type AuthImpl = (req: Request) => Promise<{
  user: { id: string; organization_id: string };
  apiKey?: { id: string } | null;
}>;

let authImpl: AuthImpl;
let shouldBlock: (userId: string) => Promise<boolean>;
const incrementUsageCalls: string[] = [];

mock.module("../auth", () => ({
  requireAuthOrApiKeyWithOrg: (req: Request) => authImpl(req),
}));
mock.module("./content-moderation", () => ({
  contentModerationService: {
    shouldBlockUser: (userId: string) => shouldBlock(userId),
  },
}));
mock.module("./api-keys", () => ({
  apiKeysService: {
    incrementUsageDebounced: async (id: string) => {
      incrementUsageCalls.push(id);
    },
  },
}));

const { resolveInferenceAuthContext, extractApiKeyCredential, isInferenceHotPathCacheEnabled } =
  await import("./inference-auth-context");
const {
  hashApiKey,
  readInferenceAuthContext,
  invalidateInferenceAuthContextByKeyHash,
  isInferenceAuthContext,
} = await import("./inference-auth-cache");

const KEY = "eliza_test_key_abc123";

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

describe("isInferenceHotPathCacheEnabled", () => {
  test("default OFF", () => {
    expect(isInferenceHotPathCacheEnabled({})).toBe(false);
  });
  test("ON only for exact 'true'", () => {
    expect(isInferenceHotPathCacheEnabled({ INFERENCE_HOT_PATH_CACHE: "true" })).toBe(true);
    expect(isInferenceHotPathCacheEnabled({ INFERENCE_HOT_PATH_CACHE: " true " })).toBe(true);
    expect(isInferenceHotPathCacheEnabled({ INFERENCE_HOT_PATH_CACHE: "1" })).toBe(false);
    expect(isInferenceHotPathCacheEnabled({ INFERENCE_HOT_PATH_CACHE: "yes" })).toBe(false);
  });
});

describe("resolveInferenceAuthContext", () => {
  test("non-API-key request -> slow_path", async () => {
    const res = await resolveInferenceAuthContext(new Request("https://x/"));
    expect(res.kind).toBe("slow_path");
  });

  test("miss -> runs authoritative chain, authorizes, and caches", async () => {
    const res = await resolveInferenceAuthContext(reqWithApiKey());
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

  test("suspended user -> never cached, returns suspended", async () => {
    shouldBlock = async () => true;
    const res = await resolveInferenceAuthContext(reqWithApiKey());
    expect(res.kind).toBe("suspended");
    expect(await readInferenceAuthContext(hashApiKey(KEY))).toBeNull();
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
        keyHash: "h",
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
        keyHash: "h",
      }),
    ).toBe(true);
  });
});
