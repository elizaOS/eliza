/**
 * Proxy pricing fallback behavior (#10269).
 *
 * When a service's DB pricing rows are missing (a partially-seeded DB or a new
 * serviceId shipped without a seed), `getServiceMethodCost` must:
 *   (1) return a fail-safe sub-cent FALLBACK_COST of $0.001 — NOT the old
 *       $1.00/call (~1,000–20,000x the real price); and
 *   (2) NOT cache the empty pricing map, so a transient/partial-seed miss
 *       self-heals on the next call once the rows land (caching it would pin the
 *       fallback for the whole TTL, up to 5 min).
 *
 * Tests the REAL pricing module: only the DB repository read and the cache I/O
 * (the two runtime boundaries) are spied.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { servicePricingRepository } from "../../../db/repositories";
import { cache } from "../../cache/client";
import { getServiceMethodCost, invalidateServicePricingCache } from "./pricing";

const SERVICE_ID = "pricing-fallback-test-service";

let listByServiceSpy: ReturnType<typeof spyOn>;
let cacheGetSpy: ReturnType<typeof spyOn>;
let cacheSetSpy: ReturnType<typeof spyOn>;

beforeEach(async () => {
  // Start every test from a cold cache + no inflight load for this serviceId.
  await invalidateServicePricingCache(SERVICE_ID);
  // Cache is always a cold miss here so the repository read path runs.
  cacheGetSpy = spyOn(cache, "get").mockResolvedValue(null);
  cacheSetSpy = spyOn(cache, "set").mockResolvedValue(undefined);
  listByServiceSpy = spyOn(servicePricingRepository, "listByService");
});

afterEach(async () => {
  cacheGetSpy.mockRestore();
  cacheSetSpy.mockRestore();
  listByServiceSpy.mockRestore();
  await invalidateServicePricingCache(SERVICE_ID);
});

describe("getServiceMethodCost — missing-pricing fallback", () => {
  test("returns the $0.001 fail-safe fallback when no DB rows exist", async () => {
    listByServiceSpy.mockResolvedValue([]);

    const cost = await getServiceMethodCost(SERVICE_ID, "getPrice");

    expect(cost).toBe(0.001);
    // Sanity: the fallback is well under a cent (not the old $1.00 over-charge).
    expect(cost).toBeLessThan(0.01);
  });

  test("does NOT cache the empty pricing map (so a partial-seed miss self-heals)", async () => {
    listByServiceSpy.mockResolvedValue([]);

    await getServiceMethodCost(SERVICE_ID, "getPrice");

    // The empty map must never be written to the cache.
    expect(cacheSetSpy).not.toHaveBeenCalled();
  });

  test("self-heals once the pricing rows land (no stale empty-map cache)", async () => {
    // First call: rows are missing → fallback, nothing cached.
    listByServiceSpy.mockResolvedValueOnce([]);
    const first = await getServiceMethodCost(SERVICE_ID, "getPrice");
    expect(first).toBe(0.001);

    // Rows are seeded before the next call. Because the empty map was not
    // cached, the next read hits the DB again and picks up the real price.
    listByServiceSpy.mockResolvedValueOnce([{ method: "getPrice", cost: "0.0003" }] as never);
    const second = await getServiceMethodCost(SERVICE_ID, "getPrice");

    expect(second).toBeCloseTo(0.0003, 12);
    // A non-empty map IS cached for the TTL.
    expect(cacheSetSpy).toHaveBeenCalledTimes(1);
  });
});
