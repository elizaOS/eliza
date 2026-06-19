import { cache } from "../cache/client";
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
  getBitRouterProvider,
  hasBitRouterProviderConfigured,
  hasGroqProviderConfigured,
} from "../providers";
import { expandBitRouterModelIdCandidates } from "../providers/model-id-translation";
import type { OpenAIModelsResponse } from "../providers/types";
import { logger } from "../utils/logger";

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
    if (!hasBitRouterProviderConfigured()) {
      return [];
    }

    const response = await getBitRouterProvider().listModels();
    const data = (await response.json()) as OpenAIModelsResponse;

    if (!Array.isArray(data.data)) {
      logger.warn("[Model Catalog] BitRouter returned an invalid model catalog");
      return [];
    }

    return data.data;
  } catch (error) {
    logger.warn("[Model Catalog] Failed to fetch BitRouter model catalog", {
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
  return hasBitRouterProviderConfigured() || hasGroqProviderConfigured();
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

export async function getCachedGatewayModelById(modelId: string): Promise<CatalogModel | null> {
  const models = await getCachedMergedModelCatalog();

  if (isGroqNativeModel(modelId)) {
    return getGroqCatalogModel(modelId);
  }

  return findBitRouterCatalogModelById(models, modelId);
}
