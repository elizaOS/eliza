/**
 * getCachedExternalEntries negative-caching: a failing external-catalog fetch
 * (e.g. Cerebras retiring its public catalog → permanent 404) must NOT be
 * re-run on every hot-path pricing lookup. Regression guard for the prod
 * latency issue where the failing fetch ran 2x per chat request.
 */
import { expect, test } from "bun:test";
import type { AiPricingEntry } from "../../../db/schemas/ai-pricing";
import {
  __clearPersistedPricingCache,
  getCachedExternalEntries,
  getCachedPersistedEntries,
} from "./cache";
import type { PreparedPricingEntry } from "./types";

test("negative-caches a failing loader — subsequent lookups skip the re-fetch", async () => {
  let calls = 0;
  const loader = async (): Promise<PreparedPricingEntry[]> => {
    calls++;
    throw new Error("upstream 404");
  };

  // First call: the failure propagates so the caller degrades to seed/cached
  // pricing (unchanged behavior); the loader is invoked exactly once.
  await expect(getCachedExternalEntries("test:neg", loader)).rejects.toThrow("upstream 404");
  expect(calls).toBe(1);

  // Subsequent call within the negative TTL: returns the cached empty result
  // WITHOUT re-invoking the (slow, failing) loader.
  const second = await getCachedExternalEntries("test:neg", loader);
  expect(second).toEqual([]);
  expect(calls).toBe(1);
});

test("caches a successful loader result — loader runs once", async () => {
  let calls = 0;
  const entry = {
    model: "m",
    provider: "p",
  } as unknown as PreparedPricingEntry;
  const loader = async (): Promise<PreparedPricingEntry[]> => {
    calls++;
    return [entry];
  };

  expect(await getCachedExternalEntries("test:pos", loader)).toEqual([entry]);
  expect(await getCachedExternalEntries("test:pos", loader)).toEqual([entry]);
  expect(calls).toBe(1);
});

test("persisted: caches a successful DB read — loader runs once within TTL", async () => {
  __clearPersistedPricingCache();
  let calls = 0;
  const row = {
    model: "gpt-oss-120b",
    provider: "cerebras",
  } as unknown as AiPricingEntry;
  const loader = async (): Promise<AiPricingEntry[]> => {
    calls++;
    return [row];
  };
  expect(await getCachedPersistedEntries("k1", loader)).toEqual([row]);
  expect(await getCachedPersistedEntries("k1", loader)).toEqual([row]);
  expect(calls).toBe(1);
});

test("persisted: does NOT negative-cache a DB error — the next call retries", async () => {
  __clearPersistedPricingCache();
  let calls = 0;
  const loader = async (): Promise<AiPricingEntry[]> => {
    calls++;
    throw new Error("db transient");
  };
  // Unlike the external catalog (permanent 404 → negative-cache), a DB error is
  // transient and must re-run on the next request.
  await expect(getCachedPersistedEntries("k2", loader)).rejects.toThrow("db transient");
  await expect(getCachedPersistedEntries("k2", loader)).rejects.toThrow("db transient");
  expect(calls).toBe(2);
});

test("persisted: distinct keys cache independently (no cross-key bleed)", async () => {
  __clearPersistedPricingCache();
  const a = { model: "a" } as unknown as AiPricingEntry;
  const b = { model: "b" } as unknown as AiPricingEntry;
  expect(await getCachedPersistedEntries("ka", async () => [a])).toEqual([a]);
  expect(await getCachedPersistedEntries("kb", async () => [b])).toEqual([b]);
  // 'ka' stays cached as [a] even though this loader would return [b].
  expect(await getCachedPersistedEntries("ka", async () => [b])).toEqual([a]);
});

test("persisted: concurrent cold misses for the same key coalesce onto one read (#16162)", async () => {
  __clearPersistedPricingCache();
  const row = { model: "m" } as unknown as AiPricingEntry;
  let calls = 0;
  const gate = Promise.withResolvers<AiPricingEntry[]>();
  const loader = (): Promise<AiPricingEntry[]> => {
    calls++;
    return gate.promise;
  };

  // Both fired before either resolves — the hot-path shape lookup.ts produces.
  const p1 = getCachedPersistedEntries("cc", loader);
  const p2 = getCachedPersistedEntries("cc", loader);
  gate.resolve([row]);

  expect(await p1).toEqual([row]);
  expect(await p2).toEqual([row]);
  expect(calls).toBe(1); // one shared read, not two duplicate DB round-trips
});

test("external: concurrent cold misses for the same key coalesce onto one read (#16162)", async () => {
  const entry = {
    model: "m",
    provider: "p",
  } as unknown as PreparedPricingEntry;
  let calls = 0;
  const gate = Promise.withResolvers<PreparedPricingEntry[]>();
  const loader = (): Promise<PreparedPricingEntry[]> => {
    calls++;
    return gate.promise;
  };

  const p1 = getCachedExternalEntries("cc:ext", loader);
  const p2 = getCachedExternalEntries("cc:ext", loader);
  gate.resolve([entry]);

  expect(await p1).toEqual([entry]);
  expect(await p2).toEqual([entry]);
  expect(calls).toBe(1);
});

test("persisted: concurrent rejection is shared and a later request retries", async () => {
  __clearPersistedPricingCache();
  const gate = Promise.withResolvers<AiPricingEntry[]>();
  let calls = 0;
  const loader = (): Promise<AiPricingEntry[]> => {
    calls++;
    return gate.promise;
  };

  const first = getCachedPersistedEntries("reject", loader);
  const concurrent = getCachedPersistedEntries("reject", loader);
  const settled = Promise.allSettled([first, concurrent]);
  gate.reject(new Error("db transient"));

  const results = await settled;
  expect(results.map((result) => result.status)).toEqual(["rejected", "rejected"]);
  for (const result of results) {
    if (result.status !== "rejected") throw new Error("expected rejection");
    if (!(result.reason instanceof Error)) throw new Error("expected Error reason");
    expect(result.reason.message).toBe("db transient");
  }
  expect(calls).toBe(1);
  await expect(getCachedPersistedEntries("reject", async () => [])).resolves.toEqual([]);
});
