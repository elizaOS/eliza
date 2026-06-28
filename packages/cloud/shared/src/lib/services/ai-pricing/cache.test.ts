/**
 * getCachedExternalEntries negative-caching: a failing external-catalog fetch
 * (e.g. Cerebras retiring its public catalog → permanent 404) must NOT be
 * re-run on every hot-path pricing lookup. Regression guard for the prod
 * latency issue where the failing fetch ran 2x per chat request.
 */
import { expect, test } from "bun:test";
import { getCachedExternalEntries } from "./cache";
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
