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
import { createHash } from "node:crypto";
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

const MOBILE_SECRET = `eliza_mobile_${"b".repeat(64)}`;
const MOBILE_HASH = createHash("sha256").update(MOBILE_SECRET).digest("hex");
const MOBILE_CREDENTIAL_ID = "11111111-1111-4111-8111-111111111111";
const MOBILE_APP_ID = "22222222-2222-4222-8222-222222222222";
const MOBILE_USER_ID = "33333333-3333-4333-8333-333333333333";
const MOBILE_ORG_ID = "44444444-4444-4444-8444-444444444444";

function fakeMobileKey(overrides: Partial<ApiKey> = {}): ApiKey {
  return {
    ...fakeKey(),
    id: MOBILE_CREDENTIAL_ID,
    key_hash: MOBILE_HASH,
    source_app_id: MOBILE_APP_ID,
    expires_at: new Date(Date.now() + 60_000),
    ...overrides,
  } as ApiKey;
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

  test("authoritative random mobile misses are negative-cached by full hash", async () => {
    let cached: unknown = null;
    const lookup = track(
      spyOn(apiKeysRepository, "findByHashConsistent").mockResolvedValue(undefined),
    );
    track(spyOn(cache, "get").mockImplementation(async () => cached));
    const set = track(
      spyOn(cache, "set").mockImplementation(async (_key, value) => {
        cached = value;
      }),
    );

    await expect(apiKeysService.validateApiKey(MOBILE_SECRET)).resolves.toBeNull();
    await expect(apiKeysService.validateApiKey(MOBILE_SECRET)).resolves.toBeNull();

    expect(lookup).toHaveBeenCalledTimes(1);
    expect(set).toHaveBeenCalledWith(
      CacheKeys.apiKey.mobileValidationMiss(MOBILE_HASH),
      expect.objectContaining({ __none: true }),
      60,
    );
  });

  test("inactive mobile rows are never negative-cached before ACK", async () => {
    const inactive = fakeMobileKey({ is_active: false });
    const active = fakeMobileKey({ is_active: true });
    track(
      spyOn(apiKeysRepository, "findByHashConsistent")
        .mockResolvedValueOnce(inactive)
        .mockResolvedValueOnce(active),
    );
    track(spyOn(cache, "get").mockResolvedValue(null));
    const set = track(spyOn(cache, "set").mockResolvedValue(undefined));

    await expect(apiKeysService.validateApiKey(MOBILE_SECRET)).resolves.toBeNull();
    await expect(apiKeysService.validateApiKey(MOBILE_SECRET)).resolves.toMatchObject({
      id: MOBILE_CREDENTIAL_ID,
      is_active: true,
    });
    expect(set).not.toHaveBeenCalled();
  });

  test("recovery summaries expose a corrupt missing expiry as invalid, never active", async () => {
    track(
      spyOn(apiKeysRepository, "listMobileByOwnerConsistent").mockResolvedValue([
        fakeMobileKey({
          user_id: MOBILE_USER_ID,
          organization_id: MOBILE_ORG_ID,
          name: "Eliza mobile - test device",
          expires_at: null,
          created_at: new Date("2026-07-18T12:00:00.000Z"),
        }),
      ]),
    );

    await expect(
      apiKeysService.listMobileCredentialsForAccount(MOBILE_USER_ID, MOBILE_ORG_ID),
    ).resolves.toEqual([
      expect.objectContaining({
        id: MOBILE_CREDENTIAL_ID,
        status: "invalid",
        expiresAt: null,
      }),
    ]);
  });

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
    track(spyOn(apiKeysRepository, "findByIdConsistent").mockResolvedValue(fakeKey()));
    const repoDelete = track(spyOn(apiKeysRepository, "delete").mockResolvedValue(undefined));
    track(spyOn(cache, "delConfirmed").mockResolvedValue(false));

    await expect(apiKeysService.delete("key-1")).rejects.toThrow(/not confirmed/i);
    // fail-closed ordering: the DB delete must NOT run once invalidation failed
    expect(repoDelete).not.toHaveBeenCalled();
  });

  test("delete(): confirmed invalidation lets the DB delete proceed", async () => {
    track(spyOn(apiKeysRepository, "findByIdConsistent").mockResolvedValue(fakeKey()));
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

  test("a response-loss retry returns its mobile tombstone without depending on cache health", async () => {
    const revokedAt = new Date("2026-07-18T12:00:00.000Z");
    track(
      spyOn(apiKeysRepository, "findByHashConsistent").mockResolvedValue(
        fakeMobileKey({
          is_active: false,
          deleted_at: revokedAt,
        }),
      ),
    );
    const invalidate = track(
      spyOn(apiKeysService, "invalidateCache").mockRejectedValue(
        new Error("configured cache backend is unavailable"),
      ),
    );

    await expect(apiKeysService.revokePresentedMobileCredential(MOBILE_SECRET)).resolves.toEqual({
      receipt: {
        credentialId: MOBILE_CREDENTIAL_ID,
        revokedAt: revokedAt.toISOString(),
        status: "revoked",
      },
      revokedNow: false,
      userId: "user-1",
      organizationId: "org-1",
    });
    expect(invalidate).not.toHaveBeenCalled();
  });

  test("a concurrent tombstone loser returns success without depending on cache health", async () => {
    const revokedAt = new Date("2026-07-18T12:00:00.000Z");
    const active = fakeMobileKey();
    const tombstone = fakeMobileKey({
      is_active: false,
      deleted_at: revokedAt,
    });
    track(
      spyOn(apiKeysRepository, "findByHashConsistent")
        .mockResolvedValueOnce(active)
        .mockResolvedValueOnce(tombstone),
    );
    track(spyOn(apiKeysRepository, "tombstoneExactMobileCredential").mockResolvedValue(undefined));
    const invalidate = track(
      spyOn(apiKeysService, "invalidateCache").mockRejectedValue(
        new Error("configured cache backend is unavailable"),
      ),
    );

    await expect(
      apiKeysService.revokePresentedMobileCredential(MOBILE_SECRET),
    ).resolves.toMatchObject({
      receipt: {
        credentialId: MOBILE_CREDENTIAL_ID,
        status: "revoked",
      },
      revokedNow: false,
    });
    expect(invalidate).not.toHaveBeenCalled();
  });
});
