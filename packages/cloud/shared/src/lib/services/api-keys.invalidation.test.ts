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
import { createHash } from "node:crypto";
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

const MOBILE_SECRET = `eliza_mobile_${"b".repeat(64)}`;
const MOBILE_HASH = createHash("sha256").update(MOBILE_SECRET).digest("hex");
const MOBILE_CREDENTIAL_ID = "11111111-1111-4111-8111-111111111111";
const MOBILE_APP_ID = "22222222-2222-4222-8222-222222222222";
const MOBILE_USER_ID = "33333333-3333-4333-8333-333333333333";
const MOBILE_ORG_ID = "44444444-4444-4444-8444-444444444444";
const CLI_SECRET = `eliza_cli_${"c".repeat(64)}`;
const CLI_HASH = createHash("sha256").update(CLI_SECRET).digest("hex");

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

  test("CLI credentials bypass every validation cache and read the primary each time", async () => {
    const inactive = {
      ...fakeKey(),
      key_hash: CLI_HASH,
      key_prefix: "eliza_cli_cc",
      is_active: false,
    } as ApiKey;
    const active = { ...inactive, is_active: true } as ApiKey;
    const lookup = track(
      spyOn(apiKeysRepository, "findActiveByHashConsistent")
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce(active),
    );
    const get = track(spyOn(cache, "get").mockResolvedValue(inactive));
    const set = track(spyOn(cache, "set").mockResolvedValue(undefined));

    await expect(apiKeysService.validateApiKey(CLI_SECRET)).resolves.toBeNull();
    await expect(apiKeysService.validateApiKey(CLI_SECRET)).resolves.toBe(active);

    expect(lookup).toHaveBeenCalledTimes(2);
    expect(lookup).toHaveBeenNthCalledWith(1, CLI_HASH);
    expect(lookup).toHaveBeenNthCalledWith(2, CLI_HASH);
    expect(get).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
  });

  test("generates exact-shape CLI credentials without changing ordinary keys", () => {
    expect(apiKeysService.generateCliApiKey().key).toMatch(/^eliza_cli_[0-9a-f]{64}$/);
    expect(apiKeysService.generateApiKey().key).toMatch(/^eliza_[0-9a-f]{64}$/);
    expect(apiKeysService.generateApiKey().key).not.toStartWith("eliza_cli_");
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

  test("recovery summaries preserve active, pending, expired, and revoked states", async () => {
    const now = new Date("2026-07-18T12:00:00.000Z");
    track(
      spyOn(apiKeysRepository, "listMobileByOwnerConsistent").mockResolvedValue([
        fakeMobileKey({
          id: "11111111-1111-4111-8111-111111111111",
          user_id: MOBILE_USER_ID,
          organization_id: MOBILE_ORG_ID,
          name: "Active device",
          is_active: true,
          created_at: new Date("2026-07-18T11:00:00.000Z"),
          expires_at: new Date("2026-07-18T13:00:00.000Z"),
        }),
        fakeMobileKey({
          id: "22222222-2222-4222-8222-222222222222",
          user_id: MOBILE_USER_ID,
          organization_id: MOBILE_ORG_ID,
          name: "Pending device",
          is_active: false,
          created_at: new Date("2026-07-18T10:00:00.000Z"),
          expires_at: new Date("2026-07-18T13:00:00.000Z"),
        }),
        fakeMobileKey({
          id: "33333333-3333-4333-8333-333333333333",
          user_id: MOBILE_USER_ID,
          organization_id: MOBILE_ORG_ID,
          name: "Expired device",
          is_active: true,
          created_at: new Date("2026-07-18T09:00:00.000Z"),
          expires_at: new Date("2026-07-18T11:00:00.000Z"),
        }),
        fakeMobileKey({
          id: "44444444-4444-4444-8444-444444444444",
          user_id: MOBILE_USER_ID,
          organization_id: MOBILE_ORG_ID,
          name: "Revoked device",
          is_active: false,
          created_at: new Date("2026-07-18T08:00:00.000Z"),
          deleted_at: new Date("2026-07-18T11:30:00.000Z"),
          expires_at: new Date("2026-07-18T13:00:00.000Z"),
        }),
      ]),
    );

    await expect(
      apiKeysService.listMobileCredentialsForAccount(MOBILE_USER_ID, MOBILE_ORG_ID, now),
    ).resolves.toEqual([
      expect.objectContaining({ name: "Active device", status: "active" }),
      expect.objectContaining({ name: "Pending device", status: "pending" }),
      expect.objectContaining({ name: "Expired device", status: "expired" }),
      expect.objectContaining({
        name: "Revoked device",
        status: "revoked",
        revokedAt: "2026-07-18T11:30:00.000Z",
      }),
    ]);
  });

  test("ordinary API-key validation uses cache, primary-consistent lookup, and negative cache", async () => {
    const ordinary = {
      ...fakeKey(),
      id: "55555555-5555-4555-8555-555555555555",
      organization_id: MOBILE_ORG_ID,
      user_id: MOBILE_USER_ID,
      key_prefix: "eliza_ordin",
      source_app_id: null,
    } as ApiKey;
    let cacheValue: unknown = null;
    track(spyOn(cache, "get").mockImplementation(async () => cacheValue));
    const set = track(
      spyOn(cache, "set").mockImplementation(async (_key, value) => {
        cacheValue = value;
      }),
    );
    const del = track(spyOn(cache, "del").mockResolvedValue(undefined));
    // A cache miss is a lifecycle boundary, not an eventually-consistent
    // read (see the class doc above and validateApiKey's own comment): there
    // is no replica tier on the ordinary-key path, only the primary-confirmed
    // lookup a stale replica could not repopulate positively.
    const primary = track(
      spyOn(apiKeysRepository, "findActiveByHashConsistent").mockResolvedValueOnce(ordinary),
    );

    await expect(apiKeysService.validateApiKey("eliza_ordinary")).resolves.toBe(ordinary);
    await expect(apiKeysService.validateApiKey("eliza_ordinary")).resolves.toBe(ordinary);
    expect(primary).toHaveBeenCalledTimes(1);

    cacheValue = { id: "not-a-uuid", key_hash: 123 };
    primary.mockResolvedValueOnce(undefined);
    await expect(apiKeysService.validateApiKey("eliza_missing")).resolves.toBeNull();
    expect(del).toHaveBeenCalled();
    expect(set).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.objectContaining({ __none: true }),
      60,
    );
    await expect(apiKeysService.validateApiKey("eliza_missing")).resolves.toBeNull();
  });

  test("account-owned mobile revocation is idempotent and owner-scoped", async () => {
    const revokedAt = new Date("2026-07-18T12:00:00.000Z");
    const active = fakeMobileKey({
      user_id: MOBILE_USER_ID,
      organization_id: MOBILE_ORG_ID,
    });
    const tombstone = fakeMobileKey({
      user_id: MOBILE_USER_ID,
      organization_id: MOBILE_ORG_ID,
      is_active: false,
      deleted_at: revokedAt,
    });
    track(
      spyOn(apiKeysRepository, "findMobileByOwnerConsistent")
        .mockResolvedValueOnce(active)
        .mockResolvedValueOnce(tombstone)
        .mockResolvedValueOnce(undefined),
    );
    const tombstoneByOwner = track(
      spyOn(apiKeysRepository, "tombstoneMobileByOwner").mockResolvedValueOnce(tombstone),
    );

    await expect(
      apiKeysService.revokeMobileCredentialForAccount(
        MOBILE_CREDENTIAL_ID,
        MOBILE_USER_ID,
        MOBILE_ORG_ID,
      ),
    ).resolves.toEqual({
      receipt: {
        credentialId: MOBILE_CREDENTIAL_ID,
        revokedAt: revokedAt.toISOString(),
        status: "revoked",
      },
      revokedNow: true,
    });
    expect(tombstoneByOwner).toHaveBeenCalledWith(
      MOBILE_CREDENTIAL_ID,
      MOBILE_USER_ID,
      MOBILE_ORG_ID,
      expect.any(Date),
    );

    await expect(
      apiKeysService.revokeMobileCredentialForAccount(
        MOBILE_CREDENTIAL_ID,
        MOBILE_USER_ID,
        MOBILE_ORG_ID,
      ),
    ).resolves.toEqual({
      receipt: expect.objectContaining({ credentialId: MOBILE_CREDENTIAL_ID }),
      revokedNow: false,
    });
    await expect(
      apiKeysService.revokeMobileCredentialForAccount("not-a-uuid", MOBILE_USER_ID, MOBILE_ORG_ID),
    ).resolves.toBeNull();
    await expect(
      apiKeysService.revokeMobileCredentialForAccount(
        MOBILE_CREDENTIAL_ID,
        MOBILE_USER_ID,
        MOBILE_ORG_ID,
      ),
    ).resolves.toBeNull();
  });

  test("generic update and delete reject mobile-owned credentials before mutation", async () => {
    track(spyOn(apiKeysRepository, "findByIdConsistent").mockResolvedValue(fakeMobileKey()));
    const update = track(spyOn(apiKeysRepository, "update").mockResolvedValue(undefined));
    const repoDelete = track(spyOn(apiKeysRepository, "delete").mockResolvedValue(undefined));

    await expect(apiKeysService.update(MOBILE_CREDENTIAL_ID, { is_active: false })).rejects.toThrow(
      /mobile-issued/i,
    );
    await expect(apiKeysService.delete(MOBILE_CREDENTIAL_ID)).rejects.toThrow(/mobile-issued/i);
    expect(update).not.toHaveBeenCalled();
    expect(repoDelete).not.toHaveBeenCalled();
  });

  test("simple service wrappers delegate and mobile keys keep their distinct prefix", async () => {
    const mobile = apiKeysService.generateMobileApiKey();
    expect(mobile.key).toStartWith("eliza_mobile_");

    const getById = track(spyOn(apiKeysRepository, "findById").mockResolvedValue(fakeKey()));
    const getManageable = track(
      spyOn(apiKeysRepository, "findManageableById").mockResolvedValue(fakeKey()),
    );
    const listOrg = track(spyOn(apiKeysRepository, "listByOrganization").mockResolvedValue([]));
    const listUser = track(spyOn(apiKeysRepository, "listByUser").mockResolvedValue([]));
    const increment = track(spyOn(apiKeysRepository, "incrementUsage").mockResolvedValue());

    await expect(apiKeysService.getById("key-1")).resolves.toMatchObject({ id: "key-1" });
    await expect(apiKeysService.getManageableById("key-1")).resolves.toMatchObject({
      id: "key-1",
    });
    await expect(apiKeysService.listByOrganization("org-1")).resolves.toEqual([]);
    await expect(apiKeysService.listByUser("user-1")).resolves.toEqual([]);
    await expect(apiKeysService.incrementUsage("key-1")).resolves.toBeUndefined();
    await expect(apiKeysService.incrementUsageDebounced("key-1")).resolves.toBeUndefined();

    expect(getById).toHaveBeenCalledWith("key-1");
    expect(getManageable).toHaveBeenCalledWith("key-1");
    expect(listOrg).toHaveBeenCalledWith("org-1");
    expect(listUser).toHaveBeenCalledWith("user-1");
    expect(increment).toHaveBeenCalled();
  });

  test("default-key self-heal validates inputs and reports strict provisioner failures", async () => {
    await expect(apiKeysService.provisionDefaultApiKey("", MOBILE_ORG_ID)).rejects.toThrow(
      /invalid userid/i,
    );
    await expect(apiKeysService.ensureUserHasApiKey("", MOBILE_ORG_ID)).resolves.toBeUndefined();

    const provision = track(
      spyOn(apiKeysService, "provisionDefaultApiKey").mockRejectedValue(
        new Error("primary insert failed"),
      ),
    );
    await expect(
      apiKeysService.ensureUserHasApiKey(MOBILE_USER_ID, MOBILE_ORG_ID),
    ).resolves.toBeUndefined();
    expect(provision).toHaveBeenCalledWith(MOBILE_USER_ID, MOBILE_ORG_ID);
  });

  test("agent and user deactivation flows invalidate every ordinary key they touch", async () => {
    const userKey = { ...fakeKey(), organization_id: MOBILE_ORG_ID, is_active: true } as ApiKey;
    const otherOrgKey = {
      ...fakeKey(),
      key_hash: "c".repeat(64),
      organization_id: "55555555-5555-4555-8555-555555555555",
      is_active: true,
    } as ApiKey;
    const invalidate = track(spyOn(apiKeysService, "invalidateCache").mockResolvedValue());
    // The service reads through the *Consistent (primary) lookups before
    // deactivating — see the class doc's primary-confirmed contract — not
    // the plain findByUserAndName/listByUser replica reads.
    const findNamed = track(
      spyOn(apiKeysRepository, "findActiveByUserAndNameConsistent").mockResolvedValue([userKey]),
    );
    const deactivateNamed = track(
      spyOn(apiKeysRepository, "deactivateUserKeysByName").mockResolvedValue(),
    );
    const listByUser = track(
      // The repository query itself filters to (userId, organizationId,
      // is_active) — a real call could never return a different org's key,
      // unlike the old client-side-filtered listByUser(userId) this replaced.
      spyOn(apiKeysRepository, "listActiveByUserAndOrganizationConsistent").mockResolvedValue([
        userKey,
      ]),
    );
    const deactivateOrg = track(
      spyOn(apiKeysRepository, "deactivateByUserAndOrganization").mockResolvedValue(),
    );
    const revokeForAgent = track(spyOn(apiKeysService, "revokeForAgent").mockResolvedValue());
    const create = track(
      spyOn(apiKeysService, "create").mockResolvedValue({
        apiKey: userKey,
        plainKey: "eliza_agent_plain",
      }),
    );

    await expect(
      apiKeysService.deactivateUserKeysByName("user-1", "Default API Key"),
    ).resolves.toBeUndefined();
    await expect(
      apiKeysService.deactivateByUserAndOrganization("user-1", MOBILE_ORG_ID),
    ).resolves.toBeUndefined();
    await expect(
      apiKeysService.createForAgent({
        organizationId: MOBILE_ORG_ID,
        userId: MOBILE_USER_ID,
        agentSandboxId: "sandbox-1",
      }),
    ).resolves.toEqual({ apiKey: userKey, plainKey: "eliza_agent_plain" });

    expect(findNamed).toHaveBeenCalledWith("user-1", "Default API Key");
    expect(deactivateNamed).toHaveBeenCalledWith("user-1", "Default API Key");
    expect(listByUser).toHaveBeenCalledWith("user-1", MOBILE_ORG_ID);
    expect(deactivateOrg).toHaveBeenCalledWith("user-1", MOBILE_ORG_ID);
    expect(invalidate).toHaveBeenCalledWith(userKey.key_hash);
    expect(invalidate).not.toHaveBeenCalledWith(otherOrgKey.key_hash);
    expect(revokeForAgent).toHaveBeenCalledWith("sandbox-1", undefined);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "agent-sandbox:sandbox-1",
        organization_id: MOBILE_ORG_ID,
        user_id: MOBILE_USER_ID,
      }),
      undefined,
    );
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
