/**
 * Proves model-catalog refreshes remain single-flight and preserve last-good
 * data across deterministic upstream failures, cooldowns, and recovery.
 */
import { describe, expect, test } from "bun:test";
import type { CatalogModel } from "../models";
import {
  ModelCatalogCache,
  type ModelCatalogCacheStore,
  ModelCatalogRefreshCoordinator,
  type ModelCatalogRefreshFailure,
} from "./model-catalog-cache";

const FRESHNESS_SECONDS = 15 * 60;
const RETENTION_SECONDS = 7 * 24 * 60 * 60;

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

interface StoredValue {
  key: string;
  value: unknown;
  expiresAt: number;
}

class FakeCatalogStore implements ModelCatalogCacheStore {
  private stored: StoredValue | null = null;
  private readonly writeWaiters: Array<{ count: number; resolve: () => void }> = [];
  readonly setCalls: Array<{ key: string; value: unknown; ttlSeconds: number }> = [];

  constructor(
    private readonly now: () => number,
    initialValue?: StoredValue,
  ) {
    this.stored = initialValue ?? null;
  }

  async get<T>(key: string): Promise<T | null> {
    if (!this.stored || this.stored.key !== key) return null;
    if (this.now() >= this.stored.expiresAt) {
      this.stored = null;
      return null;
    }
    return this.stored.value as T;
  }

  async set<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
    this.stored = {
      key,
      value,
      expiresAt: this.now() + ttlSeconds * 1000,
    };
    this.setCalls.push({ key, value, ttlSeconds });
    for (let index = this.writeWaiters.length - 1; index >= 0; index -= 1) {
      const waiter = this.writeWaiters[index];
      if (this.setCalls.length >= waiter.count) {
        this.writeWaiters.splice(index, 1);
        waiter.resolve();
      }
    }
  }

  async waitForWriteCount(count: number): Promise<void> {
    if (this.setCalls.length >= count) return;
    await new Promise<void>((resolve) => {
      this.writeWaiters.push({ count, resolve });
    });
  }

  peek<T>(): T | null {
    return this.stored?.value as T | null;
  }
}

describe("ModelCatalogCache", () => {
  test("coalesces N cold failures, cools down once, then recovers", async () => {
    let now = 1_000;
    let fetchCalls = 0;
    let fetchImpl: () => Promise<CatalogModel[]>;
    const started = deferred<void>();
    const upstream = deferred<CatalogModel[]>();
    const failures: ModelCatalogRefreshFailure[] = [];
    const store = new FakeCatalogStore(() => now);

    fetchImpl = () => {
      fetchCalls += 1;
      started.resolve(undefined);
      return upstream.promise;
    };
    const cache = new ModelCatalogCache({
      key: "models:catalog",
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

    const reads = Array.from({ length: 32 }, () => cache.getCached());
    await started.promise;
    expect(fetchCalls).toBe(1);

    upstream.reject(new Error("OpenRouter unavailable"));
    expect(await Promise.all(reads)).toEqual(Array.from({ length: 32 }, () => []));
    expect(failures).toHaveLength(1);
    expect(store.setCalls).toHaveLength(0);

    expect(await Promise.all(Array.from({ length: 32 }, () => cache.getCached()))).toEqual(
      Array.from({ length: 32 }, () => []),
    );
    expect(fetchCalls).toBe(1);
    expect(failures).toHaveLength(1);

    now = failures[0].retryAt;
    const recovered = [catalogModel("recovered")];
    fetchImpl = async () => {
      fetchCalls += 1;
      return recovered;
    };
    expect(await cache.getCached()).toEqual(recovered);
    expect(fetchCalls).toBe(2);
    expect(store.setCalls).toHaveLength(1);
    expect(await cache.getCached()).toEqual(recovered);
    expect(fetchCalls).toBe(2);
  });

  test("returns stale data while N readers share one background refresh", async () => {
    let now = 0;
    let fetchCalls = 0;
    let fetchImpl = async (): Promise<CatalogModel[]> => {
      fetchCalls += 1;
      return [catalogModel("old")];
    };
    const store = new FakeCatalogStore(() => now);
    const cache = new ModelCatalogCache({
      key: "models:catalog",
      store,
      isProviderConfigured: () => true,
      fetchModels: () => fetchImpl(),
      freshnessSeconds: FRESHNESS_SECONDS,
      retentionSeconds: RETENTION_SECONDS,
      now: () => now,
    });

    const stale = await cache.getCached();
    expect(stale).toEqual([catalogModel("old")]);
    now = FRESHNESS_SECONDS * 1000 + 1;

    const refreshStarted = deferred<void>();
    const refresh = deferred<CatalogModel[]>();
    fetchImpl = () => {
      fetchCalls += 1;
      refreshStarted.resolve(undefined);
      return refresh.promise;
    };
    const reads = await Promise.all(Array.from({ length: 32 }, () => cache.getCached()));
    expect(reads).toEqual(Array.from({ length: 32 }, () => stale));
    await refreshStarted.promise;
    expect(fetchCalls).toBe(2);

    refresh.resolve([catalogModel("fresh")]);
    await store.waitForWriteCount(2);
    expect(store.peek<{ data: CatalogModel[] }>()?.data).toEqual([catalogModel("fresh")]);
  });

  test("retains last-good data for seven days when a stale refresh fails", async () => {
    let now = 0;
    let fetchImpl = async (): Promise<CatalogModel[]> => [catalogModel("last-good")];
    const failed = deferred<ModelCatalogRefreshFailure>();
    const store = new FakeCatalogStore(() => now);
    const cache = new ModelCatalogCache({
      key: "models:catalog",
      store,
      isProviderConfigured: () => true,
      fetchModels: () => fetchImpl(),
      freshnessSeconds: FRESHNESS_SECONDS,
      retentionSeconds: RETENTION_SECONDS,
      now: () => now,
      baseBackoffMs: 100,
      onRefreshFailure: (failure) => failed.resolve(failure),
    });

    const lastGood = await cache.getCached();
    expect(store.setCalls[0].ttlSeconds).toBe(RETENTION_SECONDS);
    const originalEntry = store.peek();

    now = 2 * 60 * 60 * 1000;
    fetchImpl = async () => {
      throw new Error("temporary outage");
    };
    expect(await cache.getCached()).toEqual(lastGood);
    await failed.promise;
    expect(store.setCalls).toHaveLength(1);
    expect(store.peek()).toEqual(originalEntry);

    now = 6 * 24 * 60 * 60 * 1000;
    expect(await store.get("models:catalog")).toEqual(originalEntry);
    now = RETENTION_SECONDS * 1000;
    expect(await store.get("models:catalog")).toBeNull();
  });

  test("caches an empty catalog when no provider is configured", async () => {
    let now = 0;
    let fetchCalls = 0;
    const store = new FakeCatalogStore(() => now);
    const cache = new ModelCatalogCache({
      key: "models:catalog",
      store,
      isProviderConfigured: () => false,
      fetchModels: async () => {
        fetchCalls += 1;
        return [catalogModel("unexpected")];
      },
      freshnessSeconds: FRESHNESS_SECONDS,
      retentionSeconds: RETENTION_SECONDS,
      now: () => now,
    });

    expect(await cache.getCached()).toEqual([]);
    expect(fetchCalls).toBe(0);
    expect(store.setCalls).toHaveLength(1);
    expect(store.peek<{ data: CatalogModel[] }>()?.data).toEqual([]);
    expect(await cache.getCached()).toEqual([]);
    expect(store.setCalls).toHaveLength(1);
  });

  test("explicit refresh preserves cached data through failure and cooldown", async () => {
    let now = 0;
    let fetchCalls = 0;
    let fetchImpl = async (): Promise<CatalogModel[]> => {
      fetchCalls += 1;
      return [catalogModel("last-good")];
    };
    const failures: ModelCatalogRefreshFailure[] = [];
    const store = new FakeCatalogStore(() => now);
    const cache = new ModelCatalogCache({
      key: "models:catalog",
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

    await cache.getCached();
    const lastGoodEntry = store.peek();
    fetchImpl = async () => {
      fetchCalls += 1;
      throw new Error("cron refresh failed");
    };

    await expect(cache.refresh()).rejects.toThrow("cron refresh failed");
    expect(store.peek()).toEqual(lastGoodEntry);
    expect(store.setCalls).toHaveLength(1);
    expect(fetchCalls).toBe(2);

    await expect(cache.refresh()).rejects.toThrow("cron refresh failed");
    expect(fetchCalls).toBe(2);
    expect(failures).toHaveLength(1);

    now = failures[0].retryAt;
    fetchImpl = async () => {
      fetchCalls += 1;
      return [catalogModel("recovered")];
    };
    expect(await cache.refresh()).toEqual([catalogModel("recovered")]);
    expect(store.setCalls).toHaveLength(2);
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

  test("keeps refresh failures explicit when the observability callback throws", async () => {
    const coordinator = new ModelCatalogRefreshCoordinator<number>({
      onFailure: () => {
        throw new Error("logger unavailable");
      },
    });

    const result = await coordinator.run("models:catalog", async () => {
      throw new Error("upstream unavailable");
    });

    expect(result).toMatchObject({
      kind: "failed",
      error: expect.objectContaining({ message: "upstream unavailable" }),
      consecutiveFailures: 1,
    });
  });
});
