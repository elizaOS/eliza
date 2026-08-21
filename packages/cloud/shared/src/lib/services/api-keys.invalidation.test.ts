/**
 * API-key revocation cache-invalidation and primary-read ordering fail closed
 * across the established lifecycle paths (#13417, #22920).
 *
 * `apiKeysService.invalidateCache()` is on every revoke / delete / deactivate
 * path. It clears BOTH the validation cache (16-char prefix) and the #9899
 * inference hot-path auth-context entry. Previously it fired both `cache.del`
 * calls inside a `Promise.all` and discarded their result, and `cache.del`
 * itself swallowed a backend failure — so a Redis `del` that never landed left
 * a REVOKED key authenticating from cache until its TTL lapsed, while the
 * revoke path reported success.
 *
 * These tests pin the corrected contract: lifecycle mutations commit the
 * database denial before invalidating caches, and a cache miss confirms a
 * positive key on the primary before caching it. This removes the window in
 * which a request can repopulate a warm positive entry from a still-active or
 * replica-stale row.
 */

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as apiKeyCrypto from "../../db/crypto/api-keys";
import type { ApiKey } from "../../db/repositories";
import { apiKeysRepository } from "../../db/repositories";
import { cache } from "../cache/client";
import { CacheKeys } from "../cache/keys";
import { runWithCloudBindingsAsync } from "../runtime/cloud-bindings";
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

  test("delete(): database denial commits before failed cache invalidation surfaces", async () => {
    track(spyOn(apiKeysRepository, "findByIdConsistent").mockResolvedValue(fakeKey()));
    const events: string[] = [];
    const repoDelete = track(
      spyOn(apiKeysRepository, "delete").mockImplementation(async () => {
        events.push("database-delete");
      }),
    );
    track(
      spyOn(cache, "delConfirmed").mockImplementation(async () => {
        events.push("cache-delete");
        return false;
      }),
    );

    await expect(apiKeysService.delete("key-1")).rejects.toThrow(/not confirmed/i);
    expect(repoDelete).toHaveBeenCalledWith("key-1");
    expect(events[0]).toBe("database-delete");
  });

  test("update commits the primary row before invalidating its positive caches", async () => {
    track(spyOn(apiKeysRepository, "findByIdConsistent").mockResolvedValue(fakeKey()));
    const events: string[] = [];
    track(
      spyOn(apiKeysRepository, "update").mockImplementation(async () => {
        events.push("database-update");
        return { ...fakeKey(), description: "updated" } as ApiKey;
      }),
    );
    track(
      spyOn(cache, "delConfirmed").mockImplementation(async () => {
        events.push("cache-delete");
        return true;
      }),
    );

    await apiKeysService.update("key-1", { description: "updated" });
    expect(events[0]).toBe("database-update");
    expect(events.filter((event) => event === "cache-delete")).toHaveLength(2);
  });

  test("cache miss never trusts a replica-only active key", async () => {
    track(spyOn(cache, "get").mockResolvedValue(null));
    track(spyOn(cache, "set").mockResolvedValue(undefined));
    const replica = track(
      spyOn(apiKeysRepository, "findActiveByHash").mockResolvedValue(fakeKey()),
    );
    const primary = track(
      spyOn(apiKeysRepository, "findActiveByHashConsistent").mockResolvedValue(undefined),
    );

    await expect(apiKeysService.validateApiKey("revoked-secret")).resolves.toBeNull();
    expect(replica).not.toHaveBeenCalled();
    expect(primary).toHaveBeenCalledTimes(1);
  });

  test("bulk deactivation commits before attempting every cache invalidation", async () => {
    const keys = [fakeKey(), { ...fakeKey(), id: "key-2", key_hash: "b".repeat(64) } as ApiKey];
    const primaryKeys = track(
      spyOn(apiKeysRepository, "findActiveByUserAndNameConsistent").mockResolvedValue(keys),
    );
    const replicaKeys = track(spyOn(apiKeysRepository, "findByUserAndName").mockResolvedValue([]));
    const events: string[] = [];
    track(
      spyOn(apiKeysRepository, "deactivateUserKeysByName").mockImplementation(async () => {
        events.push("database-deactivate");
      }),
    );
    track(
      spyOn(cache, "delConfirmed").mockImplementation(async () => {
        events.push("cache-delete");
        return true;
      }),
    );

    await apiKeysService.deactivateUserKeysByName("user-1", "Default API Key");
    expect(primaryKeys).toHaveBeenCalledTimes(1);
    expect(replicaKeys).not.toHaveBeenCalled();
    expect(events[0]).toBe("database-deactivate");
    expect(events.filter((event) => event === "cache-delete")).toHaveLength(4);
  });

  test("organization deactivation enumerates active keys on the primary", async () => {
    const key = fakeKey();
    const primaryKeys = track(
      spyOn(apiKeysRepository, "listActiveByUserAndOrganizationConsistent").mockResolvedValue([
        key,
      ]),
    );
    const replicaKeys = track(spyOn(apiKeysRepository, "listByUser").mockResolvedValue([]));
    const events: string[] = [];
    track(
      spyOn(apiKeysRepository, "deactivateByUserAndOrganization").mockImplementation(async () => {
        events.push("database-deactivate");
      }),
    );
    track(
      spyOn(cache, "delConfirmed").mockImplementation(async () => {
        events.push("cache-delete");
        return true;
      }),
    );

    await apiKeysService.deactivateByUserAndOrganization("user-1", "org-1");
    expect(primaryKeys).toHaveBeenCalledTimes(1);
    expect(replicaKeys).not.toHaveBeenCalled();
    expect(events[0]).toBe("database-deactivate");
    expect(events.filter((event) => event === "cache-delete")).toHaveLength(2);
  });

  test("delete(): confirmed invalidation lets the DB delete proceed", async () => {
    track(spyOn(apiKeysRepository, "findByIdConsistent").mockResolvedValue(fakeKey()));
    const repoDelete = track(spyOn(apiKeysRepository, "delete").mockResolvedValue(undefined));
    track(spyOn(cache, "delConfirmed").mockResolvedValue(true));

    await expect(apiKeysService.delete("key-1")).resolves.toBeUndefined();
    expect(repoDelete).toHaveBeenCalledWith("key-1");
  });

  test("delete(): strong revocation must commit before cache or database mutation", async () => {
    track(spyOn(apiKeysRepository, "findByIdConsistent").mockResolvedValue(fakeKey()));
    const repoDelete = track(spyOn(apiKeysRepository, "delete").mockResolvedValue(undefined));
    const cacheDelete = track(spyOn(cache, "delConfirmed").mockResolvedValue(true));
    const namespace = {
      getByName: () => ({
        fetch: async () => Response.json({ error: "unavailable" }, { status: 503 }),
      }),
    };

    await expect(
      runWithCloudBindingsAsync(
        {
          INFERENCE_STRONG_REVOCATION_ENABLED: "true",
          INFERENCE_ADMISSION_GATES: namespace,
        },
        () => apiKeysService.delete("key-1"),
      ),
    ).rejects.toThrow(/status 503/i);
    expect(cacheDelete).not.toHaveBeenCalled();
    expect(repoDelete).not.toHaveBeenCalled();
  });

  test("an inactive immutable key identity cannot be reactivated", async () => {
    track(
      spyOn(apiKeysRepository, "findByIdConsistent").mockResolvedValue({
        ...fakeKey(),
        is_active: false,
      }),
    );
    const repoUpdate = track(spyOn(apiKeysRepository, "update").mockResolvedValue(undefined));

    await expect(apiKeysService.update("key-1", { is_active: true })).rejects.toMatchObject({
      code: "API_KEY_IDENTITY_REVOKED",
    });
    expect(repoUpdate).not.toHaveBeenCalled();
  });

  test("regenerate permanently revokes the old identity and atomically replaces its row", async () => {
    const existing = {
      ...fakeKey(),
      name: "rotated key",
      description: null,
      rate_limit: 1000,
      expires_at: null,
    } as ApiKey;
    track(spyOn(apiKeysRepository, "findByIdConsistent").mockResolvedValue(existing));
    track(spyOn(cache, "delConfirmed").mockResolvedValue(true));
    track(
      spyOn(apiKeyCrypto, "encryptApiKey").mockResolvedValue({
        ciphertext: "ciphertext",
        nonce: "nonce",
        auth_tag: "tag",
        kms_key_id: "kms-key",
        kms_key_version: 1,
      }),
    );
    const replacement = { ...existing, id: "key-2", key_hash: "b".repeat(64) };
    const replace = track(spyOn(apiKeysRepository, "replace").mockResolvedValue(replacement));
    const revocations: Array<Record<string, unknown>> = [];
    const namespace = {
      getByName: () => ({
        fetch: async (request: Request) => {
          revocations.push(await request.json());
          return Response.json({ committed: true });
        },
      }),
    };

    const result = await runWithCloudBindingsAsync(
      {
        INFERENCE_STRONG_REVOCATION_ENABLED: "true",
        INFERENCE_ADMISSION_GATES: namespace,
      },
      () => apiKeysService.regenerate(existing.id),
    );

    expect(revocations).toEqual([
      {
        organizationId: "org-1",
        kind: "api_key",
        credentialId: "key-1",
      },
    ]);
    expect(replace).toHaveBeenCalledTimes(1);
    expect(replace.mock.calls[0]?.[0]).toBe("key-1");
    expect(replace.mock.calls[0]?.[1].id).not.toBe("key-1");
    expect(result.apiKey.id).toBe("key-2");
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

  test("confirmRevocationAfterCommit attempts EVERY hash even when the first fails", async () => {
    const HASH_A = "a".repeat(64);
    const HASH_B = "b".repeat(64);
    const attempted: string[] = [];
    track(
      spyOn(cache, "delConfirmed").mockImplementation(async (key: string) => {
        attempted.push(key);
        // Fail only the FIRST hash's validation entry.
        return !key.includes(HASH_A.substring(0, 16));
      }),
    );

    await expect(apiKeysService.confirmRevocationAfterCommit([HASH_A, HASH_B])).rejects.toThrow(
      /not confirmed for 1\/2/i,
    );

    // The load-bearing assertion: a fail-fast loop never reaches HASH_B, which
    // would strand a second superseded credential while reporting only one.
    expect(attempted.some((k) => k.includes(HASH_B.substring(0, 16)))).toBe(true);
  });

  test("confirmRevocationAfterCommit resolves quietly when every hash is confirmed", async () => {
    track(spyOn(cache, "delConfirmed").mockResolvedValue(true));
    await expect(
      apiKeysService.confirmRevocationAfterCommit(["c".repeat(64), "d".repeat(64)]),
    ).resolves.toBeUndefined();
  });

  test("revokeForAgent: unconfirmed invalidation does NOT abort, and PARKS the row instead of deleting it", async () => {
    // The row is deactivated FIRST -> credential already DB-revoked; a cache
    // brownout must not abort agent reprovisioning (codex round-2 P2). The row
    // survives inactive as the durable carry so a later pass re-offers its
    // hash (codex round-3 P1) — hard-deleting here would lose it forever.
    track(spyOn(apiKeysRepository, "deactivateByNameReturningAll").mockResolvedValue([fakeKey()]));
    const reap = track(spyOn(apiKeysRepository, "delete").mockResolvedValue(undefined));
    track(spyOn(cache, "delConfirmed").mockResolvedValue(false));
    await expect(apiKeysService.revokeForAgent("sandbox-1")).resolves.toEqual([fakeKey().key_hash]);
    expect(reap).not.toHaveBeenCalled();
  });

  test("revokeForAgent without a tx reaps the row once its invalidation is CONFIRMED", async () => {
    track(spyOn(apiKeysRepository, "deactivateByNameReturningAll").mockResolvedValue([fakeKey()]));
    const reap = track(spyOn(apiKeysRepository, "delete").mockResolvedValue(undefined));
    track(spyOn(cache, "delConfirmed").mockResolvedValue(true));
    await expect(apiKeysService.revokeForAgent("sandbox-1")).resolves.toEqual([fakeKey().key_hash]);
    // Authoritative pass succeeded -> nothing left to carry, row reaped.
    expect(reap).toHaveBeenCalledWith(fakeKey().id);
  });
});
