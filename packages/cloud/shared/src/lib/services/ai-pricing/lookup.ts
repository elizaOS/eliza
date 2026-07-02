import { aiPricingRepository } from "../../../db/repositories/ai-pricing";
import type { PricingDimensions } from "../../../db/schemas/ai-pricing";
import { expandPersistedPricingProviderKeys } from "../../providers/model-id-translation";
import { logger } from "../../utils/logger";
import {
  getSupportedMusicModelDefinition,
  getSupportedVideoModelDefinition,
  type PricingBillingSource,
  type PricingChargeUnit,
  type PricingProductFamily,
} from "../ai-pricing-definitions";
import { getCachedPersistedEntries } from "./cache";
import {
  chooseBestCandidatePricingEntry,
  expandPricingCatalogModelCandidates,
} from "./candidate-selection";
import {
  aiEntryToPrepared,
  applyPlatformMarkup,
  asDecimal,
  canonicalModelId,
  decimalToMoney,
  inferProviderFromCanonicalModel,
  normalizeBillingSourceCandidates,
  normalizePricingDimensions,
  providerForPricingCandidate,
} from "./dimensions";
import { fetchEntriesForSource } from "./providers/gateway";
import type {
  CandidatePreparedPricingEntry,
  FlatOperationCost,
  PreparedPricingEntry,
  TokenCostBreakdown,
} from "./types";

/**
 * Resolves a single prepared pricing row for token/flat charges.
 *
 * **Why provider expansion:** `ai_pricing` may store `provider` as either the
 * short logical key (`xai`) or BitRouter's namespace (`x-ai`) from ingest
 * timing; querying both prevents false "pricing unavailable" during and after
 * migration. **Why union-ranking:** Equivalent model spellings are collected
 * before choosing one row, so caller spelling cannot change the billed price
 * when duplicate rows exist under `xai/...` and `x-ai/...`.
 */
async function resolvePreparedPricingEntry(params: {
  billingSource?: PricingBillingSource;
  provider: string;
  model: string;
  productFamily: PricingProductFamily;
  chargeType: string;
  dimensions?: Record<string, unknown>;
}): Promise<PreparedPricingEntry> {
  const canonicalModel = canonicalModelId(params.model, params.provider);
  const modelCandidates = expandPricingCatalogModelCandidates(canonicalModel);
  const requestedDimensions = normalizePricingDimensions(params.dimensions);
  const sources = normalizeBillingSourceCandidates(params.billingSource, params.provider);

  for (const source of sources) {
    const providerModelPairs = modelCandidates.flatMap((modelId) => {
      const logical = providerForPricingCandidate(modelId, params.provider);
      return expandPersistedPricingProviderKeys(logical).map((provider) => ({
        provider,
        model: modelId,
      }));
    });

    // Cache the per-request active-pricing read (~2 cross-region Postgres trips on
    // every inference). Key fully captures the query inputs; pairs sorted for a
    // stable key. Short TTL (see cache.ts) keeps billing correct.
    const persistedCacheKey = `persisted|${source ?? ""}|${params.productFamily ?? ""}|${params.chargeType ?? ""}|${providerModelPairs
      .map((p) => `${p.provider}:${p.model}`)
      .sort()
      .join(",")}`;
    const allPersisted = await getCachedPersistedEntries(persistedCacheKey, () =>
      aiPricingRepository.listActiveEntriesForProviderModelPairs({
        billingSource: source,
        productFamily: params.productFamily,
        chargeType: params.chargeType,
        pairs: providerModelPairs,
      }),
    );

    const persistedCandidates = modelCandidates.flatMap(
      (modelId): CandidatePreparedPricingEntry[] => {
        const logicalProvider = providerForPricingCandidate(modelId, params.provider);
        const providerKeys = expandPersistedPricingProviderKeys(logicalProvider);
        return allPersisted
          .filter((row) => row.model === modelId && providerKeys.includes(row.provider))
          .map((entry) => ({
            entry: aiEntryToPrepared(entry),
            modelId,
            logicalProvider,
          }));
      },
    );

    const bestPersisted = chooseBestCandidatePricingEntry(
      persistedCandidates,
      requestedDimensions,
      canonicalModel,
    );
    if (bestPersisted) {
      if (bestPersisted.modelId !== canonicalModel) {
        logger.warn("ai-pricing: resolved pricing via alias", {
          canonicalModel,
          resolvedVia: bestPersisted.modelId,
          productFamily: params.productFamily,
          chargeType: params.chargeType,
          billingSource: source,
        });
      }
      return bestPersisted.entry;
    }

    const liveAll = await fetchEntriesForSource(source);
    const liveCandidates = modelCandidates.flatMap((modelId): CandidatePreparedPricingEntry[] => {
      const logicalProvider = providerForPricingCandidate(modelId, params.provider);
      const providerKeys = expandPersistedPricingProviderKeys(logicalProvider);
      return liveAll
        .filter(
          (entry) =>
            entry.model === modelId &&
            providerKeys.includes(entry.provider) &&
            entry.productFamily === params.productFamily &&
            entry.chargeType === params.chargeType,
        )
        .map((entry) => ({
          entry,
          modelId,
          logicalProvider,
        }));
    });

    const bestLive = chooseBestCandidatePricingEntry(
      liveCandidates,
      requestedDimensions,
      canonicalModel,
    );
    if (bestLive) {
      if (bestLive.modelId !== canonicalModel) {
        logger.warn("ai-pricing: resolved pricing via alias", {
          canonicalModel,
          resolvedVia: bestLive.modelId,
          productFamily: params.productFamily,
          chargeType: params.chargeType,
          billingSource: source,
        });
      }
      return bestLive.entry;
    }
  }

  throw new Error(
    `Pricing unavailable for ${params.productFamily}:${params.chargeType} ${canonicalModel}`,
  );
}

const FALLBACK_RATE_ENV_BY_CHARGE_TYPE: Record<"input" | "output", string> = {
  input: "AI_PRICING_FALLBACK_INPUT_USD_PER_M",
  output: "AI_PRICING_FALLBACK_OUTPUT_USD_PER_M",
};

/** Env-configured default rate (USD per million tokens) → per-token unit price. */
function envFallbackTokenUnitPrice(chargeType: "input" | "output"): number | null {
  const envName = FALLBACK_RATE_ENV_BY_CHARGE_TYPE[chargeType];
  const raw = process.env[envName];
  if (raw === undefined || raw.trim() === "") {
    return null;
  }
  const usdPerMillion = Number(raw);
  // #11635: reject 0 too (not just negative/non-finite) — a `..._USD_PER_M=0`
  // env value would otherwise masquerade as a configured floor while still
  // billing $0. Treat it as unset so the missing-price path fails closed.
  if (!Number.isFinite(usdPerMillion) || usdPerMillion <= 0) {
    logger.warn("ai-pricing: ignoring invalid fallback-rate env value", {
      envName,
      value: raw,
    });
    return null;
  }
  return usdPerMillion / 1_000_000;
}

type FallbackTokenRate = {
  unitPrice: number;
  source: "provider_max_catalog" | "env_default";
  referenceModel?: string;
};

/**
 * Conservative fallback rate for a servable model with no catalog row.
 *
 * A model id can be servable before its price lands in the catalog (newly
 * released ids, catalog ingest lag). Failing the request at billing — or
 * billing it at $0 — are both wrong: the first drops a servable request, the
 * second under-bills. Instead, bill at the provider's MOST EXPENSIVE
 * catalogued token rate for the same product family/charge type (an upper
 * bound over any plausible real price from that provider), or an
 * env-configured default (AI_PRICING_FALLBACK_{INPUT,OUTPUT}_USD_PER_M) when
 * the provider has no catalogued entries at all. If neither source exists, the
 * caller must fail closed rather than inventing a price.
 */
async function resolveFallbackTokenRate(params: {
  billingSource?: PricingBillingSource;
  provider: string;
  canonicalModel: string;
  productFamily: PricingProductFamily;
  chargeType: "input" | "output";
}): Promise<FallbackTokenRate | null> {
  const logicalProvider = providerForPricingCandidate(params.canonicalModel, params.provider);
  const providerKeys = expandPersistedPricingProviderKeys(logicalProvider);
  const sources = normalizeBillingSourceCandidates(params.billingSource, params.provider);

  let best: PreparedPricingEntry | null = null;
  const consider = (entry: PreparedPricingEntry) => {
    if (entry.unit !== "token") return;
    if (!Number.isFinite(entry.unitPrice) || entry.unitPrice <= 0) return;
    if (!best || entry.unitPrice > best.unitPrice) {
      best = entry;
    }
  };

  for (const source of sources) {
    for (const providerKey of providerKeys) {
      // Same short-TTL cache as the exact-model read: this runs on the billing
      // hot path only when the exact lookup already missed.
      const cacheKey = `fallback|${source ?? ""}|${params.productFamily}|${params.chargeType}|${providerKey}`;
      const persisted = await getCachedPersistedEntries(cacheKey, () =>
        aiPricingRepository.listActiveEntries({
          billingSource: source,
          provider: providerKey,
          productFamily: params.productFamily,
          chargeType: params.chargeType,
        }),
      ).catch((error: unknown) => {
        logger.warn("ai-pricing: fallback catalog read failed", {
          provider: providerKey,
          billingSource: source,
          error: error instanceof Error ? error.message : String(error),
        });
        return [];
      });
      for (const row of persisted) {
        consider(aiEntryToPrepared(row));
      }
    }

    // Live catalog entries count too; fetchEntriesForSource degrades to [] on
    // upstream failure and is cached, so this adds no new failure mode.
    const live = await fetchEntriesForSource(source);
    for (const entry of live) {
      if (!providerKeys.includes(entry.provider)) continue;
      if (entry.productFamily !== params.productFamily) continue;
      if (entry.chargeType !== params.chargeType) continue;
      consider(entry);
    }
  }

  if (best !== null) {
    const chosen: PreparedPricingEntry = best;
    return {
      unitPrice: chosen.unitPrice,
      source: "provider_max_catalog",
      referenceModel: chosen.model,
    };
  }

  const envUnitPrice = envFallbackTokenUnitPrice(params.chargeType);
  if (envUnitPrice !== null) {
    return { unitPrice: envUnitPrice, source: "env_default" };
  }

  return null;
}

function computeCostFromEntry(entry: PreparedPricingEntry, quantity: number): FlatOperationCost {
  const baseCost = asDecimal(entry.unitPrice).mul(quantity);
  const markedUp = applyPlatformMarkup(baseCost);

  return {
    totalCost: markedUp.totalCost,
    baseTotalCost: markedUp.baseTotalCost,
    platformMarkup: markedUp.platformMarkup,
    matchedEntry: {
      billingSource: entry.billingSource,
      provider: entry.provider,
      model: entry.model,
      productFamily: entry.productFamily,
      chargeType: entry.chargeType,
      unit: entry.unit,
      unitPrice: entry.unitPrice,
      dimensions: normalizePricingDimensions(entry.dimensions),
      sourceKind: entry.sourceKind,
      sourceUrl: entry.sourceUrl,
    },
  };
}

function quantityForEntryUnit(
  unit: PricingChargeUnit,
  amount: {
    count?: number;
    durationSeconds?: number;
    durationMinutes?: number;
    durationHours?: number;
    characters?: number;
    tokens?: number;
    requests?: number;
  },
): number {
  switch (unit) {
    case "image":
      return amount.count ?? amount.requests ?? 1;
    case "second":
      return amount.durationSeconds ?? 0;
    case "minute":
      return amount.durationMinutes ?? (amount.durationSeconds ?? 0) / 60;
    case "hour":
      return amount.durationHours ?? (amount.durationSeconds ?? 0) / 3600;
    case "character":
      return amount.characters ?? 0;
    case "token":
      return amount.tokens ?? 0;
    case "request":
      return amount.requests ?? 1;
    case "1k_requests":
      return (amount.requests ?? 0) / 1000;
  }
}

export async function calculateTextCostFromCatalog(params: {
  model: string;
  provider: string;
  billingSource?: PricingBillingSource;
  inputTokens: number;
  outputTokens: number;
}): Promise<TokenCostBreakdown> {
  const canonicalModel = canonicalModelId(params.model, params.provider);
  const productFamily: PricingProductFamily = params.model.includes("embedding")
    ? "embedding"
    : "language";
  // Both lookups degrade to null on a catalog miss. A missing INPUT price used
  // to throw uncaught here (the OUTPUT lookup was already guarded), and the
  // throw propagated through calculateCost → the chat-completions reserve →
  // a 500 / masked "bridge unreachable" on any model whose input row isn't in
  // the catalog (notably embedding models, which are input-only and run every
  // turn). A servable request must never fail purely on a missing price — but
  // it must not be under-billed at $0 either. On a miss, bill the missing side
  // only when a real fallback exists (provider max → env default). If neither
  // source exists, fail closed because we should not sell inference we do not
  // know how to price (#11635).
  const inputEntry = await resolvePreparedPricingEntry({
    billingSource: params.billingSource,
    provider: params.provider,
    model: canonicalModel,
    productFamily,
    chargeType: "input",
  }).catch(() => null);
  const outputEntry = await resolvePreparedPricingEntry({
    billingSource: params.billingSource,
    provider: params.provider,
    model: canonicalModel,
    productFamily,
    chargeType: "output",
  }).catch(() => null);

  // Resolve a fallback only for a side that actually bills tokens: a
  // zero-token side costs $0 at any rate, and skipping it keeps input-only
  // embedding traffic from warning on every turn about its unused output row.
  const resolveMissingSide = async (
    chargeType: "input" | "output",
    tokens: number,
  ): Promise<FallbackTokenRate | null> => {
    if (tokens <= 0) {
      return null;
    }
    const fallback = await resolveFallbackTokenRate({
      billingSource: params.billingSource,
      provider: params.provider,
      canonicalModel,
      productFamily,
      chargeType,
    });
    if (!fallback) {
      const message = `Pricing unavailable for ${productFamily}:${chargeType} ${canonicalModel}; refusing to bill unknown-priced inference`;
      logger.error("ai-pricing: missing token price with no fallback; refusing request", {
        canonicalModel,
        provider: params.provider,
        billingSource: params.billingSource,
        productFamily,
        chargeType,
        tokens,
      });
      throw new Error(message);
    }
    logger.warn(`ai-pricing: ${chargeType} pricing unavailable; billing at fallback rate`, {
      canonicalModel,
      provider: params.provider,
      billingSource: params.billingSource,
      fallbackSource: fallback.source,
      fallbackUnitPrice: fallback.unitPrice,
      ...(fallback.referenceModel ? { fallbackReferenceModel: fallback.referenceModel } : {}),
    });
    return fallback;
  };

  const inputFallback = inputEntry ? null : await resolveMissingSide("input", params.inputTokens);
  const outputFallback = outputEntry
    ? null
    : await resolveMissingSide("output", params.outputTokens);

  const inputUnitPrice = inputEntry
    ? asDecimal(inputEntry.unitPrice)
    : asDecimal(inputFallback?.unitPrice ?? 0);
  const outputUnitPrice = outputEntry
    ? asDecimal(outputEntry.unitPrice)
    : asDecimal(outputFallback?.unitPrice ?? 0);

  const baseInputCost = inputUnitPrice.mul(params.inputTokens);
  const baseOutputCost = outputUnitPrice.mul(params.outputTokens);

  const inputTotals = applyPlatformMarkup(baseInputCost);
  const outputTotals = applyPlatformMarkup(baseOutputCost);

  return {
    inputCost: inputTotals.totalCost,
    outputCost: outputTotals.totalCost,
    totalCost: decimalToMoney(asDecimal(inputTotals.totalCost).plus(outputTotals.totalCost)),
    baseInputCost: inputTotals.baseTotalCost,
    baseOutputCost: outputTotals.baseTotalCost,
    baseTotalCost: decimalToMoney(baseInputCost.plus(baseOutputCost)),
    platformMarkup: decimalToMoney(
      asDecimal(inputTotals.platformMarkup).plus(outputTotals.platformMarkup),
    ),
  };
}

export async function calculateImageGenerationCostFromCatalog(params: {
  model: string;
  provider: string;
  billingSource?: PricingBillingSource;
  imageCount?: number;
  dimensions?: Record<string, unknown>;
}): Promise<FlatOperationCost> {
  const entry = await resolvePreparedPricingEntry({
    billingSource: params.billingSource,
    provider: params.provider,
    model: params.model,
    productFamily: "image",
    chargeType: "generation",
    dimensions: params.dimensions,
  });

  return computeCostFromEntry(
    entry,
    quantityForEntryUnit(entry.unit, { count: params.imageCount ?? 1 }),
  );
}

export async function calculateVideoGenerationCostFromCatalog(params: {
  model: string;
  billingSource?: "fal";
  durationSeconds?: number;
  dimensions?: Record<string, unknown>;
}): Promise<FlatOperationCost> {
  const entry = await resolvePreparedPricingEntry({
    billingSource: params.billingSource ?? "fal",
    provider: "fal",
    model: params.model,
    productFamily: "video",
    chargeType: "generation",
    dimensions: params.dimensions,
  });

  return computeCostFromEntry(
    entry,
    quantityForEntryUnit(entry.unit, {
      durationSeconds: params.durationSeconds,
      requests: 1,
    }),
  );
}

export async function calculateMusicGenerationCostFromCatalog(params: {
  model: string;
  provider?: "fal" | "elevenlabs" | "suno";
  billingSource?: "fal" | "elevenlabs" | "suno";
  durationSeconds?: number;
  dimensions?: Record<string, unknown>;
}): Promise<FlatOperationCost> {
  const definition = getSupportedMusicModelDefinition(params.model);
  const provider =
    params.provider ?? definition?.provider ?? inferProviderFromCanonicalModel(params.model);
  const entry = await resolvePreparedPricingEntry({
    billingSource: params.billingSource,
    provider,
    model: params.model,
    productFamily: "music",
    chargeType: "generation",
    dimensions: params.dimensions,
  });

  return computeCostFromEntry(
    entry,
    quantityForEntryUnit(entry.unit, {
      durationSeconds: params.durationSeconds ?? definition?.defaultParameters.durationSeconds,
      requests: 1,
    }),
  );
}

export async function calculateTTSCostFromCatalog(params: {
  model: string;
  characterCount: number;
}): Promise<FlatOperationCost> {
  const entry = await resolvePreparedPricingEntry({
    billingSource: "elevenlabs",
    provider: "elevenlabs",
    model: params.model,
    productFamily: "tts",
    chargeType: "generation",
  });

  return computeCostFromEntry(
    entry,
    quantityForEntryUnit(entry.unit, { characters: params.characterCount }),
  );
}

export async function calculateSTTCostFromCatalog(params: {
  model: string;
  durationSeconds: number;
}): Promise<FlatOperationCost> {
  const entry = await resolvePreparedPricingEntry({
    billingSource: "elevenlabs",
    provider: "elevenlabs",
    model: params.model,
    productFamily: "stt",
    chargeType: "generation",
  });

  return computeCostFromEntry(
    entry,
    quantityForEntryUnit(entry.unit, {
      durationSeconds: params.durationSeconds,
    }),
  );
}

export async function calculateVoiceCloneCostFromCatalog(params: {
  cloneType: "instant" | "professional";
}): Promise<FlatOperationCost> {
  const entry = await resolvePreparedPricingEntry({
    billingSource: "elevenlabs",
    provider: "elevenlabs",
    model: `elevenlabs/${params.cloneType}`,
    productFamily: "voice_clone",
    chargeType: "generation",
  });

  return computeCostFromEntry(entry, 1);
}

export function getDefaultVideoBillingDimensions(modelId: string): {
  durationSeconds: number;
  dimensions: PricingDimensions;
} {
  const definition = getSupportedVideoModelDefinition(modelId);
  if (!definition) {
    throw new Error(`Unsupported video model: ${modelId}`);
  }

  const dimensions = normalizePricingDimensions({
    ...(definition.defaultParameters.resolution
      ? { resolution: definition.defaultParameters.resolution }
      : {}),
    ...(definition.defaultParameters.audio !== undefined
      ? { audio: definition.defaultParameters.audio }
      : {}),
    ...(definition.defaultParameters.voiceControl !== undefined
      ? { voiceControl: definition.defaultParameters.voiceControl }
      : {}),
    ...(definition.pricingParser === "hailuo_standard"
      ? { durationSeconds: definition.defaultParameters.durationSeconds }
      : {}),
    ...(definition.pricingParser === "pixverse"
      ? { durationSeconds: definition.defaultParameters.durationSeconds }
      : {}),
  });

  return {
    durationSeconds: definition.defaultParameters.durationSeconds,
    dimensions,
  };
}

export async function listPersistedPricingEntries(filters?: {
  billingSource?: string;
  provider?: string;
  model?: string;
  productFamily?: string;
  chargeType?: string;
}) {
  const entries = await aiPricingRepository.listActiveEntries({
    billingSource: filters?.billingSource,
    provider: filters?.provider,
    model: filters?.model ? canonicalModelId(filters.model, filters.provider) : undefined,
    productFamily: filters?.productFamily,
    chargeType: filters?.chargeType,
  });

  return entries.map((entry) => aiEntryToPrepared(entry));
}

export async function listRecentPricingRefreshRuns(limit: number = 20) {
  return await aiPricingRepository.listRecentRefreshRuns(limit);
}
