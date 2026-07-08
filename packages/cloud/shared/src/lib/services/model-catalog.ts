// Coordinates cloud service model catalog behavior behind route handlers.
import { cache } from "../cache/client";
import { InMemoryLRUCache } from "../cache/in-memory-lru-cache";
import { CacheKeys, CacheStaleTTL, CacheTTL } from "../cache/keys";
import {
  type CatalogModel,
  GROQ_NATIVE_MODELS,
  getGroqCatalogModel,
  isGroqNativeModel,
  mergeCatalogModels,
  STATIC_TEXT_CATALOG_MODELS,
} from "../models";
import {
  getOpenRouterProvider,
  hasGroqProviderConfigured,
  hasOpenRouterProviderConfigured,
} from "../providers";
import { expandBitRouterModelIdCandidates } from "../providers/model-id-translation";
import type { OpenAIModelsResponse } from "../providers/types";
import { logger } from "../utils/logger";
import { isHotPathCachesEnabled } from "./inference-hot-path-caches";

interface SWRCachedValue<T> {
  data: T;
  cachedAt: number;
  staleAt: number;
}

function buildSWRValue<T>(data: T): SWRCachedValue<T> {
  const cachedAt = Date.now();

  return {
    data,
    cachedAt,
    staleAt: cachedAt + CacheStaleTTL.models.catalog * 1000,
  };
}

async function fetchBitRouterModelCatalog(): Promise<CatalogModel[]> {
  try {
    if (!hasOpenRouterProviderConfigured()) {
      return [];
    }

    const response = await getOpenRouterProvider().listModels();
    const data = (await response.json()) as OpenAIModelsResponse;

    if (!Array.isArray(data.data)) {
      logger.warn("[Model Catalog] OpenRouter returned an invalid model catalog");
      return [];
    }

    return data.data;
  } catch (error) {
    logger.warn("[Model Catalog] Failed to fetch OpenRouter model catalog", {
      error,
    });
    return [];
  }
}

export async function getCachedBitRouterModelCatalog(): Promise<CatalogModel[]> {
  const cached = await cache.getWithSWR<CatalogModel[]>(
    CacheKeys.models.bitrouterCatalog(),
    CacheStaleTTL.models.catalog,
    fetchBitRouterModelCatalog,
    CacheTTL.models.catalog,
  );

  return cached ?? [];
}

export function hasModelCatalogProviderConfigured(): boolean {
  return hasOpenRouterProviderConfigured() || hasGroqProviderConfigured();
}

export async function refreshBitRouterModelCatalog(): Promise<CatalogModel[]> {
  const models = await fetchBitRouterModelCatalog();

  await cache.set(
    CacheKeys.models.bitrouterCatalog(),
    buildSWRValue(models),
    CacheTTL.models.catalog,
  );

  return models;
}

export async function getCachedMergedModelCatalog(): Promise<CatalogModel[]> {
  const bitRouterModels = await getCachedBitRouterModelCatalog();
  let models = mergeCatalogModels(bitRouterModels, STATIC_TEXT_CATALOG_MODELS);

  if (hasGroqProviderConfigured()) {
    models = mergeCatalogModels(models, GROQ_NATIVE_MODELS);
  }

  return models;
}

export function findBitRouterCatalogModelById(
  models: readonly CatalogModel[],
  modelId: string,
): CatalogModel | null {
  for (const candidate of expandBitRouterModelIdCandidates(modelId)) {
    const found = models.find((model) => model.id === candidate);
    if (found) return found;
  }
  return null;
}

export async function getCachedBitRouterModelById(modelId: string): Promise<CatalogModel | null> {
  const bitRouterModels = await getCachedBitRouterModelCatalog();
  return findBitRouterCatalogModelById(bitRouterModels, modelId);
}

/**
 * #9899 Tier-3: in-isolate memo of the per-model gateway lookup, gated behind
 * `INFERENCE_HOT_PATH_CACHES` (default OFF — flag off is byte-identical to the
 * un-memoized lookup, so "rollback = flip the flag" holds). The lookup
 * runs on the inference pre-forward path (reasoning-parameter detection) and,
 * warm, still costs a shared-cache read of the FULL catalog per request. The
 * result only ever ADDS reasoning capability (modelUsesReasoningTokens ORs it
 * with name patterns), and the catalog itself is SWR-cached upstream, so a
 * short in-isolate TTL cannot regress billing — a catalog change propagates
 * within the TTL. Misses (model not in catalog) are memoized too, wrapped so
 * a legitimate null is distinguishable from a cache miss.
 */
const GATEWAY_MODEL_MEMO_TTL_MS = 60_000;
const gatewayModelMemo = new InMemoryLRUCache<{ model: CatalogModel | null }>(
  512,
  GATEWAY_MODEL_MEMO_TTL_MS,
);

/** Test hook: reset the per-model memo between tests. */
export function __clearGatewayModelMemo(): void {
  gatewayModelMemo.deleteByPrefix("");
}

export async function getCachedGatewayModelById(modelId: string): Promise<CatalogModel | null> {
  const memoEnabled = isHotPathCachesEnabled();
  if (memoEnabled) {
    const memoized = gatewayModelMemo.get(modelId);
    if (memoized) return memoized.model;
  }

  if (isGroqNativeModel(modelId)) {
    const groqModel = getGroqCatalogModel(modelId);
    if (memoEnabled) gatewayModelMemo.set(modelId, { model: groqModel });
    return groqModel;
  }

  const models = await getCachedMergedModelCatalog();
  const model = findBitRouterCatalogModelById(models, modelId);
  if (memoEnabled) gatewayModelMemo.set(modelId, { model });
  return model;
}
