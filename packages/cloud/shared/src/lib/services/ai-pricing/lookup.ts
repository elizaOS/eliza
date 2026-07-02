import Decimal from "decimal.js";
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

/**
 * Conservative per-token price for a token charge whose exact catalog row is
 * missing (#11532). A servable request must never be *under-billed* just because
 * its model id isn't catalogued yet (new releases, ingest lag). Order:
 *
 *   1. The provider's **most expensive** catalogued rate for the same
 *      family+chargeType — an upper bound that can only over-estimate.
 *   2. The env default `AI_PRICING_FALLBACK_{INPUT,OUTPUT}_USD_PER_M`
 *      (USD per million tokens → per-token) when the provider has no rows.
 *
 * Returns null only when neither source yields a positive price, in which case
 * the caller keeps the historical $0 (logged loudly) rather than failing the
 * request.
 */
async function resolveConservativeFallbackUnitPrice(params: {
  billingSource?: PricingBillingSource;
  provider: string;
  productFamily: PricingProductFamily;
  chargeType: "input" | "output";
}): Promise<{ unitPrice: Decimal; source: string } | null> {
  // 1) Provider's most-expensive catalogued rate for the same family+chargeType.
  try {
    const providerEntries = await aiPricingRepository.listActiveEntries({
      billingSource: params.billingSource,
      provider: params.provider,
      productFamily: params.productFamily,
      chargeType: params.chargeType,
    });
    let max: Decimal | null = null;
    for (const raw of providerEntries) {
      const price = asDecimal(aiEntryToPrepared(raw).unitPrice);
      if (price.isFinite() && (!max || price.gt(max))) {
        max = price;
      }
    }
    if (max?.gt(0)) {
      return { unitPrice: max, source: "provider-max" };
    }
  } catch (error) {
    logger.warn("ai-pricing: provider-max fallback query failed", {
      provider: params.provider,
      productFamily: params.productFamily,
      chargeType: params.chargeType,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // 2) Env-configured default (USD per million tokens → per-token).
  const envKey =
    params.chargeType === "input"
      ? "AI_PRICING_FALLBACK_INPUT_USD_PER_M"
      : "AI_PRICING_FALLBACK_OUTPUT_USD_PER_M";
  const rawEnv = process.env[envKey]?.trim();
  if (rawEnv) {
    try {
      const perMillion = new Decimal(rawEnv);
      if (perMillion.isFinite() && perMillion.gt(0)) {
        return { unitPrice: perMillion.div(1_000_000), source: envKey };
      }
    } catch {
      logger.warn("ai-pricing: invalid pricing-fallback env value", {
        envKey,
        rawEnv,
      });
    }
  }

  return null;
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
  // turn). Mirror the output handling — bill the missing side at $0 rather than
  // failing the request — but log loudly so the catalog gap gets priced.
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

  // #11532: never under-bill a servable-but-uncatalogued model. On a miss, fall
  // back to a conservative price (provider-max, else env default) instead of $0.
  const inputFallback = inputEntry
    ? null
    : await resolveConservativeFallbackUnitPrice({
        billingSource: params.billingSource,
        provider: params.provider,
        productFamily,
        chargeType: "input",
      });
  const outputFallback = outputEntry
    ? null
    : await resolveConservativeFallbackUnitPrice({
        billingSource: params.billingSource,
        provider: params.provider,
        productFamily,
        chargeType: "output",
      });

  if (!inputEntry) {
    logger.warn(
      inputFallback
        ? "ai-pricing: input pricing unavailable; using conservative fallback"
        : "ai-pricing: input pricing unavailable and no fallback; billing input at $0",
      {
        canonicalModel,
        provider: params.provider,
        billingSource: params.billingSource,
        fallbackSource: inputFallback?.source,
      },
    );
  }
  if (!outputEntry) {
    logger.warn(
      outputFallback
        ? "ai-pricing: output pricing unavailable; using conservative fallback"
        : "ai-pricing: output pricing unavailable and no fallback; billing output at $0",
      {
        canonicalModel,
        provider: params.provider,
        billingSource: params.billingSource,
        fallbackSource: outputFallback?.source,
      },
    );
  }

  const inputUnitPrice = inputEntry
    ? asDecimal(inputEntry.unitPrice)
    : (inputFallback?.unitPrice ?? new Decimal(0));
  const outputUnitPrice = outputEntry
    ? asDecimal(outputEntry.unitPrice)
    : (outputFallback?.unitPrice ?? new Decimal(0));

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
