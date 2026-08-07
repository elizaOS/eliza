/** Resolves authoritative model pricing with durable-cache support for hot routes. */
import { aiPricingRepository } from "../../../db/repositories/ai-pricing";
import type { PricingDimensions } from "../../../db/schemas/ai-pricing";
import { expandPersistedPricingProviderKeys } from "../../providers/model-id-translation";
import { logger } from "../../utils/logger";
import {
  getSupportedMusicModelDefinition,
  getSupportedSfxModelDefinition,
  getSupportedVideoModelDefinition,
  type PricingBillingSource,
  type PricingChargeUnit,
  type PricingProductFamily,
} from "../ai-pricing-definitions";
import {
  getCachedFlatPricingEntry,
  getCachedPersistedEntries,
  getCachedTextPricingRates,
  type PricingCacheReadOptions,
} from "./cache";
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
  TokenPricingRates,
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

async function resolveCachedPreparedPricingEntry(
  params: Parameters<typeof resolvePreparedPricingEntry>[0] & {
    cache?: PricingCacheReadOptions;
  },
): Promise<PreparedPricingEntry> {
  const canonicalModel = canonicalModelId(params.model, params.provider);
  const requestedDimensions = normalizePricingDimensions(params.dimensions);
  const cacheKey = [
    params.billingSource ?? "",
    params.provider,
    canonicalModel,
    params.productFamily,
    params.chargeType,
    JSON.stringify(requestedDimensions),
  ]
    .map((part) => encodeURIComponent(part))
    .join(":");
  return await getCachedFlatPricingEntry(
    cacheKey,
    () => resolvePreparedPricingEntry(params),
    params.cache,
  );
}

const FALLBACK_RATE_ENV_BY_CHARGE_TYPE: Record<"input" | "output", string> = {
  input: "AI_PRICING_FALLBACK_INPUT_USD_PER_M",
  output: "AI_PRICING_FALLBACK_OUTPUT_USD_PER_M",
};

function assertBillableQuantity(params: {
  quantity: number;
  scope: string;
  provider: string;
  model: string;
  productFamily: PricingProductFamily;
  chargeType: string;
}) {
  if (Number.isFinite(params.quantity) && params.quantity >= 0) {
    return;
  }
  logger.error("ai-pricing: refusing to bill an invalid quantity", {
    provider: params.provider,
    model: params.model,
    productFamily: params.productFamily,
    chargeType: params.chargeType,
    scope: params.scope,
    quantity: params.quantity,
  });
  throw new Error(
    `Corrupt billing quantity for ${params.productFamily}:${params.chargeType} ${params.provider}/${params.model}; refusing to bill an invalid quantity`,
  );
}

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
  // Defense-in-depth money-boundary guard. Candidate selection already drops
  // non-finite/non-positive prices (see `chooseBestCandidatePricingEntry`), so a resolved
  // entry reaching here should always carry a real price. Re-assert it anyway:
  // `asDecimal(NaN).mul(quantity)` silently yields a `NaN` charge; a negative
  // price creates a negative debit. Either poisons the credit debit / earnings
  // ledger with no error. If a corrupt
  // price ever reaches this sink via any future path, fail closed with an
  // explicit error the caller surfaces (5xx / refuse) rather than billing NaN.
  if (!Number.isFinite(entry.unitPrice) || entry.unitPrice <= 0) {
    logger.error("ai-pricing: refusing to bill an invalid catalog price", {
      provider: entry.provider,
      model: entry.model,
      productFamily: entry.productFamily,
      chargeType: entry.chargeType,
      unit: entry.unit,
      unitPrice: entry.unitPrice,
    });
    throw new Error(
      `Corrupt catalog price for ${entry.productFamily}:${entry.chargeType} ${entry.provider}/${entry.model}; refusing to bill an invalid rate`,
    );
  }
  assertBillableQuantity({
    quantity,
    scope: "flat",
    provider: entry.provider,
    model: entry.model,
    productFamily: entry.productFamily,
    chargeType: entry.chargeType,
  });

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

interface TextPricingRateParams {
  canonicalModel: string;
  provider: string;
  billingSource?: PricingBillingSource;
  productFamily: PricingProductFamily;
  requireInput: boolean;
  requireOutput: boolean;
  inputTokens: number;
  outputTokens: number;
}

async function resolveTextPricingRates(params: TextPricingRateParams): Promise<TokenPricingRates> {
  // Both lookups degrade to null on a catalog miss. A servable request must not
  // fail purely because one exact row is absent, but it also must never invent a
  // zero price: a required missing side resolves through the conservative
  // provider-max/env fallback and otherwise fails closed (#11635).
  const [inputEntry, outputEntry] = await Promise.all([
    params.requireInput
      ? resolvePreparedPricingEntry({
          billingSource: params.billingSource,
          provider: params.provider,
          model: params.canonicalModel,
          productFamily: params.productFamily,
          chargeType: "input",
        }).catch(() => null)
      : null,
    params.requireOutput
      ? resolvePreparedPricingEntry({
          billingSource: params.billingSource,
          provider: params.provider,
          model: params.canonicalModel,
          productFamily: params.productFamily,
          chargeType: "output",
        }).catch(() => null)
      : null,
  ]);

  const resolveRequiredSide = async (
    chargeType: "input" | "output",
    required: boolean,
    entry: PreparedPricingEntry | null,
    tokens: number,
  ): Promise<number | null> => {
    if (!required) return null;
    if (entry) return entry.unitPrice;

    const fallback = await resolveFallbackTokenRate({
      billingSource: params.billingSource,
      provider: params.provider,
      canonicalModel: params.canonicalModel,
      productFamily: params.productFamily,
      chargeType,
    });
    if (!fallback) {
      const message = `Pricing unavailable for ${params.productFamily}:${chargeType} ${params.canonicalModel}; refusing to bill unknown-priced inference`;
      logger.error("ai-pricing: missing token price with no fallback; refusing request", {
        canonicalModel: params.canonicalModel,
        provider: params.provider,
        billingSource: params.billingSource,
        productFamily: params.productFamily,
        chargeType,
        tokens,
      });
      throw new Error(message);
    }
    logger.warn(`ai-pricing: ${chargeType} pricing unavailable; billing at fallback rate`, {
      canonicalModel: params.canonicalModel,
      provider: params.provider,
      billingSource: params.billingSource,
      fallbackSource: fallback.source,
      fallbackUnitPrice: fallback.unitPrice,
      ...(fallback.referenceModel ? { fallbackReferenceModel: fallback.referenceModel } : {}),
    });
    return fallback.unitPrice;
  };

  const [inputUnitPrice, outputUnitPrice] = await Promise.all([
    resolveRequiredSide("input", params.requireInput, inputEntry, params.inputTokens),
    resolveRequiredSide("output", params.requireOutput, outputEntry, params.outputTokens),
  ]);
  return { inputUnitPrice, outputUnitPrice };
}

function textPricingCacheKey(params: TextPricingRateParams): string {
  return [
    params.billingSource ?? "",
    params.provider,
    params.canonicalModel,
    params.productFamily,
    params.requireInput ? "i" : "",
    params.requireOutput ? "o" : "",
  ]
    .map((part) => encodeURIComponent(part))
    .join(":");
}

export async function calculateTextCostFromCatalog(params: {
  model: string;
  provider: string;
  billingSource?: PricingBillingSource;
  inputTokens: number;
  outputTokens: number;
  cache?: PricingCacheReadOptions;
}): Promise<TokenCostBreakdown> {
  const canonicalModel = canonicalModelId(params.model, params.provider);
  const productFamily: PricingProductFamily = params.model.includes("embedding")
    ? "embedding"
    : "language";
  assertBillableQuantity({
    quantity: params.inputTokens,
    scope: "inputTokens",
    provider: params.provider,
    model: canonicalModel,
    productFamily,
    chargeType: "input",
  });
  assertBillableQuantity({
    quantity: params.outputTokens,
    scope: "outputTokens",
    provider: params.provider,
    model: canonicalModel,
    productFamily,
    chargeType: "output",
  });

  const rateParams: TextPricingRateParams = {
    canonicalModel,
    provider: params.provider,
    billingSource: params.billingSource,
    productFamily,
    requireInput: params.inputTokens > 0,
    requireOutput: params.outputTokens > 0,
    inputTokens: params.inputTokens,
    outputTokens: params.outputTokens,
  };
  const rates = await getCachedTextPricingRates(
    textPricingCacheKey(rateParams),
    { input: rateParams.requireInput, output: rateParams.requireOutput },
    () => resolveTextPricingRates(rateParams),
    params.cache,
  );

  const resolveTokenUnitPrice = (
    chargeType: "input" | "output",
    unitPrice: number | null,
    tokens: number,
  ) => {
    if (tokens === 0) return asDecimal(0);
    if (unitPrice === null || !Number.isFinite(unitPrice) || unitPrice <= 0) {
      logger.error("ai-pricing: refusing to bill an invalid token price", {
        canonicalModel,
        provider: params.provider,
        billingSource: params.billingSource,
        chargeType,
        unitPrice,
      });
      throw new Error(
        `Corrupt catalog price for ${productFamily}:${chargeType} ${canonicalModel}; refusing to bill an invalid rate`,
      );
    }
    return asDecimal(unitPrice);
  };

  const inputUnitPrice = resolveTokenUnitPrice("input", rates.inputUnitPrice, params.inputTokens);
  const outputUnitPrice = resolveTokenUnitPrice(
    "output",
    rates.outputUnitPrice,
    params.outputTokens,
  );

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
  cache?: PricingCacheReadOptions;
}): Promise<FlatOperationCost> {
  const entry = await resolveCachedPreparedPricingEntry({
    billingSource: params.billingSource,
    provider: params.provider,
    model: params.model,
    productFamily: "image",
    chargeType: "generation",
    dimensions: params.dimensions,
    cache: params.cache,
  });

  return computeCostFromEntry(
    entry,
    quantityForEntryUnit(entry.unit, { count: params.imageCount ?? 1 }),
  );
}

export async function calculateVideoGenerationCostFromCatalog(params: {
  model: string;
  billingSource?: PricingBillingSource;
  durationSeconds?: number;
  dimensions?: Record<string, unknown>;
  cache?: PricingCacheReadOptions;
}): Promise<FlatOperationCost> {
  const definition = getSupportedVideoModelDefinition(params.model);
  const provider = definition?.provider ?? inferProviderFromCanonicalModel(params.model);
  const entry = await resolveCachedPreparedPricingEntry({
    billingSource: params.billingSource ?? definition?.billingSource,
    provider,
    model: params.model,
    productFamily: "video",
    chargeType: "generation",
    dimensions: params.dimensions,
    cache: params.cache,
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
  cache?: PricingCacheReadOptions;
}): Promise<FlatOperationCost> {
  const definition = getSupportedMusicModelDefinition(params.model);
  const provider =
    params.provider ?? definition?.provider ?? inferProviderFromCanonicalModel(params.model);
  const entry = await resolveCachedPreparedPricingEntry({
    billingSource: params.billingSource,
    provider,
    model: params.model,
    productFamily: "music",
    chargeType: "generation",
    dimensions: params.dimensions,
    cache: params.cache,
  });

  return computeCostFromEntry(
    entry,
    quantityForEntryUnit(entry.unit, {
      durationSeconds: params.durationSeconds ?? definition?.defaultParameters.durationSeconds,
      requests: 1,
    }),
  );
}

export async function calculateSfxGenerationCostFromCatalog(params: {
  model: string;
  provider?: "fal" | "elevenlabs";
  billingSource?: "fal" | "elevenlabs";
  durationSeconds?: number;
  dimensions?: Record<string, unknown>;
  cache?: PricingCacheReadOptions;
}): Promise<FlatOperationCost> {
  const definition = getSupportedSfxModelDefinition(params.model);
  const provider =
    params.provider ?? definition?.provider ?? inferProviderFromCanonicalModel(params.model);
  const entry = await resolveCachedPreparedPricingEntry({
    billingSource: params.billingSource,
    provider,
    model: params.model,
    productFamily: "sfx",
    chargeType: "generation",
    dimensions: params.dimensions,
    cache: params.cache,
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
  cache?: PricingCacheReadOptions;
}): Promise<FlatOperationCost> {
  const entry = await resolveCachedPreparedPricingEntry({
    billingSource: "elevenlabs",
    provider: "elevenlabs",
    model: params.model,
    productFamily: "tts",
    chargeType: "generation",
    cache: params.cache,
  });

  return computeCostFromEntry(
    entry,
    quantityForEntryUnit(entry.unit, { characters: params.characterCount }),
  );
}

export async function calculateSTTCostFromCatalog(params: {
  model: string;
  durationSeconds: number;
  cache?: PricingCacheReadOptions;
}): Promise<FlatOperationCost> {
  const entry = await resolveCachedPreparedPricingEntry({
    billingSource: "elevenlabs",
    provider: "elevenlabs",
    model: params.model,
    productFamily: "stt",
    chargeType: "generation",
    cache: params.cache,
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
