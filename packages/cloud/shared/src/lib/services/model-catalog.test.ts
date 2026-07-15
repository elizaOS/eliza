/**
 * Verifies production model-catalog wiring validates provider responses,
 * applies retention policy, and preserves last-good cache entries.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import * as cacheClientActual from "../cache/client";
import type { CatalogModel } from "../models";
import * as providersActual from "../providers";
import * as loggerActual from "../utils/logger";

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

let cachedValue: unknown | null = null;
const setCalls: Array<{ key: string; value: unknown; ttlSeconds: number }> = [];
mock.module("../cache/client", () => ({
  ...cacheClientActual,
  cache: {
    get: async () => cachedValue,
    set: async (key: string, value: unknown, ttlSeconds: number) => {
      cachedValue = value;
      setCalls.push({ key, value, ttlSeconds });
    },
  },
}));

const warningCalls: unknown[][] = [];
mock.module("../utils/logger", () => ({
  ...loggerActual,
  logger: {
    ...loggerActual.logger,
    warn: (...args: unknown[]) => warningCalls.push(args),
  },
}));

const {
  __clearBitRouterCatalogRefreshStateForTests,
  getCachedBitRouterModelById,
  getCachedBitRouterModelCatalog,
  getCachedMergedModelCatalog,
  refreshBitRouterModelCatalog,
} = await import("./model-catalog");

function catalogModel(id: string): CatalogModel {
  return {
    id,
    object: "model",
    created: 0,
    owned_by: "test",
  };
}

beforeEach(() => {
  openRouterConfigured = true;
  groqConfigured = false;
  listModelsCalls = 0;
  listModelsImpl = async () => ({ json: async () => ({ data: [] }) });
  cachedValue = null;
  setCalls.length = 0;
  warningCalls.length = 0;
  __clearBitRouterCatalogRefreshStateForTests();
});

describe("model catalog cache wiring", () => {
  test("caches a valid catalog with 15-minute freshness and seven-day retention", async () => {
    const fresh = [catalogModel("fresh-model")];
    listModelsImpl = async () => ({ json: async () => ({ data: fresh }) });

    expect(await getCachedBitRouterModelCatalog()).toEqual(fresh);
    expect(listModelsCalls).toBe(1);
    expect(setCalls).toHaveLength(1);
    expect(setCalls[0].ttlSeconds).toBe(7 * 24 * 60 * 60);
    expect(setCalls[0].value).toMatchObject({ data: fresh });
    const entry = setCalls[0].value as { cachedAt: number; staleAt: number };
    expect(entry.staleAt - entry.cachedAt).toBe(15 * 60 * 1000);
  });

  test("rejects an invalid provider response without writing the cache", async () => {
    listModelsImpl = async () => ({
      json: async () => ({ data: "not-an-array" }),
    });

    await expect(refreshBitRouterModelCatalog()).rejects.toThrow(
      "OpenRouter returned an invalid model catalog",
    );
    expect(setCalls).toHaveLength(0);
    expect(warningCalls).toHaveLength(1);
  });

  test("caches an empty catalog when no provider is configured", async () => {
    openRouterConfigured = false;

    expect(await getCachedBitRouterModelCatalog()).toEqual([]);
    expect(listModelsCalls).toBe(0);
    expect(setCalls).toHaveLength(1);
    expect(setCalls[0].value).toMatchObject({ data: [] });

    expect(await getCachedBitRouterModelCatalog()).toEqual([]);
    expect(setCalls).toHaveLength(1);
  });

  test("an explicit refresh failure leaves the last-good cache entry untouched", async () => {
    const lastGood = [catalogModel("last-good")];
    listModelsImpl = async () => ({ json: async () => ({ data: lastGood }) });
    await getCachedBitRouterModelCatalog();
    const lastGoodEntry = cachedValue;

    listModelsImpl = async () => {
      throw new Error("OpenRouter 503");
    };
    await expect(refreshBitRouterModelCatalog()).rejects.toThrow("OpenRouter 503");

    expect(cachedValue).toEqual(lastGoodEntry);
    expect(setCalls).toHaveLength(1);
    expect(warningCalls).toHaveLength(1);
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
});
