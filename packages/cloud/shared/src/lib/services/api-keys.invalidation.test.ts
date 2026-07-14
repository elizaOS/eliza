/**
 * API-key revocation cache-invalidation fails closed (#13417).
 *
 * `apiKeysService.invalidateCache()` is on every revoke / delete / deactivate
 * path. It clears BOTH the validation cache (16-char prefix) and the #9899
 * inference hot-path auth-context entry. Previously it fired both `cache.del`
 * calls inside a `Promise.all` and discarded their result, and `cache.del`
 * itself swallowed a backend failure — so a Redis `del` that never landed left
 * a REVOKED key authenticating from cache until its TTL lapsed, while the
 * revoke path reported success.
 *
 * These tests pin the corrected contract: an unconfirmed delete of either cache
 * surfaces as a throw, so the caller (route) can fail closed and retry rather
 * than believe the key is gone. Ordering matters too: `delete()` invalidates
 * BEFORE the DB delete, so a failed invalidation aborts before the row is
 * removed — the key stays consistently active-and-cached, never
 * DB-revoked-but-cache-live.
 */

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { ApiKey } from "../../db/repositories";
import { apiKeysRepository } from "../../db/repositories";
import { cache } from "../cache/client";
import { CacheKeys } from "../cache/keys";
import { apiKeysService } from "./api-keys";

const KEY_HASH = "a".repeat(64);
const SHORT_HASH = KEY_HASH.substring(0, 16);
const VALIDATION_KEY = CacheKeys.apiKey.validation(SHORT_HASH);

function fakeKey(): ApiKey {
  return {
    id: "key-1",
    key_hash: KEY_HASH,
    organization_id: "org-1",
    user_id: "user-1",
    is_active: true,
  } as unknown as ApiKey;
}

describe("apiKeysService.invalidateCache fails closed (#13417)", () => {
  const spies: Array<{ mockRestore: () => void }> = [];

  afterEach(() => {
    for (const spy of spies.splice(0)) spy.mockRestore();
  });

  function track<T extends { mockRestore: () => void }>(spy: T): T {
    spies.push(spy);
    return spy;
  }

  test("both deletes confirmed -> resolves quietly", async () => {
    const del = track(spyOn(cache, "delConfirmed").mockResolvedValue(true));
    await expect(apiKeysService.invalidateCache(KEY_HASH)).resolves.toBeUndefined();
    // clears both the validation entry and the inference auth-context entry
    expect(del).toHaveBeenCalledWith(VALIDATION_KEY);
    expect(del.mock.calls.length).toBe(2);
  });

  test("validation-cache delete unconfirmed -> throws (revoked key would keep authenticating)", async () => {
    track(
      spyOn(cache, "delConfirmed").mockImplementation(
        // validation entry delete fails, inference one succeeds
        async (key: string) => key !== VALIDATION_KEY,
      ),
    );
    await expect(apiKeysService.invalidateCache(KEY_HASH)).rejects.toThrow(/not confirmed/i);
  });

  test("inference auth-context delete unconfirmed -> throws", async () => {
    track(
      spyOn(cache, "delConfirmed").mockImplementation(
        // inference entry (not the validation key) fails
        async (key: string) => key === VALIDATION_KEY,
      ),
    );
    await expect(apiKeysService.invalidateCache(KEY_HASH)).rejects.toThrow(/not confirmed/i);
  });

  test("delete(): failed invalidation aborts BEFORE the DB row is removed", async () => {
    track(spyOn(apiKeysRepository, "findById").mockResolvedValue(fakeKey()));
    const repoDelete = track(spyOn(apiKeysRepository, "delete").mockResolvedValue(undefined));
    track(spyOn(cache, "delConfirmed").mockResolvedValue(false));

    await expect(apiKeysService.delete("key-1")).rejects.toThrow(/not confirmed/i);
    // fail-closed ordering: the DB delete must NOT run once invalidation failed
    expect(repoDelete).not.toHaveBeenCalled();
  });

  test("delete(): confirmed invalidation lets the DB delete proceed", async () => {
    track(spyOn(apiKeysRepository, "findById").mockResolvedValue(fakeKey()));
    const repoDelete = track(spyOn(apiKeysRepository, "delete").mockResolvedValue(undefined));
    track(spyOn(cache, "delConfirmed").mockResolvedValue(true));

    await expect(apiKeysService.delete("key-1")).resolves.toBeUndefined();
    expect(repoDelete).toHaveBeenCalledWith("key-1");
  });

  test("invalidateInferenceContextForUser: unconfirmed fan-out throws (ban fails closed)", async () => {
    track(
      spyOn(apiKeysRepository, "listByUser").mockResolvedValue([
        fakeKey(),
        { ...fakeKey(), key_hash: "b".repeat(64) } as ApiKey,
      ]),
    );
    // second key's IAC delete is unconfirmed
    track(
      spyOn(cache, "delConfirmed").mockImplementation(
        async (key: string) => !key.includes("b".repeat(64)),
      ),
    );
    await expect(apiKeysService.invalidateInferenceContextForUser("user-1")).rejects.toThrow(
      /not confirmed/i,
    );
  });

  test("invalidateInferenceContextForUser: all confirmed resolves", async () => {
    track(spyOn(apiKeysRepository, "listByUser").mockResolvedValue([fakeKey()]));
    track(spyOn(cache, "delConfirmed").mockResolvedValue(true));
    await expect(
      apiKeysService.invalidateInferenceContextForUser("user-1"),
    ).resolves.toBeUndefined();
  });

  test("revokeForAgent: unconfirmed invalidation does NOT abort (row already deleted, best-effort)", async () => {
    // rows deleted FIRST -> credential already DB-revoked; a cache brownout must
    // not abort agent reprovisioning (codex round-2 P2).
    track(spyOn(apiKeysRepository, "deleteByName").mockResolvedValue([fakeKey()]));
    track(spyOn(cache, "delConfirmed").mockResolvedValue(false));
    await expect(apiKeysService.revokeForAgent("sandbox-1")).resolves.toBeUndefined();
  });
});
