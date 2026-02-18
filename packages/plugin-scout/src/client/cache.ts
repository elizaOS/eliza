interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

export interface ScoutCacheOptions {
  ttlMinutes: number;
  maxEntries: number;
}

export class ScoutCache {
  private store = new Map<string, CacheEntry<unknown>>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;

  constructor(options: ScoutCacheOptions) {
    this.ttlMs = options.ttlMinutes * 60 * 1000;
    this.maxEntries = options.maxEntries;
  }

  get<T>(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;

    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }

    return entry.value as T;
  }

  set<T>(key: string, value: T): void {
    // Evict oldest entries if at capacity
    if (this.store.size >= this.maxEntries) {
      const firstKey = this.store.keys().next().value;
      if (firstKey !== undefined) {
        this.store.delete(firstKey);
      }
    }

    this.store.set(key, {
      value,
      expiresAt: Date.now() + this.ttlMs,
    });
  }

  has(key: string): boolean {
    return this.get(key) !== undefined;
  }

  delete(key: string): void {
    this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
  }

  get size(): number {
    return this.store.size;
  }
}