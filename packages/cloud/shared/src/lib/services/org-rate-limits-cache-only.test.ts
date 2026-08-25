/**
 * Exercises the organization-tier cache-only contract with a real in-memory
 * cache while counting the authoritative database seams.
 */

process.env.CACHE_BACKEND = "memory";
process.env.CACHE_ENABLED = "true";

import { beforeEach, describe, expect, mock, test } from "bun:test";

let spendReads = 0;
let overrideReads = 0;
let tierSourceCreditTotal = "0";
let overrideError: Error | null = null;

mock.module("../../db/helpers", () => ({
  dbRead: {
    select: () => ({
      from: () => ({
        where: async () => {
          spendReads += 1;
          return [{ tierSourceCreditTotal }];
        },
      }),
    }),
  },
}));

mock.module("../../db/repositories/org-rate-limit-overrides", () => ({
  orgRateLimitOverridesRepository: {
    findByOrganizationId: async () => {
      overrideReads += 1;
      if (overrideError) throw overrideError;
      return undefined;
    },
  },
}));

const { cache } = await import("../cache/client");
const { CacheKeys, CacheTTL } = await import("../cache/keys");
const { __clearOrgTierHydrationsForTests, getOrgRpmForEndpointCacheOnly, getOrgTierCacheOnly } =
  await import("./org-rate-limits");

let sequence = 0;
const orgId = () => `org-tier-${++sequence}`;

beforeEach(() => {
  spendReads = 0;
  overrideReads = 0;
  tierSourceCreditTotal = "0";
  overrideError = null;
  __clearOrgTierHydrationsForTests();
});

describe("organization rate-limit tier cache-only resolution", () => {
  test("serves a warm tier without database work", async () => {
    const org = orgId();
    await cache.set(
      CacheKeys.org.rateLimitTier(org),
      {
        tierName: "paid",
        completionsRpm: 120,
        embeddingsRpm: 200,
        standardRpm: 60,
        strictRpm: 10,
      },
      CacheTTL.org.rateLimitTier,
    );

    expect(await getOrgRpmForEndpointCacheOnly(org, "completions")).toEqual({
      kind: "ready",
      config: { windowMs: 60_000, maxRequests: 120 },
    });
    expect(spendReads).toBe(0);
    expect(overrideReads).toBe(0);
  });

  test("returns warming on a miss and retains hydration under waitUntil", async () => {
    const org = orgId();
    tierSourceCreditTotal = "7";
    await cache.del(CacheKeys.org.rateLimitTier(org));
    const background: Promise<unknown>[] = [];

    expect(
      await getOrgTierCacheOnly(org, {
        executionCtx: { waitUntil: (promise) => background.push(promise) },
      }),
    ).toEqual({ kind: "warming", cacheRead: "miss" });
    expect(background).toHaveLength(1);
    await background[0];
    expect(spendReads).toBe(1);
    expect(overrideReads).toBe(1);
    expect(await getOrgTierCacheOnly(org)).toMatchObject({
      kind: "ready",
      tier: { tierName: "paid", completionsRpm: 120 },
    });
  });

  test("does not start a database read without a Worker execution context", async () => {
    const org = orgId();
    await cache.del(CacheKeys.org.rateLimitTier(org));

    expect(await getOrgTierCacheOnly(org)).toEqual({
      kind: "warming",
      cacheRead: "miss",
    });
    expect(spendReads).toBe(0);
    expect(overrideReads).toBe(0);
  });

  test("does not cache a permissive default when override hydration fails", async () => {
    const org = orgId();
    overrideError = new Error("override database unavailable");
    await cache.del(CacheKeys.org.rateLimitTier(org));
    const background: Promise<unknown>[] = [];

    expect(
      await getOrgTierCacheOnly(org, {
        executionCtx: { waitUntil: (promise) => background.push(promise) },
      }),
    ).toEqual({ kind: "warming", cacheRead: "miss" });
    await background[0];

    expect(spendReads).toBe(1);
    expect(overrideReads).toBe(1);
    expect(await getOrgTierCacheOnly(org)).toEqual({
      kind: "warming",
      cacheRead: "miss",
    });
  });

  test("coalesces concurrent cold hydration", async () => {
    const org = orgId();
    await cache.del(CacheKeys.org.rateLimitTier(org));
    const background: Promise<unknown>[] = [];
    const executionCtx = {
      waitUntil: (promise: Promise<unknown>) => background.push(promise),
    };

    expect(
      await Promise.all([
        getOrgTierCacheOnly(org, { executionCtx }),
        getOrgTierCacheOnly(org, { executionCtx }),
      ]),
    ).toEqual([
      { kind: "warming", cacheRead: "miss" },
      { kind: "warming", cacheRead: "miss" },
    ]);
    expect(background).toHaveLength(2);
    expect(background[0]).toBe(background[1]);
    await background[0];
    expect(spendReads).toBe(1);
    expect(overrideReads).toBe(1);
  });

  test("treats malformed cached policy as warming instead of authorizing it", async () => {
    const org = orgId();
    await cache.set(
      CacheKeys.org.rateLimitTier(org),
      { tierName: "paid", completionsRpm: -1 },
      CacheTTL.org.rateLimitTier,
    );

    expect(await getOrgTierCacheOnly(org)).toEqual({
      kind: "warming",
      cacheRead: "invalid",
    });
    expect(spendReads).toBe(0);
  });
});
