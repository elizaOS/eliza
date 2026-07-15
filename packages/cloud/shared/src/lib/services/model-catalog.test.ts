/**
 * Model-catalog SWR resilience (#16162 class): a transient OpenRouter failure
 * must NOT overwrite the cached catalog with an empty one. The fetcher now
 * throws on failure so getWithSWR keeps serving the last-good stale catalog
 * instead of caching `[]` for the whole TTL.
 */
import { describe, expect, mock, test } from "bun:test";
import * as cacheClientActual from "../cache/client";
import * as providersActual from "../providers";

let listModelsImpl: () => Promise<{
  json: () => Promise<unknown>;
}> = async () => ({
  json: async () => ({ data: [] }),
});

mock.module("../providers", () => ({
  ...providersActual,
  hasOpenRouterProviderConfigured: () => true,
  getOpenRouterProvider: () => ({ listModels: () => listModelsImpl() }),
}));

const STALE_CATALOG = [{ id: "stale-model" }];
mock.module("../cache/client", () => ({
  ...cacheClientActual,
  // Mirror the real getWithSWR contract: a fetcher THROW keeps the last-good
  // stale value; a return caches it. So a failing fetch that throws (the fix)
  // preserves the catalog, whereas the old fetcher returning `[]` would replace
  // it with empty.
  cache: {
    getWithSWR: async (_key: string, _staleTTL: number, revalidate: () => Promise<unknown>) => {
      try {
        return await revalidate();
      } catch {
        return STALE_CATALOG;
      }
    },
  },
}));

const { getCachedBitRouterModelCatalog, getCachedMergedModelCatalog, getCachedBitRouterModelById } =
  await import("./model-catalog");

describe("model catalog SWR resilience", () => {
  test("a failed catalog fetch preserves the last-good stale catalog, not empty", async () => {
    listModelsImpl = async () => {
      throw new Error("OpenRouter 503");
    };
    expect(await getCachedBitRouterModelCatalog()).toEqual(STALE_CATALOG);
  });

  test("an invalid catalog shape is treated as a failure (preserves stale)", async () => {
    listModelsImpl = async () => ({
      json: async () => ({ data: "not-an-array" }),
    });
    expect(await getCachedBitRouterModelCatalog()).toEqual(STALE_CATALOG);
  });

  test("a valid catalog fetch returns the fresh models", async () => {
    listModelsImpl = async () => ({
      json: async () => ({ data: [{ id: "fresh-model" }] }),
    });
    expect(await getCachedBitRouterModelCatalog()).toEqual([{ id: "fresh-model" }]);
  });

  test("the merged catalog includes the fresh bitrouter models", async () => {
    listModelsImpl = async () => ({
      json: async () => ({ data: [{ id: "fresh-model" }] }),
    });
    const merged = await getCachedMergedModelCatalog();
    expect(merged.some((model) => model.id === "fresh-model")).toBe(true);
  });

  test("getCachedBitRouterModelById finds a present model and null otherwise", async () => {
    listModelsImpl = async () => ({
      json: async () => ({ data: [{ id: "fresh-model" }] }),
    });
    expect(await getCachedBitRouterModelById("fresh-model")).toEqual({
      id: "fresh-model",
    });
    expect(await getCachedBitRouterModelById("does-not-exist")).toBeNull();
  });
});
