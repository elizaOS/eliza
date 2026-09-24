/**
 * Verifies production model-catalog wiring over the real CacheClient memory
 * adapter, including typed provider errors and preservation of an actually
 * stale last-good catalog.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { ElizaError } from "@elizaos/core";
import { CacheKeys, CacheStaleTTL, CacheTTL } from "../cache/keys";
import type { CatalogModel } from "../models";
import * as providersActual from "../providers";

const previousCacheBackend = process.env.CACHE_BACKEND;
const previousCacheEnabled = process.env.CACHE_ENABLED;
process.env.CACHE_BACKEND = "memory";
process.env.CACHE_ENABLED = "true";

let openRouterConfigured = true;
let groqConfigured = false;
let listModelsCalls = 0;
let listModelsImpl: () => Promise<{ json: () => Promise<unknown> }> = async () => ({
  json: async () => ({ data: [] }),
});

mock.module("../providers", () => ({
  ...providersActual,
  getOpenRouterProvider: () => ({
    listModels: () => {
      listModelsCalls += 1;
      return listModelsImpl();
    },
  }),
  hasGroqProviderConfigured: () => groqConfigured,
  hasOpenRouterProviderConfigured: () => openRouterConfigured,
}));

const { cache } = await import("../cache/client");
const {
  __clearBitRouterCatalogRefreshStateForTests,
  __clearGatewayModelMemo,
  getCachedBitRouterModelById,
  getCachedBitRouterModelCatalog,
  getCachedMergedModelCatalog,
  getGatewayModelByIdCacheOnly,
  refreshBitRouterModelCatalog,
} = await import("./model-catalog");

const CACHE_KEY = CacheKeys.models.bitrouterCatalog();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface SWRCacheEntry<T> {
  data: T;
  cachedAt: number;
  staleAt: number;
}

function catalogModel(id: string): CatalogModel {
  return {
    id,
    object: "model",
    created: 0,
    owned_by: "test",
  };
}

async function waitFor(
  condition: () => boolean | Promise<boolean>,
  message: string,
  timeoutMs = 1_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() >= deadline) throw new Error(message);
    await sleep(5);
  }
}

beforeEach(async () => {
  process.env.CACHE_BACKEND = "memory";
  process.env.CACHE_ENABLED = "true";
  openRouterConfigured = true;
  groqConfigured = false;
  listModelsCalls = 0;
  listModelsImpl = async () => ({ json: async () => ({ data: [] }) });
  __clearBitRouterCatalogRefreshStateForTests();
  __clearGatewayModelMemo();
  await cache.del(CACHE_KEY);
  expect(cache.getBackendKind()).toBe("memory");
});

afterAll(() => {
  if (previousCacheBackend === undefined) delete process.env.CACHE_BACKEND;
  else process.env.CACHE_BACKEND = previousCacheBackend;
  if (previousCacheEnabled === undefined) delete process.env.CACHE_ENABLED;
  else process.env.CACHE_ENABLED = previousCacheEnabled;
});

describe("model catalog cache wiring", () => {
  test("caches a valid catalog with 15-minute freshness and seven-day retention", async () => {
    const fresh = [catalogModel("fresh-model")];
    listModelsImpl = async () => ({ json: async () => ({ data: fresh }) });

    expect(await getCachedBitRouterModelCatalog()).toEqual(fresh);
    expect(listModelsCalls).toBe(1);
    const entry = await cache.get<SWRCacheEntry<CatalogModel[]>>(CACHE_KEY);
    expect(entry).toMatchObject({ data: fresh });
    expect(
      (entry as SWRCacheEntry<CatalogModel[]>).staleAt -
        (entry as SWRCacheEntry<CatalogModel[]>).cachedAt,
    ).toBe(CacheStaleTTL.models.catalog * 1000);
    const ttl = await cache.pttl(CACHE_KEY);
    expect(ttl).not.toBeNull();
    expect(ttl as number).toBeGreaterThan(6 * 24 * 60 * 60 * 1000);
    expect(ttl as number).toBeLessThanOrEqual(CacheTTL.models.catalog * 1000);
  });

  test("rejects a configured-provider cold failure with its original cause", async () => {
    const providerCause = new Error("OpenRouter 503");
    listModelsImpl = async () => {
      throw providerCause;
    };

    const read = getCachedBitRouterModelCatalog();
    await expect(read).rejects.toBeInstanceOf(ElizaError);
    await expect(read).rejects.toMatchObject({
      code: "MODEL_CATALOG_PROVIDER_FETCH_FAILED",
      context: { provider: "openrouter" },
      cause: providerCause,
    });
    expect(listModelsCalls).toBe(1);
    expect(await cache.get(CACHE_KEY)).toBeNull();
  });

  test("rejects an invalid provider response as a typed error without writing cache", async () => {
    listModelsImpl = async () => ({
      json: async () => ({ data: "not-an-array" }),
    });

    const refresh = refreshBitRouterModelCatalog();
    await expect(refresh).rejects.toBeInstanceOf(ElizaError);
    await expect(refresh).rejects.toMatchObject({
      code: "MODEL_CATALOG_PROVIDER_RESPONSE_INVALID",
      context: {
        provider: "openrouter",
        field: "data",
        receivedKind: "string",
      },
      cause: expect.any(TypeError),
    });
    expect(listModelsCalls).toBe(1);
    expect(await cache.get(CACHE_KEY)).toBeNull();
  });

  test("caches an empty catalog when no provider is configured", async () => {
    openRouterConfigured = false;

    expect(await getCachedBitRouterModelCatalog()).toEqual([]);
    expect(listModelsCalls).toBe(0);
    expect(await cache.get<SWRCacheEntry<CatalogModel[]>>(CACHE_KEY)).toMatchObject({ data: [] });
    expect(await getCachedBitRouterModelCatalog()).toEqual([]);
    expect(listModelsCalls).toBe(0);
  });

  test("a failed background refresh does not overwrite stale data and a later hit retries", async () => {
    const lastGood = [catalogModel("last-good")];
    const originalEntry: SWRCacheEntry<CatalogModel[]> = {
      data: lastGood,
      cachedAt: Date.now() - 60_000,
      staleAt: Date.now() - 1,
    };
    await cache.set(CACHE_KEY, originalEntry, CacheTTL.models.catalog);
    listModelsImpl = async () => {
      throw new Error("OpenRouter 503");
    };

    expect(await getCachedBitRouterModelCatalog()).toEqual(lastGood);
    await waitFor(() => listModelsCalls === 1, "stale catalog did not start background refresh");
    await sleep(5);
    expect(await cache.get(CACHE_KEY)).toEqual(originalEntry);

    // The production backoff is intentionally long. Clearing only its test
    // clock state simulates the later, post-cooldown hit while retaining the
    // real CacheClient queue and stale entry.
    __clearBitRouterCatalogRefreshStateForTests();
    const recovered = [catalogModel("recovered")];
    listModelsImpl = async () => ({ json: async () => ({ data: recovered }) });
    expect(await getCachedBitRouterModelCatalog()).toEqual(lastGood);
    await waitFor(async () => {
      const entry = await cache.get<SWRCacheEntry<CatalogModel[]>>(CACHE_KEY);
      return entry?.data[0]?.id === "recovered";
    }, "production catalog cache did not retry after the failed background refresh");
    expect(listModelsCalls).toBe(2);
    expect(await cache.get<SWRCacheEntry<CatalogModel[]>>(CACHE_KEY)).toMatchObject({
      data: recovered,
    });
  });

  test("an explicit refresh failure leaves the last-good cache entry untouched", async () => {
    const lastGood = [catalogModel("last-good")];
    listModelsImpl = async () => ({ json: async () => ({ data: lastGood }) });
    await getCachedBitRouterModelCatalog();
    const lastGoodEntry = await cache.get(CACHE_KEY);

    listModelsImpl = async () => {
      throw new Error("OpenRouter 503");
    };
    await expect(refreshBitRouterModelCatalog()).rejects.toMatchObject({
      code: "MODEL_CATALOG_PROVIDER_FETCH_FAILED",
    });

    expect(await cache.get(CACHE_KEY)).toEqual(lastGoodEntry);
    expect(listModelsCalls).toBe(2);
  });

  test("merged and by-id lookups include fresh BitRouter models", async () => {
    const fresh = [catalogModel("fresh-model")];
    listModelsImpl = async () => ({ json: async () => ({ data: fresh }) });

    const merged = await getCachedMergedModelCatalog();
    expect(merged.some((model) => model.id === "fresh-model")).toBe(true);
    expect(await getCachedBitRouterModelById("fresh-model")).toEqual(fresh[0]);
    expect(await getCachedBitRouterModelById("does-not-exist")).toBeNull();
    expect(listModelsCalls).toBe(1);
  });

  test("cache-only gateway lookup reads a fresh catalog without provider I/O", async () => {
    const model = catalogModel("dynamic-reasoner");
    await cache.set(
      CACHE_KEY,
      {
        data: [model],
        cachedAt: Date.now(),
        staleAt: Date.now() + 60_000,
      } satisfies SWRCacheEntry<CatalogModel[]>,
      CacheTTL.models.catalog,
    );

    expect(await getGatewayModelByIdCacheOnly(model.id)).toEqual({
      kind: "ready",
      model,
      stale: false,
    });
    expect(listModelsCalls).toBe(0);
  });

  test("cache-only cold lookup returns warming and refreshes under waitUntil", async () => {
    const model = catalogModel("dynamic-reasoner");
    listModelsImpl = async () => ({
      json: async () => ({ data: [model] }),
    });
    const background: Promise<unknown>[] = [];

    expect(
      await getGatewayModelByIdCacheOnly(model.id, {
        executionCtx: { waitUntil: (promise) => background.push(promise) },
      }),
    ).toEqual({ kind: "warming", cacheRead: "miss" });
    expect(background).toHaveLength(1);
    await background[0];
    expect(listModelsCalls).toBe(1);
    expect(await getGatewayModelByIdCacheOnly(model.id)).toEqual({
      kind: "ready",
      model,
      stale: false,
    });
  });

  test("cache-only lookup never fetches a cold catalog without waitUntil", async () => {
    expect(await getGatewayModelByIdCacheOnly("dynamic-not-cached")).toEqual({
      kind: "warming",
      cacheRead: "miss",
    });
    expect(listModelsCalls).toBe(0);
  });

  test("cache-only lookup serves stale metadata and refreshes it off path", async () => {
    const staleModel = catalogModel("dynamic-reasoner");
    const refreshedModel = {
      ...staleModel,
      supported_parameters: ["reasoning"],
    };
    await cache.set(
      CACHE_KEY,
      {
        data: [staleModel],
        cachedAt: Date.now() - 120_000,
        staleAt: Date.now() - 1,
      } satisfies SWRCacheEntry<CatalogModel[]>,
      CacheTTL.models.catalog,
    );
    listModelsImpl = async () => ({
      json: async () => ({ data: [refreshedModel] }),
    });
    const background: Promise<unknown>[] = [];

    expect(
      await getGatewayModelByIdCacheOnly(staleModel.id, {
        executionCtx: { waitUntil: (promise) => background.push(promise) },
      }),
    ).toEqual({ kind: "ready", model: staleModel, stale: true });
    expect(background).toHaveLength(1);
    await background[0];
    expect(listModelsCalls).toBe(1);
    const entry = await cache.get<SWRCacheEntry<CatalogModel[]>>(CACHE_KEY);
    expect(entry?.data).toEqual([refreshedModel]);
  });
});
