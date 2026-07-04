// Coordinates cloud service cache behavior behind route handlers.
import type { AiPricingEntry } from "../../../db/schemas/ai-pricing";
import {
  EXTERNAL_CACHE_TTL_MS,
  type ExternalCacheValue,
  NEGATIVE_EXTERNAL_CACHE_TTL_MS,
  type PreparedPricingEntry,
} from "./types";

const externalCatalogCache = new Map<string, ExternalCacheValue>();

function evictExpiredCacheEntries(): void {
  const now = Date.now();
  for (const [key, value] of externalCatalogCache) {
    if (value.expiresAt <= now) {
      externalCatalogCache.delete(key);
    }
  }
}

export async function getCachedExternalEntries(
  cacheKey: string,
  loader: () => Promise<PreparedPricingEntry[]>,
): Promise<PreparedPricingEntry[]> {
  const cached = externalCatalogCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.entries;
  }

  // Evict expired entries before adding new ones to prevent unbounded growth
  evictExpiredCacheEntries();

  let entries: PreparedPricingEntry[];
  try {
    entries = await loader();
  } catch (error) {
    // Negative-cache the failure (shorter TTL) so a dead/erroring upstream — e.g.
    // Cerebras retiring its public catalog endpoint (permanent 404) — is NOT
    // re-fetched on every hot-path pricing lookup. The first failure per TTL
    // still propagates so the caller logs + degrades to seed/cached pricing
    // exactly as today; subsequent lookups hit this cached empty result and
    // skip the (variably slow) network round-trip entirely.
    externalCatalogCache.set(cacheKey, {
      entries: [],
      expiresAt: Date.now() + NEGATIVE_EXTERNAL_CACHE_TTL_MS,
    });
    throw error;
  }
  externalCatalogCache.set(cacheKey, {
    entries,
    expiresAt: Date.now() + EXTERNAL_CACHE_TTL_MS,
  });
  return entries;
}

// ── Persisted (DB) active-pricing read cache ────────────────────────────────
// Unlike the external catalog above, these come from
// `aiPricingRepository.listActiveEntriesForProviderModelPairs` and run on EVERY
// inference inside `calculateTextCostFromCatalog` — which is part of the
// synchronous credit-reserve and was measured at ~2 cross-region Postgres
// round-trips (~300ms) of the pre-forward latency. Pricing is operator-refreshed
// and near-static, so a short TTL is billing-correct: a change propagates within
// PERSISTED_PRICING_CACHE_TTL_MS — a few seconds of negligible over/under-bill on
// a rare change. Cached only on this billing hot path (the repository itself
// stays uncached, so admin/refresh readers see fresh data). DB read errors are
// NOT cached (transient → retry next request), unlike the external-catalog 404.
const PERSISTED_PRICING_CACHE_TTL_MS = 60 * 1000;

const persistedPricingCache = new Map<string, { entries: AiPricingEntry[]; expiresAt: number }>();

function evictExpiredPersistedEntries(): void {
  const now = Date.now();
  for (const [key, value] of persistedPricingCache) {
    if (value.expiresAt <= now) {
      persistedPricingCache.delete(key);
    }
  }
}

export async function getCachedPersistedEntries(
  cacheKey: string,
  loader: () => Promise<AiPricingEntry[]>,
): Promise<AiPricingEntry[]> {
  const cached = persistedPricingCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.entries;
  }

  evictExpiredPersistedEntries();
  // Do NOT cache a failure: a DB read error is transient (unlike a permanently
  // dead external catalog), so let the next request retry against the DB.
  const entries = await loader();
  persistedPricingCache.set(cacheKey, {
    entries,
    expiresAt: Date.now() + PERSISTED_PRICING_CACHE_TTL_MS,
  });
  return entries;
}

/** Test hook: reset the persisted-pricing cache between tests. */
export function __clearPersistedPricingCache(): void {
  persistedPricingCache.clear();
}
