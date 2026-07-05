/**
 * Error-policy proof for the solana-rpc allowed-methods authorization path (#13415).
 * Drives the real exported solanaRpcConfig.getCost against spied DB + cache
 * boundaries. A DB/cache *failure* while resolving the authorization whitelist must
 * PROPAGATE (fail closed) instead of being swallowed into the hardcoded fallback —
 * swallowing it would fabricate a billable cost and fail authorization open. A DB
 * that returns zero active rows is a designed bootstrap state and must stay
 * distinguishable: it degrades to the hardcoded whitelist and still prices normally.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { servicePricingRepository } from "../../../../db/repositories";
import { cache } from "../../../cache/client";
import { solanaRpcConfig } from "./solana-rpc";

const ALLOWED_METHODS_CACHE_KEY = "solana-rpc:allowed-methods";
const PRICING_CACHE_KEY = "service-pricing:solana-rpc";

let cacheGetSpy: ReturnType<typeof spyOn>;
let cacheSetSpy: ReturnType<typeof spyOn>;
let listByServiceSpy: ReturnType<typeof spyOn>;

const singleRequest = { jsonrpc: "2.0", id: 1, method: "getBalance", params: [] } as const;

beforeEach(() => {
  cacheSetSpy = spyOn(cache, "set").mockResolvedValue(undefined);
  cacheGetSpy = spyOn(cache, "get");
  listByServiceSpy = spyOn(servicePricingRepository, "listByService");
});

afterEach(() => {
  cacheGetSpy.mockRestore();
  cacheSetSpy.mockRestore();
  listByServiceSpy.mockRestore();
});

describe("solana-rpc getCost — authorization whitelist fail-closed policy", () => {
  test("prices a healthy request from the cached whitelist + cached pricing (the success shape)", async () => {
    // Both caches warm: allowed-methods returns the whitelist, pricing returns cost.
    cacheGetSpy.mockImplementation(async (key: string) => {
      if (key === ALLOWED_METHODS_CACHE_KEY) return ["getBalance"] as never;
      if (key === PRICING_CACHE_KEY) return { getBalance: "0.001" } as never;
      return null;
    });

    const cost = await solanaRpcConfig.getCost({ ...singleRequest });

    expect(cost).toBeCloseTo(0.001, 12);
    // The DB is never touched when both caches are warm.
    expect(listByServiceSpy).not.toHaveBeenCalled();
  });

  test("PROPAGATES a cache failure on the whitelist read (never swallowed into a fabricated cost)", async () => {
    // The allowed-methods cache read throws (partial cache outage) while pricing is
    // still served from its own cache. Before the fix this was swallowed into the
    // hardcoded whitelist and getCost resolved a real billable cost — masking the
    // failure and failing authorization open. It must now fail closed.
    cacheGetSpy.mockImplementation(async (key: string) => {
      if (key === ALLOWED_METHODS_CACHE_KEY) throw new Error("cache connreset");
      if (key === PRICING_CACHE_KEY) return { getBalance: "0.001" } as never;
      return null;
    });

    await expect(solanaRpcConfig.getCost({ ...singleRequest })).rejects.toThrow("cache connreset");
  });

  test("PROPAGATES a DB failure on the whitelist read (cold cache) — fails closed", async () => {
    cacheGetSpy.mockResolvedValue(null);
    listByServiceSpy.mockRejectedValue(new Error("DB unreachable"));

    await expect(solanaRpcConfig.getCost({ ...singleRequest })).rejects.toThrow("DB unreachable");
  });

  test("designed empty-domain result stays DISTINCT: zero active rows degrades to the hardcoded whitelist and still prices", async () => {
    // A cold whitelist cache + a DB that returns zero rows is a bootstrap/seed state,
    // NOT a failure: getBalance is in the hardcoded fallback, so getCost resolves a
    // cost rather than throwing. This is the legitimately-empty result kept distinct
    // from the thrown-failure cases above.
    cacheGetSpy.mockImplementation(async (key: string) => {
      if (key === PRICING_CACHE_KEY) return { getBalance: "0.001" } as never;
      return null; // allowed-methods cache miss
    });
    // listByService is consulted only for the whitelist here (pricing is cached);
    // zero rows => empty-domain fallback.
    listByServiceSpy.mockResolvedValue([] as never);

    const cost = await solanaRpcConfig.getCost({ ...singleRequest });

    expect(cost).toBeCloseTo(0.001, 12);
  });

  test("rejects an unsupported method rather than defaulting to a billable cost", async () => {
    cacheGetSpy.mockImplementation(async (key: string) => {
      if (key === ALLOWED_METHODS_CACHE_KEY) return ["getBalance"] as never;
      return null;
    });

    await expect(
      solanaRpcConfig.getCost({ jsonrpc: "2.0", id: 1, method: "notARealMethod", params: [] }),
    ).rejects.toThrow("not supported");
  });
});
