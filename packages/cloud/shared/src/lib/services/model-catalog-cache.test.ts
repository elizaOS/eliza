/**
 * Proves model-catalog refresh policy through the real CacheClient memory
 * adapter: cold failures reject, stale failures preserve the last-good entry,
 * queue cleanup permits a later retry, and only an unconfigured provider may
 * produce an empty catalog.
 */

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { ElizaError } from "@elizaos/core";
import { CacheClient } from "../cache/client";
import type { CatalogModel } from "../models";
import {
  ModelCatalogCache,
  ModelCatalogRefreshCoordinator,
  type ModelCatalogRefreshFailure,
} from "./model-catalog-cache";

const FRESHNESS_SECONDS = 0;
const RETENTION_SECONDS = 7 * 24 * 60 * 60;
const KEY = "models:test-catalog";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const previousCacheBackend = process.env.CACHE_BACKEND;
const previousCacheEnabled = process.env.CACHE_ENABLED;

function catalogModel(id: string): CatalogModel {
  return {
    id,
    object: "model",
    created: 0,
    owned_by: "test",
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

interface SWRCacheEntry<T> {
  data: T;
  cachedAt: number;
  staleAt: number;
}

function memoryCache(): CacheClient {
  const store = new CacheClient();
  expect(store.getBackendKind()).toBe("memory");
  return store;
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

beforeEach(() => {
  process.env.CACHE_BACKEND = "memory";
  process.env.CACHE_ENABLED = "true";
});

afterAll(() => {
  if (previousCacheBackend === undefined) delete process.env.CACHE_BACKEND;
  else process.env.CACHE_BACKEND = previousCacheBackend;
  if (previousCacheEnabled === undefined) delete process.env.CACHE_ENABLED;
  else process.env.CACHE_ENABLED = previousCacheEnabled;
});

describe("ModelCatalogCache with CacheClient memory adapter", () => {
  test("coalesces configured cold failures, rejects every reader, then recovers after cooldown", async () => {
    let now = 1_000;
    let fetchCalls = 0;
    let fetchImpl: () => Promise<CatalogModel[]>;
    const started = deferred<void>();
    const upstream = deferred<CatalogModel[]>();
    const failures: ModelCatalogRefreshFailure[] = [];
    const store = memoryCache();

    fetchImpl = () => {
      fetchCalls += 1;
      started.resolve(undefined);
      return upstream.promise;
    };
    const catalog = new ModelCatalogCache({
      key: KEY,
      store,
      isProviderConfigured: () => true,
      fetchModels: () => fetchImpl(),
      freshnessSeconds: FRESHNESS_SECONDS,
      retentionSeconds: RETENTION_SECONDS,
      now: () => now,
      baseBackoffMs: 100,
      maxBackoffMs: 1_000,
      onRefreshFailure: (failure) => failures.push(failure),
    });

    // Stay below CacheClient's independent five-failure circuit threshold so
    // this assertion isolates catalog single-flight/cooldown behavior.
    const reads = Array.from({ length: 3 }, () => catalog.getCached());
    await started.promise;
    expect(fetchCalls).toBe(1);

    const upstreamError = new Error("OpenRouter unavailable");
    upstream.reject(upstreamError);
    const settled = await Promise.allSettled(reads);
    expect(settled).toHaveLength(3);
    expect(settled.every((result) => result.status === "rejected")).toBe(true);
    for (const result of settled) {
      if (result.status === "rejected") expect(result.reason).toBe(upstreamError);
    }
    expect(failures).toHaveLength(1);
    expect(await store.get(KEY)).toBeNull();

    await expect(catalog.getCached()).rejects.toBe(upstreamError);
    expect(fetchCalls).toBe(1);

    now = failures[0].retryAt;
    const recovered = [catalogModel("recovered")];
    fetchImpl = async () => {
      fetchCalls += 1;
      return recovered;
    };
    expect(await catalog.getCached()).toEqual(recovered);
    expect(fetchCalls).toBe(2);
    expect(await store.get<SWRCacheEntry<CatalogModel[]>>(KEY)).toMatchObject({
      data: recovered,
    });
  });

  test("keeps seven-day last-good data through a failed background refresh and retries later", async () => {
    let now = 1_000;
    let fetchCalls = 0;
    let fetchImpl = async (): Promise<CatalogModel[]> => {
      fetchCalls += 1;
      return [catalogModel("last-good")];
    };
    const failed = deferred<ModelCatalogRefreshFailure>();
    const store = memoryCache();
    const catalog = new ModelCatalogCache({
      key: KEY,
      store,
      isProviderConfigured: () => true,
      fetchModels: () => fetchImpl(),
      freshnessSeconds: FRESHNESS_SECONDS,
      retentionSeconds: RETENTION_SECONDS,
      now: () => now,
      baseBackoffMs: 10,
      maxBackoffMs: 100,
      onRefreshFailure: (failure) => failed.resolve(failure),
    });

    const lastGood = await catalog.getCached();
    const originalEntry = await store.get<SWRCacheEntry<CatalogModel[]>>(KEY);
    expect(originalEntry).toMatchObject({ data: lastGood });
    const originalTtl = await store.pttl(KEY);
    expect(originalTtl).not.toBeNull();
    expect(originalTtl as number).toBeGreaterThan(6 * 24 * 60 * 60 * 1000);
    expect(originalTtl as number).toBeLessThanOrEqual(RETENTION_SECONDS * 1000);

    await sleep(5);
    fetchImpl = async () => {
      fetchCalls += 1;
      throw new Error("temporary outage");
    };
    expect(await catalog.getCached()).toEqual(lastGood);
    const failure = await failed.promise;
    await sleep(5);
    expect(fetchCalls).toBe(2);
    expect(await store.get(KEY)).toEqual(originalEntry);

    // A stale hit during cooldown is still safe and does not hammer upstream.
    expect(await catalog.getCached()).toEqual(lastGood);
    await sleep(5);
    expect(fetchCalls).toBe(2);
    expect(await store.get(KEY)).toEqual(originalEntry);

    now = failure.retryAt;
    const recovered = [catalogModel("recovered")];
    fetchImpl = async () => {
      fetchCalls += 1;
      return recovered;
    };
    expect(await catalog.getCached()).toEqual(lastGood);
    await waitFor(async () => {
      const entry = await store.get<SWRCacheEntry<CatalogModel[]>>(KEY);
      return entry?.data[0]?.id === "recovered";
    }, "recovered model catalog was not written after the retry");
    expect(fetchCalls).toBe(3);
    expect(await store.get<SWRCacheEntry<CatalogModel[]>>(KEY)).toMatchObject({
      data: recovered,
    });
  });

  test("caches an empty catalog only when the provider is unconfigured", async () => {
    let fetchCalls = 0;
    const store = memoryCache();
    const catalog = new ModelCatalogCache({
      key: KEY,
      store,
      isProviderConfigured: () => false,
      fetchModels: async () => {
        fetchCalls += 1;
        return [catalogModel("unexpected")];
      },
      freshnessSeconds: 60,
      retentionSeconds: RETENTION_SECONDS,
    });

    expect(await catalog.getCached()).toEqual([]);
    expect(fetchCalls).toBe(0);
    expect(await store.get<SWRCacheEntry<CatalogModel[]>>(KEY)).toMatchObject({ data: [] });
    expect(await catalog.getCached()).toEqual([]);
    expect(fetchCalls).toBe(0);
  });

  test("rejects null and invalid real-cache values as typed contract failures", async () => {
    const store = memoryCache();
    const catalog = new ModelCatalogCache({
      key: KEY,
      store,
      isProviderConfigured: () => true,
      fetchModels: async () => [catalogModel("unused")],
      freshnessSeconds: 60,
      retentionSeconds: RETENTION_SECONDS,
    });
    const freshMetadata = {
      cachedAt: Date.now(),
      staleAt: Date.now() + 60_000,
    };

    await store.set(KEY, { ...freshMetadata, data: null }, RETENTION_SECONDS);
    await expect(catalog.getCached()).rejects.toMatchObject({
      name: "ElizaError",
      code: "MODEL_CATALOG_CACHE_CONTRACT_VIOLATION",
      context: { key: KEY, boundary: "cache", receivedKind: "null" },
      cause: expect.any(TypeError),
    });

    await store.set(KEY, { ...freshMetadata, data: { id: "not-an-array" } }, RETENTION_SECONDS);
    const invalidRead = catalog.getCached();
    await expect(invalidRead).rejects.toBeInstanceOf(ElizaError);
    await expect(invalidRead).rejects.toMatchObject({
      code: "MODEL_CATALOG_CACHE_CONTRACT_VIOLATION",
      context: { key: KEY, boundary: "cache", receivedKind: "object" },
      cause: expect.any(TypeError),
    });
  });

  test("explicit refresh preserves the cached entry through failure and cooldown", async () => {
    let now = 1_000;
    let fetchCalls = 0;
    let fetchImpl = async (): Promise<CatalogModel[]> => {
      fetchCalls += 1;
      return [catalogModel("last-good")];
    };
    const failures: ModelCatalogRefreshFailure[] = [];
    const store = memoryCache();
    const catalog = new ModelCatalogCache({
      key: KEY,
      store,
      isProviderConfigured: () => true,
      fetchModels: () => fetchImpl(),
      freshnessSeconds: 60,
      retentionSeconds: RETENTION_SECONDS,
      now: () => now,
      baseBackoffMs: 100,
      maxBackoffMs: 1_000,
      onRefreshFailure: (failure) => failures.push(failure),
    });

    await catalog.refresh();
    const lastGoodEntry = await store.get(KEY);
    fetchImpl = async () => {
      fetchCalls += 1;
      throw new Error("cron refresh failed");
    };

    await expect(catalog.refresh()).rejects.toThrow("cron refresh failed");
    expect(await store.get(KEY)).toEqual(lastGoodEntry);
    expect(fetchCalls).toBe(2);

    await expect(catalog.refresh()).rejects.toThrow("cron refresh failed");
    expect(fetchCalls).toBe(2);
    expect(failures).toHaveLength(1);

    now = failures[0].retryAt;
    fetchImpl = async () => {
      fetchCalls += 1;
      return [catalogModel("recovered")];
    };
    expect(await catalog.refresh()).toEqual([catalogModel("recovered")]);
    expect(fetchCalls).toBe(3);
  });
});

describe("ModelCatalogRefreshCoordinator", () => {
  test("coalesces work per key without blocking a different key", async () => {
    const coordinator = new ModelCatalogRefreshCoordinator<number>();
    const first = deferred<number>();
    const second = deferred<number>();
    let duplicateLoaderCalls = 0;

    const firstRun = coordinator.run("first", () => first.promise);
    const duplicateRun = coordinator.run("first", async () => {
      duplicateLoaderCalls += 1;
      return 99;
    });
    const secondRun = coordinator.run("second", () => second.promise);
    first.resolve(1);
    second.resolve(2);

    expect(await firstRun).toEqual({ kind: "loaded", value: 1 });
    expect(await duplicateRun).toEqual({ kind: "loaded", value: 1 });
    expect(await secondRun).toEqual({ kind: "loaded", value: 2 });
    expect(duplicateLoaderCalls).toBe(0);
  });

  test("uses exponential backoff capped at the configured maximum", async () => {
    let now = 0;
    const failures: ModelCatalogRefreshFailure[] = [];
    const coordinator = new ModelCatalogRefreshCoordinator<number>({
      now: () => now,
      baseBackoffMs: 10,
      maxBackoffMs: 25,
      onFailure: (failure) => failures.push(failure),
    });

    for (const expectedDelay of [10, 20, 25, 25]) {
      const result = await coordinator.run("models:catalog", async () => {
        throw new Error("still unavailable");
      });
      expect(result.kind).toBe("failed");
      if (result.kind !== "failed") throw new Error("expected failed refresh result");
      expect(result.retryAt - now).toBe(expectedDelay);
      now = result.retryAt;
    }

    expect(failures.map((failure) => failure.consecutiveFailures)).toEqual([1, 2, 3, 4]);
  });

  test("aggregates refresh and async observer failures into one handled result", async () => {
    const upstreamError = new Error("upstream unavailable");
    const observerError = new Error("logger unavailable");
    const coordinator = new ModelCatalogRefreshCoordinator<number>({
      onFailure: async () => {
        await Promise.resolve();
        throw observerError;
      },
    });

    const result = await coordinator.run("models:catalog", async () => {
      throw upstreamError;
    });

    expect(result).toMatchObject({
      kind: "failed",
      consecutiveFailures: 1,
    });
    if (result.kind !== "failed") throw new Error("expected failed refresh result");
    expect(result.error).toBeInstanceOf(AggregateError);
    expect((result.error as AggregateError).errors).toEqual([upstreamError, observerError]);
  });
});
