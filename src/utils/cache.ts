import { LRUCache } from "lru-cache";
import { createHash } from "crypto";

export class CacheService {
  private cache: LRUCache<string, any>;

  constructor(ttl: number = 300) {
    this.cache = new LRUCache({
      max: 1000,
      ttl: ttl * 1000, // Convert to milliseconds
      maxSize: 50 * 1024 * 1024, // 50MB max size
      sizeCalculation: (value) => {
        try {
          return JSON.stringify(value).length;
        } catch {
          return 1000; // Default size for non-serializable objects
        }
      },
    });
  }

  /**
   * Generate a cache key from input parameters
   */
  generateKey(input: any): string {
    const hash = createHash("sha256");
    hash.update(JSON.stringify(input));
    return hash.digest("hex");
  }

  /**
   * Get a value from cache
   */
  get<T = any>(key: string): T | null {
    return this.cache.get(key) ?? null;
  }

  /**
   * Set a value in cache
   */
  set<T = any>(key: string, value: T, ttl?: number): void {
    this.cache.set(key, value, {
      ttl: ttl ? ttl * 1000 : undefined,
    });
  }

  /**
   * Check if a key exists in cache
   */
  has(key: string): boolean {
    return this.cache.has(key);
  }

  /**
   * Delete a key from cache
   */
  delete(key: string): boolean {
    return this.cache.delete(key);
  }

  /**
   * Clear all cache entries
   */
  clear(): void {
    this.cache.clear();
  }

  /**
   * Get cache statistics
   */
  getStats() {
    return {
      size: this.cache.size,
      calculatedSize: this.cache.calculatedSize,
      maxSize: this.cache.maxSize,
      itemCount: this.cache.size,
    };
  }
}
