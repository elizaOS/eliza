/**
 * Keeps the upstream model catalog available through provider outages without
 * turning cold or stale reads into a retry storm. Refresh work is coalesced per
 * cache key, failures enter a bounded cooldown, and only successful loads can
 * replace the last-good shared-cache entry.
 */
import type { CatalogModel } from "../models";

export const MODEL_CATALOG_FAILURE_BACKOFF_BASE_MS = 30_000;
export const MODEL_CATALOG_FAILURE_BACKOFF_MAX_MS = 5 * 60_000;

export interface ModelCatalogCacheStore {
  get<T>(key: string): Promise<T | null>;
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
  onFailure?: (failure: ModelCatalogRefreshFailure) => void;
}

/** Coalesces refreshes and suppresses retries until the key's cooldown expires. */
export class ModelCatalogRefreshCoordinator<T> {
  private readonly states = new Map<string, RefreshState<T>>();
  private readonly now: () => number;
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly onFailure: ((failure: ModelCatalogRefreshFailure) => void) | undefined;

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
        (error: unknown): ModelCatalogRefreshResult<T> => {
          state.consecutiveFailures += 1;
          const exponent = Math.min(state.consecutiveFailures - 1, 30);
          const backoffMs = Math.min(this.maxBackoffMs, this.baseBackoffMs * 2 ** exponent);
          state.retryAt = this.now() + backoffMs;
          state.lastError = error;
          // error-policy:J5 this is the sole observer for the shared in-flight
          // rejection; every waiter receives the same explicit failure result.
          try {
            this.onFailure?.({
              key,
              error,
              retryAt: state.retryAt,
              consecutiveFailures: state.consecutiveFailures,
            });
          } catch {
            // Observability must never turn the coordinator's explicit
            // failure result back into a rejected background promise.
          }
          return {
            kind: "failed",
            error,
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
  onRefreshFailure?: (failure: ModelCatalogRefreshFailure) => void;
}

function isCatalogCacheEntry(value: unknown): value is ModelCatalogCacheEntry {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ModelCatalogCacheEntry>;
  return (
    Array.isArray(candidate.data) &&
    typeof candidate.cachedAt === "number" &&
    Number.isFinite(candidate.cachedAt) &&
    typeof candidate.staleAt === "number" &&
    Number.isFinite(candidate.staleAt)
  );
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

  private async readEntry(): Promise<ModelCatalogCacheEntry | null> {
    const cached = await this.store.get<unknown>(this.key);
    return isCatalogCacheEntry(cached) ? cached : null;
  }

  private runRefresh(): Promise<ModelCatalogRefreshResult<CatalogModel[]>> {
    return this.refreshes.run(this.key, async () => {
      const models = this.isProviderConfigured() ? await this.fetchModels() : [];
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
    });
  }

  async getCached(): Promise<CatalogModel[]> {
    const cached = await this.readEntry();
    if (cached) {
      if (this.now() > cached.staleAt) {
        // The coordinator always resolves with an explicit result, so this
        // background refresh cannot create an unhandled rejection.
        void this.runRefresh();
      }
      return cached.data;
    }

    const refreshed = await this.runRefresh();
    return refreshed.kind === "loaded" ? refreshed.value : [];
  }

  async refresh(): Promise<CatalogModel[]> {
    const refreshed = await this.runRefresh();
    if (refreshed.kind === "loaded") return refreshed.value;
    throw refreshed.error;
  }

  /** Test hook for module-level consumers that share the production instance. */
  clearRefreshStateForTests(): void {
    this.refreshes.clear();
  }
}
