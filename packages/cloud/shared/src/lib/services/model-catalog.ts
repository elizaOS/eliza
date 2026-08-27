// Coordinates cloud service model catalog behavior behind route handlers.
import { ElizaError } from "@elizaos/core/edge";
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
import { ModelCatalogCache, type ModelCatalogRefreshFailure } from "./model-catalog-cache";

async function fetchConfiguredBitRouterModelCatalog(): Promise<CatalogModel[]> {
  try {
    const response = await getOpenRouterProvider().listModels();
    const data = (await response.json()) as OpenAIModelsResponse;

    if (!Array.isArray(data.data)) {
      const receivedKind = data.data === null ? "null" : typeof data.data;
      const cause = new TypeError(
        `Expected OpenRouter response.data to be an array, received ${receivedKind}`,
      );
      throw new ElizaError("OpenRouter returned an invalid model catalog", {
        code: "MODEL_CATALOG_PROVIDER_RESPONSE_INVALID",
        context: { provider: "openrouter", field: "data", receivedKind },
        cause,
        severity: "fatal",
      });
    }

    return data.data;
  } catch (cause) {
    if (cause instanceof ElizaError) throw cause;
    // error-policy:J2 Add provider context while preserving the transport or
    // response-decoding failure for the route boundary and observability path.
    throw new ElizaError("Failed to fetch the OpenRouter model catalog", {
      code: "MODEL_CATALOG_PROVIDER_FETCH_FAILED",
      context: { provider: "openrouter" },
      cause,
      severity: "ephemeral",
    });
  }
}

function refreshErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "error" in error) {
    const nested = (error as { error?: unknown }).error;
    if (nested && typeof nested === "object" && "message" in nested) {
      return String((nested as { message?: unknown }).message);
    }
  }
  return "Unknown upstream error";
}

const bitRouterCatalogCache = new ModelCatalogCache({
  key: CacheKeys.models.bitrouterCatalog(),
  store: cache,
  isProviderConfigured: hasOpenRouterProviderConfigured,
  fetchModels: fetchConfiguredBitRouterModelCatalog,
  freshnessSeconds: CacheStaleTTL.models.catalog,
  retentionSeconds: CacheTTL.models.catalog,
  onRefreshFailure: (failure: ModelCatalogRefreshFailure) => {
    logger.warn("[Model Catalog] Refresh failed; retaining the last-good catalog", {
      error: refreshErrorMessage(failure.error),
      retryAt: new Date(failure.retryAt).toISOString(),
      consecutiveFailures: failure.consecutiveFailures,
    });
  },
});

export async function getCachedBitRouterModelCatalog(): Promise<CatalogModel[]> {
  return await bitRouterCatalogCache.getCached();
}

export function hasModelCatalogProviderConfigured(): boolean {
  return hasOpenRouterProviderConfigured() || hasGroqProviderConfigured();
}

export async function refreshBitRouterModelCatalog(): Promise<CatalogModel[]> {
  return await bitRouterCatalogCache.refresh();
}

/** Test hook: isolate module-level refresh cooldown state between cases. */
export function __clearBitRouterCatalogRefreshStateForTests(): void {
  bitRouterCatalogCache.clearRefreshStateForTests();
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

interface StoredModelCatalog {
  data: CatalogModel[];
  cachedAt: number;
  staleAt: number;
}

export interface ModelCatalogCacheExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

export type GatewayModelCacheResolution =
  | { kind: "ready"; model: CatalogModel | null; stale: boolean }
  | {
      kind: "warming" | "unavailable";
      cacheRead: "miss" | "invalid" | "unavailable" | "error";
    };

const modelCatalogHotPathRefreshes = new Map<string, Promise<void>>();

function isCatalogModelArray(value: unknown): value is CatalogModel[] {
  return (
    Array.isArray(value) &&
    value.every(
      (model) =>
        typeof model === "object" &&
        model !== null &&
        typeof (model as { id?: unknown }).id === "string",
    )
  );
}

function isStoredModelCatalog(value: unknown): value is StoredModelCatalog {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<StoredModelCatalog>;
  return (
    isCatalogModelArray(candidate.data) &&
    typeof candidate.cachedAt === "number" &&
    Number.isFinite(candidate.cachedAt) &&
    typeof candidate.staleAt === "number" &&
    Number.isFinite(candidate.staleAt)
  );
}

function scheduleModelCatalogRefresh(executionCtx: ModelCatalogCacheExecutionContext): void {
  const key = CacheKeys.models.bitrouterCatalog();
  let refresh = modelCatalogHotPathRefreshes.get(key);
  if (!refresh) {
    refresh = refreshBitRouterModelCatalog()
      .then(() => undefined)
      .catch((error) => {
        // error-policy:J7 stale data stays available and cold requests retain
        // an explicit warming state; the detached provider failure is logged.
        logger.warn("[Model Catalog] Hot-path refresh failed", {
          error: refreshErrorMessage(error),
        });
      })
      .finally(() => {
        modelCatalogHotPathRefreshes.delete(key);
      });
    modelCatalogHotPathRefreshes.set(key, refresh);
  }
  executionCtx.waitUntil(refresh);
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
const gatewayModelMemo = new InMemoryLRUCache<{
  model: CatalogModel | null;
  stale?: boolean;
}>(512, GATEWAY_MODEL_MEMO_TTL_MS);

/** Test hook: reset the per-model memo between tests. */
export function __clearGatewayModelMemo(): void {
  gatewayModelMemo.deleteByPrefix("");
  modelCatalogHotPathRefreshes.clear();
}

/**
 * Resolve gateway metadata without letting a cold catalog fetch join the LLM
 * request promise. Static/native models are local, fresh or stale shared-cache
 * data is served immediately, and an upstream refresh runs only under
 * `waitUntil`.
 */
export async function getGatewayModelByIdCacheOnly(
  modelId: string,
  options: { executionCtx?: ModelCatalogCacheExecutionContext } = {},
): Promise<GatewayModelCacheResolution> {
  const memoized = gatewayModelMemo.get(modelId);
  if (memoized) {
    return {
      kind: "ready",
      model: memoized.model,
      stale: memoized.stale ?? false,
    };
  }

  if (isGroqNativeModel(modelId)) {
    const model = getGroqCatalogModel(modelId);
    gatewayModelMemo.set(modelId, { model });
    return { kind: "ready", model, stale: false };
  }

  const staticModel = findBitRouterCatalogModelById(STATIC_TEXT_CATALOG_MODELS, modelId);
  if (staticModel) {
    gatewayModelMemo.set(modelId, { model: staticModel });
    return { kind: "ready", model: staticModel, stale: false };
  }

  if (!hasOpenRouterProviderConfigured()) {
    gatewayModelMemo.set(modelId, { model: null });
    return { kind: "ready", model: null, stale: false };
  }

  const outcome = await cache.getWithOutcome<unknown>(CacheKeys.models.bitrouterCatalog());
  if (outcome.kind === "hit" && isStoredModelCatalog(outcome.value)) {
    const model = findBitRouterCatalogModelById(outcome.value.data, modelId);
    const stale = Date.now() > outcome.value.staleAt;
    gatewayModelMemo.set(modelId, { model, stale });
    if (stale && options.executionCtx) {
      scheduleModelCatalogRefresh(options.executionCtx);
    }
    return { kind: "ready", model, stale };
  }

  const cacheRead = outcome.kind === "hit" ? ("invalid" as const) : outcome.kind;
  if (options.executionCtx) {
    scheduleModelCatalogRefresh(options.executionCtx);
  }
  return {
    kind: cacheRead === "unavailable" || cacheRead === "error" ? "unavailable" : "warming",
    cacheRead,
  };
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
