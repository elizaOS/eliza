/**
 * Coalesces canonical pricing reads and owns the Worker-safe rate cache.
 *
 * Catalog rows remain short-lived process caches for non-Worker billing work.
 * Cache-only inference admission reads canonical rates from an L1 plus the
 * configured Worker cache. A normal cold miss may join the same coalesced
 * authoritative catalog load under a bounded deadline, while durable writes
 * and stale refreshes remain under `waitUntil` without a cache readback.
 */
import type { AiPricingEntry } from "../../../db/schemas/ai-pricing";
import { cache } from "../../cache/client";
import { logger } from "../../utils/logger";
import {
  EXTERNAL_CACHE_TTL_MS,
  type ExternalCacheValue,
  NEGATIVE_EXTERNAL_CACHE_TTL_MS,
  type PreparedPricingEntry,
  type TokenPricingRates,
} from "./types";

export interface PricingCacheReadOptions {
  cacheOnly?: boolean;
  executionCtx?: { waitUntil(promise: Promise<unknown>): void };
  /** Internal deterministic-test override for the normal cold-miss join. */
  coldHydrationDeadlineMs?: number;
}

export class AiPricingCacheWarmingError extends Error {
  constructor() {
    super("AI pricing cache is warming; retry the request");
    this.name = "AiPricingCacheWarmingError";
  }
}

export class AiPricingCacheUnavailableError extends Error {
  constructor() {
    super("AI pricing cache is unavailable; retry the request");
    this.name = "AiPricingCacheUnavailableError";
  }
}

/** Input and output rates resolve concurrently, so cold reads share one promise per canonical key. */
function coalesce<T>(
  inFlight: Map<string, Promise<T>>,
  key: string,
  run: () => Promise<T>,
): Promise<T> {
  const existing = inFlight.get(key);
  if (existing) return existing;
  const started = run();
  inFlight.set(key, started);
  // Drop the entry once it settles, either way. Attach the cleanup as a settled
  // handler (not `.finally().catch()`) so it never creates a second, unhandled
  // rejected chain — the caller awaiting `started` still sees the real error.
  const cleanup = () => {
    if (inFlight.get(key) === started) inFlight.delete(key);
  };
  started.then(cleanup, cleanup);
  return started;
}

const externalCatalogCache = new Map<string, ExternalCacheValue>();
const externalCatalogInFlight = new Map<string, Promise<PreparedPricingEntry[]>>();

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

  return coalesce(externalCatalogInFlight, cacheKey, async () => {
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
  });
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
const persistedPricingInFlight = new Map<string, Promise<AiPricingEntry[]>>();

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

  return coalesce(persistedPricingInFlight, cacheKey, async () => {
    evictExpiredPersistedEntries();
    // Do NOT cache a failure: a DB read error is transient (unlike a permanently
    // dead external catalog), so let the next request retry against the DB. The
    // in-flight entry is dropped on rejection too (see `coalesce`), so a failed
    // read never blocks the next request's retry.
    const entries = await loader();
    persistedPricingCache.set(cacheKey, {
      entries,
      expiresAt: Date.now() + PERSISTED_PRICING_CACHE_TTL_MS,
    });
    return entries;
  });
}

const TEXT_PRICING_FRESH_TTL_MS = 60 * 1000;
const TEXT_PRICING_HARD_TTL_SECONDS = 15 * 60;
const TEXT_PRICING_HARD_TTL_MS = TEXT_PRICING_HARD_TTL_SECONDS * 1000;
const TEXT_PRICING_FAILURE_TTL_MS = 15 * 1000;
const TEXT_PRICING_CACHE_VERSION = 1;
const DEFAULT_COLD_HYDRATION_DEADLINE_MS = 5_000;

interface CachedTextPricingRates {
  v: typeof TEXT_PRICING_CACHE_VERSION;
  cachedAt: number;
  rates: TokenPricingRates;
}

const textPricingCache = new Map<string, CachedTextPricingRates>();
const textPricingInFlight = new Map<string, Promise<TokenPricingRates>>();
const textPricingPersistenceInFlight = new Map<string, Promise<TokenPricingRates>>();
const textPricingFailures = new Map<string, number>();

interface CachedFlatPricingEntry {
  v: 1;
  cachedAt: number;
  entry: PreparedPricingEntry;
}

const flatPricingCache = new Map<string, CachedFlatPricingEntry>();
const flatPricingInFlight = new Map<string, Promise<PreparedPricingEntry>>();
const flatPricingPersistenceInFlight = new Map<string, Promise<PreparedPricingEntry>>();
const flatPricingFailures = new Map<string, number>();

type PricingHydrationKind = "token" | "flat";

function coldHydrationDeadlineMs(options: PricingCacheReadOptions): number {
  const configured = options.coldHydrationDeadlineMs;
  return configured !== undefined && Number.isSafeInteger(configured) && configured > 0
    ? configured
    : DEFAULT_COLD_HYDRATION_DEADLINE_MS;
}

async function awaitColdHydration<T>(
  pricingKind: PricingHydrationKind,
  hydration: Promise<T>,
  options: PricingCacheReadOptions,
): Promise<T> {
  const startedAt = Date.now();
  const deadlineMs = coldHydrationDeadlineMs(options);
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const outcome = await Promise.race([
    hydration.then(
      (value) => ({ kind: "ready" as const, value }),
      () => ({ kind: "rejected" as const }),
    ),
    new Promise<{ kind: "timeout" }>((resolve) => {
      deadline = setTimeout(() => resolve({ kind: "timeout" }), deadlineMs);
      if (typeof deadline.unref === "function") deadline.unref();
    }),
  ]);
  if (deadline !== undefined) clearTimeout(deadline);

  const durationMs = Date.now() - startedAt;
  if (outcome.kind === "ready") {
    logger.info("[AI Pricing] cold authoritative hydration completed", {
      pricingKind,
      result: "ready",
      durationMs,
      deadlineMs,
    });
    return outcome.value;
  }

  logger.warn("[AI Pricing] cold authoritative hydration unavailable", {
    pricingKind,
    result: outcome.kind,
    durationMs,
    deadlineMs,
  });
  throw new AiPricingCacheUnavailableError();
}

function durableTextPricingKey(cacheKey: string): string {
  return `iac:pricing:${cacheKey}:v1`;
}

function durableFlatPricingKey(cacheKey: string): string {
  return `iac:flat-pricing:${cacheKey}:v1`;
}

function isPositiveRate(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isCachedTextPricingRates(
  value: unknown,
  required: { input: boolean; output: boolean },
): value is CachedTextPricingRates {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as {
    v?: unknown;
    cachedAt?: unknown;
    rates?: { inputUnitPrice?: unknown; outputUnitPrice?: unknown };
  };
  if (
    candidate.v !== TEXT_PRICING_CACHE_VERSION ||
    typeof candidate.cachedAt !== "number" ||
    !Number.isFinite(candidate.cachedAt) ||
    typeof candidate.rates !== "object" ||
    candidate.rates === null
  ) {
    return false;
  }
  const inputValid =
    candidate.rates.inputUnitPrice === null || isPositiveRate(candidate.rates.inputUnitPrice);
  const outputValid =
    candidate.rates.outputUnitPrice === null || isPositiveRate(candidate.rates.outputUnitPrice);
  return (
    inputValid &&
    outputValid &&
    (!required.input || isPositiveRate(candidate.rates.inputUnitPrice)) &&
    (!required.output || isPositiveRate(candidate.rates.outputUnitPrice))
  );
}

function assertLoadedRates(
  rates: TokenPricingRates,
  required: { input: boolean; output: boolean },
): void {
  const record: CachedTextPricingRates = {
    v: TEXT_PRICING_CACHE_VERSION,
    cachedAt: Date.now(),
    rates,
  };
  if (!isCachedTextPricingRates(record, required)) {
    throw new Error("AI pricing loader returned invalid or incomplete token rates");
  }
}

function observePricingCacheWrite(cacheKey: string, record: CachedTextPricingRates): Promise<void> {
  return cache
    .setWithOutcome(durableTextPricingKey(cacheKey), record, TEXT_PRICING_HARD_TTL_SECONDS)
    .then((outcome) => {
      if (outcome.kind !== "written") {
        logger.warn("[AI Pricing] canonical rate cache write was not durable", {
          cacheKey,
          outcome: outcome.kind,
          backend: outcome.backend,
        });
      }
    });
}

function loadTextPricingRates(
  cacheKey: string,
  required: { input: boolean; output: boolean },
  loader: () => Promise<TokenPricingRates>,
): Promise<TokenPricingRates> {
  const existing = textPricingInFlight.get(cacheKey);
  if (existing) return existing;

  const started = Promise.resolve()
    .then(loader)
    .then((rates) => {
      assertLoadedRates(rates, required);
      const record: CachedTextPricingRates = {
        v: TEXT_PRICING_CACHE_VERSION,
        cachedAt: Date.now(),
        rates,
      };
      textPricingCache.set(cacheKey, record);
      textPricingFailures.delete(cacheKey);
      return rates;
    });
  textPricingInFlight.set(cacheKey, started);
  const cleanup = () => {
    if (textPricingInFlight.get(cacheKey) === started) {
      textPricingInFlight.delete(cacheKey);
    }
  };
  started.then(cleanup, cleanup);
  return started;
}

function persistTextPricingRates(
  cacheKey: string,
  required: { input: boolean; output: boolean },
  loader: () => Promise<TokenPricingRates>,
): Promise<TokenPricingRates> {
  const existing = textPricingPersistenceInFlight.get(cacheKey);
  if (existing) return existing;

  const persistence = loadTextPricingRates(cacheKey, required, loader).then(async (rates) => {
    const record = textPricingCache.get(cacheKey);
    if (!record) {
      throw new Error("AI pricing hydration completed without a cache record");
    }
    await observePricingCacheWrite(cacheKey, record);
    return rates;
  });
  textPricingPersistenceInFlight.set(cacheKey, persistence);
  const cleanup = () => {
    if (textPricingPersistenceInFlight.get(cacheKey) === persistence) {
      textPricingPersistenceInFlight.delete(cacheKey);
    }
  };
  persistence.then(cleanup, cleanup);
  return persistence;
}

function scheduleTextPricingHydration(
  cacheKey: string,
  required: { input: boolean; output: boolean },
  loader: () => Promise<TokenPricingRates>,
  executionCtx: { waitUntil(promise: Promise<unknown>): void },
): Promise<TokenPricingRates> {
  const hydration = persistTextPricingRates(cacheKey, required, loader);
  const authoritative = loadTextPricingRates(cacheKey, required, loader);
  const observed = hydration.then(
    () => undefined,
    () => {
      textPricingFailures.set(cacheKey, Date.now() + TEXT_PRICING_FAILURE_TTL_MS);
      // error-policy:J7 pricing hydration is intentionally outside model
      // dispatch; retain a typed unavailable state and surface the failure.
      logger.warn("[AI Pricing] canonical rate cache hydration failed", {
        pricingKind: "token",
        result: "rejected",
      });
    },
  );
  executionCtx.waitUntil(observed);
  return authoritative;
}

function readLocalTextPricingRates(
  cacheKey: string,
  required: { input: boolean; output: boolean },
): { record: CachedTextPricingRates; stale: boolean } | null {
  const record = textPricingCache.get(cacheKey);
  if (!record || !isCachedTextPricingRates(record, required)) {
    textPricingCache.delete(cacheKey);
    return null;
  }
  const ageMs = Date.now() - record.cachedAt;
  if (ageMs >= TEXT_PRICING_HARD_TTL_MS) {
    textPricingCache.delete(cacheKey);
    return null;
  }
  return { record, stale: ageMs >= TEXT_PRICING_FRESH_TTL_MS };
}

/**
 * Resolve canonical token rates while keeping durable persistence off the
 * Worker response. A normal cold miss may consume the coalesced authoritative
 * load under a bounded deadline; stale-but-bounded rates still refresh in the
 * background.
 */
export async function getCachedTextPricingRates(
  cacheKey: string,
  required: { input: boolean; output: boolean },
  loader: () => Promise<TokenPricingRates>,
  options: PricingCacheReadOptions = {},
): Promise<TokenPricingRates> {
  const local = readLocalTextPricingRates(cacheKey, required);
  if (local && !local.stale) {
    return local.record.rates;
  }
  if (!options.cacheOnly) {
    return await loadTextPricingRates(cacheKey, required, loader);
  }
  if (!options.executionCtx) {
    throw new AiPricingCacheUnavailableError();
  }

  if (local) {
    scheduleTextPricingHydration(cacheKey, required, loader, options.executionCtx);
    return local.record.rates;
  }

  const outcome = await cache.getWithOutcome<unknown>(durableTextPricingKey(cacheKey));
  if (
    outcome.kind === "hit" &&
    isCachedTextPricingRates(outcome.value, required) &&
    Date.now() - outcome.value.cachedAt < TEXT_PRICING_HARD_TTL_MS
  ) {
    textPricingCache.set(cacheKey, outcome.value);
    if (Date.now() - outcome.value.cachedAt >= TEXT_PRICING_FRESH_TTL_MS) {
      scheduleTextPricingHydration(cacheKey, required, loader, options.executionCtx);
    }
    return outcome.value.rates;
  }

  const failedUntil = textPricingFailures.get(cacheKey);
  if (failedUntil !== undefined && failedUntil > Date.now()) {
    throw new AiPricingCacheUnavailableError();
  }
  textPricingFailures.delete(cacheKey);
  if (outcome.kind === "miss") {
    const hydration = scheduleTextPricingHydration(
      cacheKey,
      required,
      loader,
      options.executionCtx,
    );
    return await awaitColdHydration("token", hydration, options);
  }
  scheduleTextPricingHydration(cacheKey, required, loader, options.executionCtx);
  throw new AiPricingCacheUnavailableError();
}

function isCachedFlatPricingEntry(value: unknown): value is CachedFlatPricingEntry {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (record.v !== 1 || typeof record.cachedAt !== "number" || !Number.isFinite(record.cachedAt)) {
    return false;
  }
  if (!record.entry || typeof record.entry !== "object") return false;
  const entry = record.entry as Record<string, unknown>;
  return (
    typeof entry.billingSource === "string" &&
    typeof entry.provider === "string" &&
    typeof entry.model === "string" &&
    typeof entry.productFamily === "string" &&
    typeof entry.chargeType === "string" &&
    typeof entry.unit === "string" &&
    isPositiveRate(entry.unitPrice)
  );
}

function assertLoadedFlatPricingEntry(entry: PreparedPricingEntry): void {
  const record: CachedFlatPricingEntry = { v: 1, cachedAt: Date.now(), entry };
  if (!isCachedFlatPricingEntry(record)) {
    throw new Error("AI pricing loader returned an invalid flat-rate entry");
  }
}

function loadFlatPricingEntry(
  cacheKey: string,
  loader: () => Promise<PreparedPricingEntry>,
): Promise<PreparedPricingEntry> {
  const existing = flatPricingInFlight.get(cacheKey);
  if (existing) return existing;

  const started = Promise.resolve()
    .then(loader)
    .then((entry) => {
      assertLoadedFlatPricingEntry(entry);
      flatPricingCache.set(cacheKey, { v: 1, cachedAt: Date.now(), entry });
      flatPricingFailures.delete(cacheKey);
      return entry;
    });
  flatPricingInFlight.set(cacheKey, started);
  const cleanup = () => {
    if (flatPricingInFlight.get(cacheKey) === started) {
      flatPricingInFlight.delete(cacheKey);
    }
  };
  started.then(cleanup, cleanup);
  return started;
}

function persistFlatPricingEntry(
  cacheKey: string,
  loader: () => Promise<PreparedPricingEntry>,
): Promise<PreparedPricingEntry> {
  const existing = flatPricingPersistenceInFlight.get(cacheKey);
  if (existing) return existing;

  const persistence = loadFlatPricingEntry(cacheKey, loader).then(async (entry) => {
    const record = flatPricingCache.get(cacheKey);
    if (!record) {
      throw new Error("AI flat-rate pricing hydration completed without a cache record");
    }
    const outcome = await cache.setWithOutcome(
      durableFlatPricingKey(cacheKey),
      record,
      TEXT_PRICING_HARD_TTL_SECONDS,
    );
    if (outcome.kind !== "written") {
      throw new AiPricingCacheUnavailableError();
    }
    flatPricingFailures.delete(cacheKey);
    return entry;
  });
  flatPricingPersistenceInFlight.set(cacheKey, persistence);
  const cleanup = () => {
    if (flatPricingPersistenceInFlight.get(cacheKey) === persistence) {
      flatPricingPersistenceInFlight.delete(cacheKey);
    }
  };
  persistence.then(cleanup, cleanup);
  return persistence;
}

function scheduleFlatPricingHydration(
  cacheKey: string,
  loader: () => Promise<PreparedPricingEntry>,
  executionCtx: { waitUntil(promise: Promise<unknown>): void },
): Promise<PreparedPricingEntry> {
  const hydration = persistFlatPricingEntry(cacheKey, loader);
  const authoritative = loadFlatPricingEntry(cacheKey, loader);
  executionCtx.waitUntil(
    hydration.then(
      () => undefined,
      () => {
        flatPricingFailures.set(cacheKey, Date.now() + TEXT_PRICING_FAILURE_TTL_MS);
        // error-policy:J7 flat-rate hydration is intentionally outside model
        // dispatch; retain a typed unavailable state and surface the failure.
        logger.warn("[AI Pricing] flat-rate cache hydration failed", {
          pricingKind: "flat",
          result: "rejected",
        });
      },
    ),
  );
  return authoritative;
}

/**
 * Resolve a fixed-operation pricing entry while keeping durable persistence
 * off the Worker response. Bounded stale values serve immediately; a normal
 * cold miss may consume the coalesced authoritative load under a deadline.
 */
export async function getCachedFlatPricingEntry(
  cacheKey: string,
  loader: () => Promise<PreparedPricingEntry>,
  options: PricingCacheReadOptions = {},
): Promise<PreparedPricingEntry> {
  const local = flatPricingCache.get(cacheKey);
  const localAge = local ? Date.now() - local.cachedAt : Number.POSITIVE_INFINITY;
  if (local && localAge < TEXT_PRICING_FRESH_TTL_MS) return local.entry;
  if (!options.cacheOnly) return await loadFlatPricingEntry(cacheKey, loader);
  if (!options.executionCtx) throw new AiPricingCacheUnavailableError();

  if (local && localAge < TEXT_PRICING_HARD_TTL_MS) {
    scheduleFlatPricingHydration(cacheKey, loader, options.executionCtx);
    return local.entry;
  }
  flatPricingCache.delete(cacheKey);

  const outcome = await cache.getWithOutcome<unknown>(durableFlatPricingKey(cacheKey));
  if (
    outcome.kind === "hit" &&
    isCachedFlatPricingEntry(outcome.value) &&
    Date.now() - outcome.value.cachedAt < TEXT_PRICING_HARD_TTL_MS
  ) {
    flatPricingCache.set(cacheKey, outcome.value);
    if (Date.now() - outcome.value.cachedAt >= TEXT_PRICING_FRESH_TTL_MS) {
      scheduleFlatPricingHydration(cacheKey, loader, options.executionCtx);
    }
    return outcome.value.entry;
  }

  const failedUntil = flatPricingFailures.get(cacheKey);
  if (failedUntil !== undefined && failedUntil > Date.now()) {
    throw new AiPricingCacheUnavailableError();
  }
  flatPricingFailures.delete(cacheKey);
  if (outcome.kind === "miss") {
    const hydration = scheduleFlatPricingHydration(cacheKey, loader, options.executionCtx);
    return await awaitColdHydration("flat", hydration, options);
  }
  scheduleFlatPricingHydration(cacheKey, loader, options.executionCtx);
  throw new AiPricingCacheUnavailableError();
}

/** Test hook: reset all process-local pricing caches between tests. */
export function __clearPersistedPricingCache(): void {
  persistedPricingCache.clear();
  persistedPricingInFlight.clear();
  textPricingCache.clear();
  textPricingInFlight.clear();
  textPricingPersistenceInFlight.clear();
  textPricingFailures.clear();
  flatPricingCache.clear();
  flatPricingInFlight.clear();
  flatPricingPersistenceInFlight.clear();
  flatPricingFailures.clear();
}
