/**
 * Cold-auth fast path — combined-auth caching contract.
 *
 * Covers apiKeysService.validateApiKeyCombined (the AUTH_COMBINED_FASTPATH
 * lookup): cache hit (valid) skips the DB, negative-sentinel hit returns null
 * without the DB, a miss queries once and positive/negative caches the result,
 * and a corrupt cache entry is dropped + refetched. Mirrors the existing
 * validateApiKey caching behavior so the fast path is a drop-in.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

const UUID = "11111111-1111-1111-1111-111111111111";

let cacheValue: unknown = null;
let repoResult: unknown;

const cacheGet = mock(async (_key: string) => cacheValue);
const cacheSet = mock(async (_key: string, _value: unknown, _ttl: number) => {});
const cacheDel = mock(async (_key: string) => {});
const findActiveWithUserAndOrg = mock(async (_hash: string) => repoResult);

mock.module("../cache/client", () => ({
  cache: { get: cacheGet, set: cacheSet, del: cacheDel },
}));

mock.module("../../db/repositories", () => ({
  apiKeysRepository: { findActiveWithUserAndOrg },
}));

mock.module("../utils/logger", () => ({
  logger: { warn: () => {}, info: () => {}, error: () => {}, debug: () => {} },
}));

// Break the KMS import chain (db/crypto/api-keys → @elizaos/security/kms);
// only generateApiKey/create touch it, not the combined-auth path under test.
mock.module("../../db/crypto/api-keys", () => ({
  encryptApiKey: async () => ({
    ciphertext: "",
    nonce: "",
    auth_tag: "",
    kms_key_id: "",
    kms_key_version: "",
  }),
}));

// `../pricing` pulls ai-pricing/lookup → decimal.js (not in the unit test env);
// only generateApiKey reads API_KEY_PREFIX_LENGTH.
mock.module("../pricing", () => ({ API_KEY_PREFIX_LENGTH: 12 }));

const { apiKeysService } = await import("./api-keys");
const { CacheTTL } = await import("../cache/keys");

const apiKey = {
  id: UUID,
  organization_id: UUID,
  user_id: UUID,
  key_hash: "deadbeef",
  key_prefix: "eliza_dead",
  is_active: true,
  expires_at: null,
};
const user = { id: UUID, is_active: true, organization: { id: UUID, is_active: true } };
const combined = { apiKey, user };

describe("validateApiKeyCombined (cold-auth fast path caching)", () => {
  beforeEach(() => {
    cacheValue = null;
    repoResult = undefined;
    cacheGet.mockClear();
    cacheSet.mockClear();
    cacheDel.mockClear();
    findActiveWithUserAndOrg.mockClear();
  });

  test("miss → queries DB once, positive-caches, returns combined", async () => {
    repoResult = combined;
    const res = await apiKeysService.validateApiKeyCombined("eliza_key");
    expect(res).toEqual(combined);
    expect(findActiveWithUserAndOrg).toHaveBeenCalledTimes(1);
    // positive cache write uses the combined-auth TTL
    expect(cacheSet).toHaveBeenCalledTimes(1);
    expect(cacheSet.mock.calls[0][2]).toBe(CacheTTL.apiKey.combinedAuth);
  });

  test("valid cache hit → returns cached without touching the DB", async () => {
    cacheValue = combined;
    const res = await apiKeysService.validateApiKeyCombined("eliza_key");
    expect(res).toEqual(combined);
    expect(findActiveWithUserAndOrg).not.toHaveBeenCalled();
    expect(cacheSet).not.toHaveBeenCalled();
  });

  test("negative-sentinel hit → returns null without touching the DB", async () => {
    cacheValue = { __none: true };
    const res = await apiKeysService.validateApiKeyCombined("eliza_key");
    expect(res).toBeNull();
    expect(findActiveWithUserAndOrg).not.toHaveBeenCalled();
  });

  test("unknown key → negative-caches and returns null", async () => {
    repoResult = undefined;
    const res = await apiKeysService.validateApiKeyCombined("eliza_key");
    expect(res).toBeNull();
    expect(findActiveWithUserAndOrg).toHaveBeenCalledTimes(1);
    // a negative entry is written (short TTL) so a bad-key flood can't hammer the DB
    expect(cacheSet).toHaveBeenCalledTimes(1);
  });

  test("corrupt cache entry → dropped, then refetched from DB", async () => {
    cacheValue = { not: "a valid combined entry" };
    repoResult = combined;
    const res = await apiKeysService.validateApiKeyCombined("eliza_key");
    expect(cacheDel).toHaveBeenCalledTimes(1);
    expect(findActiveWithUserAndOrg).toHaveBeenCalledTimes(1);
    expect(res).toEqual(combined);
  });
});
