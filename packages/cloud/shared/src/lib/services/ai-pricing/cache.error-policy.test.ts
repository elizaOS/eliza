/**
 * Error-policy proof for the ai-pricing read caches (#13415). Drives the real
 * exported cache functions through their injected loader — the transport seam a
 * provider catalog fetch / DB read runs behind. Pins the fail-closed contract:
 * a failed provider fetch PROPAGATES (never swallowed into an empty result that
 * reads as success), a legitimately-EMPTY catalog is a distinguishable success,
 * and a persisted DB failure propagates WITHOUT being cached. Asserts no
 * monetary value — only that a failure and an empty result stay distinct so the
 * billing hot path can degrade to seed/cached pricing on failure and never
 * mistake a broken fetch for "no pricing".
 */
import { afterEach, expect, test } from "bun:test";

// Restore any accidental global.fetch stub between tests; these functions do not
// call global fetch (the loader is injected), so this is a defensive no-op guard.
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

test("external: a failed provider catalog fetch PROPAGATES — not swallowed into []", async () => {
  const { getCachedExternalEntries } = await import("./cache");
  const fetchError = new Error("provider catalog 503");
  const loader = async (): Promise<never> => {
    throw fetchError;
  };

  // Fail-closed on the request: the caller sees the real error and degrades to
  // seed/cached pricing, rather than receiving a fabricated empty catalog.
  await expect(getCachedExternalEntries("ep:fail", loader)).rejects.toThrow("provider catalog 503");
});

test("external: an EMPTY catalog is a success distinct from a failure", async () => {
  const { getCachedExternalEntries } = await import("./cache");
  let calls = 0;
  const emptyLoader = async (): Promise<[]> => {
    calls++;
    return [];
  };

  // A legitimately-empty upstream resolves (does not throw) and is cached as a
  // success — the loader runs once. This is the state a caught-and-swallowed
  // failure would be indistinguishable from; the previous test proves failure
  // throws instead, keeping the two states distinct on the billing path.
  await expect(getCachedExternalEntries("ep:empty", emptyLoader)).resolves.toEqual([]);
  await expect(getCachedExternalEntries("ep:empty", emptyLoader)).resolves.toEqual([]);
  expect(calls).toBe(1);
});

test("persisted: a DB read failure PROPAGATES and is NOT cached — next call retries", async () => {
  const { __clearPersistedPricingCache, getCachedPersistedEntries } = await import("./cache");
  __clearPersistedPricingCache();
  let calls = 0;
  const loader = async (): Promise<never> => {
    calls++;
    throw new Error("db read failed");
  };

  // Fail-closed and no stale-success masking: a transient DB error surfaces on
  // every attempt (the loader re-runs), never resolving to a cached empty set.
  await expect(getCachedPersistedEntries("ep:db", loader)).rejects.toThrow("db read failed");
  await expect(getCachedPersistedEntries("ep:db", loader)).rejects.toThrow("db read failed");
  expect(calls).toBe(2);
});
