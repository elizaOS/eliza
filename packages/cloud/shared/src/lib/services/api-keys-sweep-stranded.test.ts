/**
 * `sweepStrandedAgentKeys` behavior (#16071).
 *
 * The sweep revokes every stranded `agent-sandbox:<uuid>` key the repository
 * atomically deletes and best-effort invalidates each revoked key's auth
 * caches. Cache invalidation is best-effort by design
 * (the row is already DB-revoked): a brownout on one key must NOT abort the
 * sweep, but the failure is surfaced observably (logged), never swallowed.
 * These tests spy the repository + invalidateCache boundary so no DB or Redis
 * is needed.
 */

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { ApiKey } from "../../db/repositories";
import { strandedAgentKeyRepository } from "../../db/repositories/stranded-agent-keys";
import { apiKeysService } from "./api-keys";
import { sweepStrandedAgentKeys } from "./stranded-agent-key-sweeper";

function strandedKey(id: string): ApiKey {
  return {
    id,
    key_hash: `${id}-hash`,
    name: `agent-sandbox:sandbox-${id}`,
    organization_id: "org-1",
    user_id: "user-1",
    is_active: true,
  } as unknown as ApiKey;
}

describe("sweepStrandedAgentKeys (#16071)", () => {
  const spies: Array<{ mockRestore: () => void }> = [];

  afterEach(() => {
    for (const spy of spies.splice(0)) spy.mockRestore();
  });

  function track<T extends { mockRestore: () => void }>(spy: T): T {
    spies.push(spy);
    return spy;
  }

  test("no stranded keys -> revokes nothing, no deletes, no invalidations", async () => {
    const del = track(spyOn(strandedAgentKeyRepository, "deleteOlderThan").mockResolvedValue([]));
    const invalidate = track(spyOn(apiKeysService, "invalidateCache").mockResolvedValue());

    const revoked = await sweepStrandedAgentKeys(new Date());

    expect(revoked).toBe(0);
    expect(del).toHaveBeenCalledOnce();
    expect(invalidate).not.toHaveBeenCalled();
  });

  test("invalidates each atomically deleted key and returns the count", async () => {
    const keys = [strandedKey("k1"), strandedKey("k2"), strandedKey("k3")];
    const del = track(spyOn(strandedAgentKeyRepository, "deleteOlderThan").mockResolvedValue(keys));
    const invalidate = track(spyOn(apiKeysService, "invalidateCache").mockResolvedValue());

    const revoked = await sweepStrandedAgentKeys(new Date());

    expect(revoked).toBe(3);
    // Deleted by row id (not by name).
    expect(del).toHaveBeenCalledOnce();
    expect(invalidate.mock.calls.map((c) => c[0])).toEqual(["k1-hash", "k2-hash", "k3-hash"]);
  });

  test("passes the grace cutoff straight through to the repository query", async () => {
    const find = track(spyOn(strandedAgentKeyRepository, "deleteOlderThan").mockResolvedValue([]));
    track(spyOn(apiKeysService, "invalidateCache").mockResolvedValue());

    const cutoff = new Date("2026-01-01T00:00:00.000Z");
    await sweepStrandedAgentKeys(cutoff);

    expect(find).toHaveBeenCalledTimes(1);
    expect(find).toHaveBeenCalledWith(cutoff);
  });

  test("a cache-invalidation failure does NOT abort the sweep; every row is still revoked", async () => {
    const keys = [strandedKey("k1"), strandedKey("k2"), strandedKey("k3")];
    const del = track(spyOn(strandedAgentKeyRepository, "deleteOlderThan").mockResolvedValue(keys));
    // The MIDDLE key's invalidation throws (Redis brownout); the sweep must
    // continue and still count it as revoked (its DB row is already gone).
    const invalidate = track(
      spyOn(apiKeysService, "invalidateCache").mockImplementation(async (hash: string) => {
        if (hash === "k2-hash") throw new Error("cache down");
      }),
    );

    const revoked = await sweepStrandedAgentKeys(new Date());

    expect(revoked).toBe(3);
    expect(del).toHaveBeenCalledOnce();
    expect(invalidate.mock.calls.length).toBe(3);
  });
});
