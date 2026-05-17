/**
 * Generic in-memory LRU cache with TTL-based expiry.
 *
 * Eviction strategy (when at capacity):
 * 1. Evict expired entries first
 * 2. If still over capacity, evict oldest entries (by insertion order) down to 75%
 */

interface CacheEntry<V> {
  value: V;
  expiresAt: number;
}

export class InMemoryLRUCache<V> {
  private readonly cache = new Map<string, CacheEntry<V>>();
  private readonly maxSize: number;
  private readonly ttlMs: number;

  constructor(maxSize: number, ttlMs: number) {
    this.maxSize = maxSize;
    this.ttlMs = ttlMs;
  }

  get(key: string): V | null {
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return null;
    }
    // True LRU: move to end of Map iteration order so recently-accessed
    // entries are evicted last. Map preserves insertion order.
    this.cache.delete(key);
    this.cache.set(key, entry);
    return entry.value;
  }

  set(key: string, value: V): void {
    if (this.cache.size >= this.maxSize) {
      this.evict();
    }
    this.cache.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }

  delete(key: string): void {
    this.cache.delete(key);
  }

  /** O(n) scan over all keys — acceptable for low-frequency invalidation calls. */
  deleteByPrefix(prefix: string): void {
    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) {
        this.cache.delete(key);
      }
    }
  }

  private evict(): void {
    const now = Date.now();
    for (const [key, entry] of this.cache) {
      if (now > entry.expiresAt) {
        this.cache.delete(key);
      }
    }
    if (this.cache.size >= this.maxSize) {
      const keys = Array.from(this.cache.keys());
      const toRemove = keys.length - Math.floor(this.maxSize * 0.75);
      for (let i = 0; i < toRemove; i++) {
        this.cache.delete(keys[i]);
      }
    }
  }
}
