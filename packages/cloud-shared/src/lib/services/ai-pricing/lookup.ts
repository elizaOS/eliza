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

    const allPersisted = await aiPricingRepository.listActiveEntriesForProviderModelPairs({
      billingSource: source,
      productFamily: params.productFamily,
      chargeType: params.chargeType,
      pairs: providerModelPairs,
    });

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

export async function calculateTextCostFromCatalog(params: {
  model: string;
  provider: string;
  billingSource?: PricingBillingSource;
  inputTokens: number;
  outputTokens: number;
}): Promise<TokenCostBreakdown> {
  const canonicalModel = canonicalModelId(params.model, params.provider);
  const inputEntry = await resolvePreparedPricingEntry({
    billingSource: params.billingSource,
    provider: params.provider,
    model: canonicalModel,
    productFamily: params.model.includes("embedding") ? "embedding" : "language",
    chargeType: "input",
  });
  const outputEntry = await resolvePreparedPricingEntry({
    billingSource: params.billingSource,
    provider: params.provider,
    model: canonicalModel,
    productFamily: params.model.includes("embedding") ? "embedding" : "language",
    chargeType: "output",
  }).catch(() => null);

  const baseInputCost = asDecimal(inputEntry.unitPrice).mul(params.inputTokens);
  const baseOutputCost = outputEntry
    ? asDecimal(outputEntry.unitPrice).mul(params.outputTokens)
    : new Decimal(0);

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
