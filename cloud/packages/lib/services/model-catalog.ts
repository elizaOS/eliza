import { cache } from "@/lib/cache/client";
import { CacheKeys, CacheStaleTTL, CacheTTL } from "@/lib/cache/keys";
import {
  type CatalogModel,
  GROQ_NATIVE_MODELS,
  getGroqCatalogModel,
  isGroqNativeModel,
  mergeCatalogModels,
  STATIC_TEXT_CATALOG_MODELS,
} from "@/lib/models";
import {
  getOpenRouterProvider,
  hasGroqProviderConfigured,
  hasOpenRouterProviderConfigured,
} from "@/lib/providers";
import { expandOpenRouterModelIdCandidates } from "@/lib/providers/model-id-translation";
import type { OpenAIModelsResponse } from "@/lib/providers/types";
import { logger } from "@/lib/utils/logger";

const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models?output_modalities=all";

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

async function fetchOpenRouterModelCatalog(): Promise<CatalogModel[]> {
  try {
    const response = hasOpenRouterProviderConfigured()
      ? await getOpenRouterProvider().listModels()
      : await fetch(OPENROUTER_MODELS_URL, {
          headers: {
            Accept: "application/json",
          },
        });
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

export async function getCachedOpenRouterModelCatalog(): Promise<CatalogModel[]> {
  const cached = await cache.getWithSWR<CatalogModel[]>(
    CacheKeys.models.openrouterCatalog(),
    CacheStaleTTL.models.catalog,
    fetchOpenRouterModelCatalog,
    CacheTTL.models.catalog,
  );

  return cached ?? [];
}

export function hasModelCatalogProviderConfigured(): boolean {
  return hasOpenRouterProviderConfigured() || hasGroqProviderConfigured();
}

export async function refreshOpenRouterModelCatalog(): Promise<CatalogModel[]> {
  const models = await fetchOpenRouterModelCatalog();

  await cache.set(
    CacheKeys.models.openrouterCatalog(),
    buildSWRValue(models),
    CacheTTL.models.catalog,
  );

  return models;
}

export async function getCachedMergedModelCatalog(): Promise<CatalogModel[]> {
  const openRouterModels = await getCachedOpenRouterModelCatalog();
  let models = mergeCatalogModels(openRouterModels, STATIC_TEXT_CATALOG_MODELS);

  if (hasGroqProviderConfigured()) {
    models = mergeCatalogModels(models, GROQ_NATIVE_MODELS);
  }

  return models;
}

export function findOpenRouterCatalogModelById(
  models: readonly CatalogModel[],
  modelId: string,
): CatalogModel | null {
  for (const candidate of expandOpenRouterModelIdCandidates(modelId)) {
    const found = models.find((model) => model.id === candidate);
    if (found) return found;
  }
  return null;
}

export async function getCachedOpenRouterModelById(modelId: string): Promise<CatalogModel | null> {
  const openRouterModels = await getCachedOpenRouterModelCatalog();
  return findOpenRouterCatalogModelById(openRouterModels, modelId);
}

export async function getCachedGatewayModelById(modelId: string): Promise<CatalogModel | null> {
  const models = await getCachedMergedModelCatalog();

  if (isGroqNativeModel(modelId)) {
    return getGroqCatalogModel(modelId);
  }

  return findOpenRouterCatalogModelById(models, modelId);
}
