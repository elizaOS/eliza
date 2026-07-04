/**
 * Fail-closed cache invalidation tests (#13417).
 *
 * Invalidation is security-sensitive: revoking an API key, logging a user out,
 * or changing a permission all rely on the stale cached copy actually being
 * removed. The module-level `invalidateCache*` helpers used to wrap the delete
 * in a `try/catch` that swallowed every failure and returned normally — a
 * failed Redis `del` (backend down / network blip) was reported as a successful
 * invalidation, so the revoked/stale entry kept serving from cache until its
 * TTL lapsed. `cache.del` itself also swallowed the backend error and returned
 * `void`, so the failure was invisible at both layers.
 *
 * These tests pin the corrected contract:
 *   - a rejected backend delete surfaces as a `CacheInvalidationError`;
 *   - a `cache.del` that reports `false` (delete not confirmed) also throws;
 *   - a `delPattern` that reports `false` (incomplete sweep) throws;
 *   - the batch helper attempts every key and reports the exact failed keys;
 *   - the confirmed-delete happy path still resolves quietly.
 */

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { cache } from "./client";
import {
  CacheInvalidationError,
  invalidateCache,
  invalidateCacheBatch,
  invalidateCachePattern,
} from "./service-cache";

describe("service-cache invalidation fails closed (#13417)", () => {
  const spies: Array<{ mockRestore: () => void }> = [];

  afterEach(() => {
    for (const spy of spies.splice(0)) spy.mockRestore();
  });

  function spyDel(impl: (key: string) => Promise<boolean>) {
    const spy = spyOn(cache, "delConfirmed").mockImplementation(impl);
    spies.push(spy);
    return spy;
  }

  function spyDelPattern(impl: (pattern: string) => Promise<boolean>) {
    const spy = spyOn(cache, "delPatternConfirmed").mockImplementation(
      impl as typeof cache.delPatternConfirmed,
    );
    spies.push(spy);
    return spy;
  }

  test("invalidateCache: confirmed delete resolves (no throw)", async () => {
    spyDel(async () => true);
    await expect(invalidateCache("apikey:abc")).resolves.toBeUndefined();
  });

  test("invalidateCache: unconfirmed delete (false) throws CacheInvalidationError", async () => {
    spyDel(async () => false);
    const promise = invalidateCache("apikey:abc");
    await expect(promise).rejects.toBeInstanceOf(CacheInvalidationError);
    await expect(promise).rejects.toMatchObject({ target: "apikey:abc" });
  });

  test("invalidateCache: thrown backend delete throws (does not fabricate success)", async () => {
    const boom = new Error("redis down");
    spyDel(async () => {
      throw boom;
    });
    const promise = invalidateCache("session:xyz");
    await expect(promise).rejects.toBeInstanceOf(CacheInvalidationError);
    await expect(promise).rejects.toMatchObject({ cause: boom });
  });

  test("invalidateCachePattern: confirmed complete sweep resolves", async () => {
    spyDelPattern(async () => true);
    await expect(invalidateCachePattern("org:1:*")).resolves.toBeUndefined();
  });

  test("invalidateCachePattern: incomplete sweep (false) throws", async () => {
    spyDelPattern(async () => false);
    await expect(invalidateCachePattern("org:1:*")).rejects.toBeInstanceOf(CacheInvalidationError);
  });

  test("invalidateCachePattern: thrown scan/del throws", async () => {
    spyDelPattern(async () => {
      throw new Error("scan failed");
    });
    await expect(invalidateCachePattern("org:1:*")).rejects.toBeInstanceOf(CacheInvalidationError);
  });

  test("invalidateCacheBatch: attempts every key, reports the failed ones", async () => {
    const failing = new Set(["k2", "k4"]);
    const seen: string[] = [];
    spyDel(async (key: string) => {
      seen.push(key);
      return !failing.has(key);
    });

    const promise = invalidateCacheBatch(["k1", "k2", "k3", "k4"]);
    await expect(promise).rejects.toBeInstanceOf(CacheInvalidationError);
    // every key attempted even though k2 failed before k3/k4
    expect(seen.sort()).toEqual(["k1", "k2", "k3", "k4"]);
    // the error names exactly the unconfirmed keys
    await expect(promise).rejects.toMatchObject({ target: "k2,k4" });
  });

  test("invalidateCacheBatch: all confirmed resolves quietly", async () => {
    spyDel(async () => true);
    await expect(invalidateCacheBatch(["a", "b", "c"])).resolves.toBeUndefined();
  });

  test("invalidateCacheBatch: empty input is a no-op", async () => {
    const del = spyDel(async () => true);
    await expect(invalidateCacheBatch([])).resolves.toBeUndefined();
    expect(del).not.toHaveBeenCalled();
  });
});
