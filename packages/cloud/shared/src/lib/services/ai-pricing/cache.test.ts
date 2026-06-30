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
  const entry = { model: "m", provider: "p" } as unknown as PreparedPricingEntry;
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
  const row = { model: "gpt-oss-120b", provider: "cerebras" } as unknown as AiPricingEntry;
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
