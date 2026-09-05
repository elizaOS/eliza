/**
 * Keeps the upstream model catalog available through provider outages without
 * turning cold or stale reads into a retry storm. Refresh work is coalesced per
 * cache key, failures enter a bounded cooldown, and only successful loads can
 * replace the last-good shared-cache entry.
 */
import { ElizaError } from "@elizaos/core/edge";
import type { CatalogModel } from "../models";

export const MODEL_CATALOG_FAILURE_BACKOFF_BASE_MS = 30_000;
export const MODEL_CATALOG_FAILURE_BACKOFF_MAX_MS = 5 * 60_000;

export interface ModelCatalogCacheStore {
  getWithSWR<T>(
    key: string,
    staleTTL: number,
    revalidate: () => Promise<T>,
    ttl?: number,
  ): Promise<T | null>;
  set<T>(key: string, value: T, ttlSeconds: number): Promise<void>;
}

interface ModelCatalogCacheEntry {
  data: CatalogModel[];
  cachedAt: number;
  staleAt: number;
}

export type ModelCatalogRefreshResult<T> =
  | { kind: "loaded"; value: T }
  | {
      kind: "failed" | "cooldown";
      error: unknown;
      retryAt: number;
      consecutiveFailures: number;
    };

export interface ModelCatalogRefreshFailure {
  key: string;
  error: unknown;
  retryAt: number;
  consecutiveFailures: number;
}

interface RefreshState<T> {
  inFlight: Promise<ModelCatalogRefreshResult<T>> | null;
  retryAt: number;
  consecutiveFailures: number;
  lastError: unknown;
}

interface ModelCatalogRefreshCoordinatorOptions {
  now?: () => number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  onFailure?: (failure: ModelCatalogRefreshFailure) => void | Promise<void>;
}

/** Coalesces refreshes and suppresses retries until the key's cooldown expires. */
export class ModelCatalogRefreshCoordinator<T> {
  private readonly states = new Map<string, RefreshState<T>>();
  private readonly now: () => number;
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly onFailure:
    | ((failure: ModelCatalogRefreshFailure) => void | Promise<void>)
    | undefined;

  constructor(options: ModelCatalogRefreshCoordinatorOptions = {}) {
    this.now = options.now ?? Date.now;
    this.baseBackoffMs = options.baseBackoffMs ?? MODEL_CATALOG_FAILURE_BACKOFF_BASE_MS;
    this.maxBackoffMs = options.maxBackoffMs ?? MODEL_CATALOG_FAILURE_BACKOFF_MAX_MS;
    this.onFailure = options.onFailure;
  }

  run(key: string, load: () => Promise<T>): Promise<ModelCatalogRefreshResult<T>> {
    let state = this.states.get(key);
    if (!state) {
      state = {
        inFlight: null,
        retryAt: 0,
        consecutiveFailures: 0,
        lastError: undefined,
      };
      this.states.set(key, state);
    }

    if (state.inFlight) return state.inFlight;

    if (this.now() < state.retryAt) {
      return Promise.resolve({
        kind: "cooldown",
        error: state.lastError,
        retryAt: state.retryAt,
        consecutiveFailures: state.consecutiveFailures,
      });
    }

    let attempt: Promise<ModelCatalogRefreshResult<T>>;
    attempt = Promise.resolve()
      .then(load)
      .then(
        (value): ModelCatalogRefreshResult<T> => {
          state.consecutiveFailures = 0;
          state.retryAt = 0;
          state.lastError = undefined;
          return { kind: "loaded", value };
        },
        async (error: unknown): Promise<ModelCatalogRefreshResult<T>> => {
          state.consecutiveFailures += 1;
          const exponent = Math.min(state.consecutiveFailures - 1, 30);
          const backoffMs = Math.min(this.maxBackoffMs, this.baseBackoffMs * 2 ** exponent);
          state.retryAt = this.now() + backoffMs;
          state.lastError = error;
          // error-policy:J5 this is the sole observer for the shared in-flight
          // rejection; every waiter receives the same explicit failure result.
          try {
            await this.onFailure?.({
              key,
              error,
              retryAt: state.retryAt,
              consecutiveFailures: state.consecutiveFailures,
            });
          } catch (observerError) {
            // error-policy:J5 the observer exception is captured in the same
            // explicit result returned to every waiter, so diagnostics cannot
            // turn a handled refresh failure into an unhandled rejection.
            state.lastError = new AggregateError(
              [error, observerError],
              "Model catalog refresh and failure observer both failed",
            );
          }
          return {
            kind: "failed",
            error: state.lastError,
            retryAt: state.retryAt,
            consecutiveFailures: state.consecutiveFailures,
          };
        },
      )
      .finally(() => {
        if (state.inFlight === attempt) state.inFlight = null;
        if (state.consecutiveFailures === 0) this.states.delete(key);
      });

    state.inFlight = attempt;
    return attempt;
  }

  clear(): void {
    this.states.clear();
  }
}

export interface ModelCatalogCacheOptions {
  key: string;
  store: ModelCatalogCacheStore;
  isProviderConfigured: () => boolean;
  fetchModels: () => Promise<CatalogModel[]>;
  freshnessSeconds: number;
  retentionSeconds: number;
  now?: () => number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  onRefreshFailure?: (failure: ModelCatalogRefreshFailure) => void | Promise<void>;
}

function valueKind(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function requireCatalogModels(
  value: unknown,
  key: string,
  boundary: "cache" | "refresh",
): CatalogModel[] {
  if (Array.isArray(value)) return value as CatalogModel[];

  const receivedKind = valueKind(value);
  const cause = new TypeError(`Expected a model catalog array, received ${receivedKind}`);
  throw new ElizaError("Model catalog cache contract returned an invalid value", {
    code: "MODEL_CATALOG_CACHE_CONTRACT_VIOLATION",
    context: { key, boundary, receivedKind },
    cause,
    severity: "fatal",
  });
}

/** Owns the BitRouter catalog's shared-cache and refresh policy. */
export class ModelCatalogCache {
  private readonly key: string;
  private readonly store: ModelCatalogCacheStore;
  private readonly isProviderConfigured: () => boolean;
  private readonly fetchModels: () => Promise<CatalogModel[]>;
  private readonly freshnessSeconds: number;
  private readonly retentionSeconds: number;
  private readonly now: () => number;
  private readonly refreshes: ModelCatalogRefreshCoordinator<CatalogModel[]>;

  constructor(options: ModelCatalogCacheOptions) {
    this.key = options.key;
    this.store = options.store;
    this.isProviderConfigured = options.isProviderConfigured;
    this.fetchModels = options.fetchModels;
    this.freshnessSeconds = options.freshnessSeconds;
    this.retentionSeconds = options.retentionSeconds;
    this.now = options.now ?? Date.now;
    this.refreshes = new ModelCatalogRefreshCoordinator<CatalogModel[]>({
      now: this.now,
      baseBackoffMs: options.baseBackoffMs,
      maxBackoffMs: options.maxBackoffMs,
      onFailure: options.onRefreshFailure,
    });
  }

  private runRefresh(): Promise<ModelCatalogRefreshResult<CatalogModel[]>> {
    return this.refreshes.run(this.key, async () => {
      if (!this.isProviderConfigured()) return [];
      return requireCatalogModels(await this.fetchModels(), this.key, "refresh");
    });
  }

  private async loadModels(): Promise<CatalogModel[]> {
    const refreshed = await this.runRefresh();
    if (refreshed.kind === "loaded") return refreshed.value;
    throw refreshed.error;
  }

  async getCached(): Promise<CatalogModel[]> {
    const cached = await this.store.getWithSWR<unknown>(
      this.key,
      this.freshnessSeconds,
      () => this.loadModels(),
      this.retentionSeconds,
    );

    // A configured cold miss rejects in loadModels. Null or another invalid
    // value therefore means the cache boundary violated its declared contract;
    // it must never be translated into a healthy empty catalog.
    return requireCatalogModels(cached, this.key, "cache");
  }

  async refresh(): Promise<CatalogModel[]> {
    const models = await this.loadModels();
    const cachedAt = this.now();
    await this.store.set<ModelCatalogCacheEntry>(
      this.key,
      {
        data: models,
        cachedAt,
        staleAt: cachedAt + this.freshnessSeconds * 1000,
      },
      this.retentionSeconds,
    );
    return models;
  }

  /** Test hook for module-level consumers that share the production instance. */
  clearRefreshStateForTests(): void {
    this.refreshes.clear();
  }
}
