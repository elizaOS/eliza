// Pins the fail-closed error policy of the proxy inference-billing pricing path.
// The load-bearing distinction: an INTERNAL failure (the pricing repository read
// throwing — DB down, query error) must PROPAGATE so billing surfaces the fault,
// whereas a legitimately-empty result (zero pricing rows for a not-yet-seeded
// serviceId) is a designed money-path fallback ($0.001 undercharge) and stays
// DISTINCT from that failure. A non-finite stored price and a missing method on a
// populated table also fail closed (throw) rather than fabricating a cost.
// Drives the REAL pricing module; only the two runtime boundaries (DB repo read,
// cache I/O) are spied — no arithmetic is stubbed. See pricing-fallback.test.ts
// for the designed-empty happy path; this file pins the failure/invalid paths.
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { servicePricingRepository } from "../../../db/repositories";
import { cache } from "../../cache/client";
import {
  calculateBatchCost,
  getServiceMethodCost,
  invalidateServicePricingCache,
  PricingNotFoundError,
} from "./pricing";

const SERVICE_ID = "pricing-error-policy-test-service";

let listByServiceSpy: ReturnType<typeof spyOn>;
let cacheGetSpy: ReturnType<typeof spyOn>;
let cacheSetSpy: ReturnType<typeof spyOn>;

beforeEach(async () => {
  await invalidateServicePricingCache(SERVICE_ID);
  // Cold cache on every test so the repository read path always runs.
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

describe("getServiceMethodCost — internal failure vs designed-empty", () => {
  test("internal failure PROPAGATES: a throwing repository read rejects, never degrades to the fallback", async () => {
    const dbError = new Error("connection reset by peer");
    listByServiceSpy.mockRejectedValue(dbError);

    // The billing fault must surface — it must NOT be masked as the $0.001
    // designed-empty fallback (that would silently undercharge on a real outage).
    await expect(getServiceMethodCost(SERVICE_ID, "getPrice")).rejects.toThrow(
      "connection reset by peer",
    );
    // A rejected load is not cached.
    expect(cacheSetSpy).not.toHaveBeenCalled();
  });

  test("designed-empty stays DISTINCT: zero rows yield the fallback, not a throw", async () => {
    listByServiceSpy.mockResolvedValue([] as never);

    const cost = await getServiceMethodCost(SERVICE_ID, "getPrice");

    expect(cost).toBe(0.001);
    // The empty map is intentionally NOT cached (self-heals when rows land).
    expect(cacheSetSpy).not.toHaveBeenCalled();
  });

  test("populated table + unknown method fails closed with PricingNotFoundError, not a fabricated cost", async () => {
    listByServiceSpy.mockResolvedValue([{ method: "getPrice", cost: "0.0003" }] as never);

    await expect(getServiceMethodCost(SERVICE_ID, "unlistedMethod")).rejects.toBeInstanceOf(
      PricingNotFoundError,
    );
  });

  test("non-finite stored price fails closed (throws), never returns NaN as a cost", async () => {
    listByServiceSpy.mockResolvedValue([{ method: "getPrice", cost: "not-a-number" }] as never);

    await expect(getServiceMethodCost(SERVICE_ID, "getPrice")).rejects.toThrow(/Invalid pricing/);
  });
});

describe("calculateBatchCost — failure propagation", () => {
  test("a throwing per-method cost lookup propagates out of the batch sum", async () => {
    listByServiceSpy.mockRejectedValue(new Error("db offline"));

    await expect(
      calculateBatchCost(
        SERVICE_ID,
        new Set(["eth_getBalance"]),
        [{ method: "eth_getBalance" }, { method: "eth_getBalance" }],
        10,
      ),
    ).rejects.toThrow("db offline");
  });

  test("designed-empty pricing still resolves the batch via the fallback (distinct from failure)", async () => {
    listByServiceSpy.mockResolvedValue([] as never);

    const total = await calculateBatchCost(
      SERVICE_ID,
      new Set(["eth_getBalance"]),
      [{ method: "eth_getBalance" }, { method: "eth_getBalance" }],
      10,
    );

    // Two calls at the $0.001 fallback each.
    expect(total).toBeCloseTo(0.002, 12);
  });
});
