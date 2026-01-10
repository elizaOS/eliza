import { logger, type UUID } from '@elizaos/core';

export interface CacheEntry<T> {
  data: T;
  timestamp: number;
  ttl: number;
  accessCount: number;
  lastAccessed: number;
}

export interface CacheStats {
  totalEntries: number;
  hitRate: number;
  missRate: number;
  memoryUsage: number;
  oldestEntry: number;
  newestEntry: number;
  totalHits: number;
  totalMisses: number;
}

/**
 * High-performance caching manager with LRU eviction and TTL support
 */
export class CacheManager {
  private cache: Map<string, CacheEntry<any>> = new Map();
  private readonly maxSize: number;
  private readonly defaultTTL: number;
  private stats = {
    hits: 0,
    misses: 0,
    evictions: 0,
    expired: 0,
  };

  constructor(maxSize: number = 1000, defaultTTL: number = 5 * 60 * 1000) {
    this.maxSize = maxSize;
    this.defaultTTL = defaultTTL;
    this.initialize();
  }

  private initialize(): void {
    // Start cleanup timer
    setInterval(() => this.cleanup(), 60000); // Cleanup every minute
    logger.info('CacheManager initialized');
  }

  // ====== Core Cache Operations ======

  async get<T>(key: string): Promise<T | null> {
    const entry = this.cache.get(key);

    if (!entry) {
      this.stats.misses++;
      return null;
    }

    // Check if expired
    if (this.isExpired(entry)) {
      this.cache.delete(key);
      this.stats.expired++;
      this.stats.misses++;
      return null;
    }

    // Update access statistics
    entry.accessCount++;
    entry.lastAccessed = Date.now();
    this.stats.hits++;

    return entry.data as T;
  }

  async set<T>(key: string, data: T, ttl?: number): Promise<void> {
    const now = Date.now();
    const entryTTL = ttl || this.defaultTTL;

    // Check if we need to evict
    if (this.cache.size >= this.maxSize && !this.cache.has(key)) {
      this.evictLRU();
    }

    const entry: CacheEntry<T> = {
      data,
      timestamp: now,
      ttl: entryTTL,
      accessCount: 1,
      lastAccessed: now,
    };

    this.cache.set(key, entry);
  }

  async delete(key: string): Promise<boolean> {
    return this.cache.delete(key);
  }

  async clear(): Promise<void> {
    this.cache.clear();
    this.resetStats();
  }

  async has(key: string): Promise<boolean> {
    const entry = this.cache.get(key);
    if (!entry) return false;

    if (this.isExpired(entry)) {
      this.cache.delete(key);
      this.stats.expired++;
      return false;
    }

    return true;
  }

  // ====== Advanced Operations ======

  async getOrSet<T>(key: string, fetcher: () => Promise<T>, ttl?: number): Promise<T> {
    const cached = await this.get<T>(key);
    if (cached !== null) {
      return cached;
    }

    const data = await fetcher();
    await this.set(key, data, ttl);
    return data;
  }

  async mget<T>(keys: string[]): Promise<Map<string, T>> {
    const results = new Map<string, T>();

    for (const key of keys) {
      const value = await this.get<T>(key);
      if (value !== null) {
        results.set(key, value);
      }
    }

    return results;
  }

  async mset<T>(entries: Map<string, T>, ttl?: number): Promise<void> {
    for (const [key, value] of entries) {
      await this.set(key, value, ttl);
    }
  }

  async getByPattern(pattern: RegExp): Promise<Map<string, any>> {
    const results = new Map();

    for (const [key, entry] of this.cache) {
      if (pattern.test(key) && !this.isExpired(entry)) {
        results.set(key, entry.data);
      }
    }

    return results;
  }

  async deleteByPattern(pattern: RegExp): Promise<number> {
    let deleted = 0;

    for (const key of this.cache.keys()) {
      if (pattern.test(key)) {
        this.cache.delete(key);
        deleted++;
      }
    }

    return deleted;
  }

  // ====== Cache Management ======

  private isExpired(entry: CacheEntry<any>): boolean {
    return Date.now() - entry.timestamp > entry.ttl;
  }

  private evictLRU(): void {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;

    for (const [key, entry] of this.cache) {
      if (entry.lastAccessed < oldestTime) {
        oldestTime = entry.lastAccessed;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      this.cache.delete(oldestKey);
      this.stats.evictions++;
    }
  }

  private cleanup(): void {
    const now = Date.now();
    const keysToDelete: string[] = [];

    for (const [key, entry] of this.cache) {
      if (this.isExpired(entry)) {
        keysToDelete.push(key);
      }
    }

    for (const key of keysToDelete) {
      this.cache.delete(key);
      this.stats.expired++;
    }

    if (keysToDelete.length > 0) {
      logger.debug(`Cleaned up ${keysToDelete.length} expired cache entries`);
    }
  }

  // ====== Statistics and Monitoring ======

  getStats(): CacheStats {
    const totalRequests = this.stats.hits + this.stats.misses;
    const hitRate = totalRequests > 0 ? this.stats.hits / totalRequests : 0;
    const missRate = totalRequests > 0 ? this.stats.misses / totalRequests : 0;

    let oldestEntry = Infinity;
    let newestEntry = 0;
    let memoryEstimate = 0;

    for (const entry of this.cache.values()) {
      oldestEntry = Math.min(oldestEntry, entry.timestamp);
      newestEntry = Math.max(newestEntry, entry.timestamp);

      // Rough memory estimation
      try {
        const serialized = JSON.stringify(entry.data);
        memoryEstimate += serialized.length * 2; // UTF-16 characters
      } catch {
        memoryEstimate += 1000; // Fallback estimate
      }
    }

    return {
      totalEntries: this.cache.size,
      hitRate,
      missRate,
      memoryUsage: memoryEstimate,
      oldestEntry: oldestEntry === Infinity ? 0 : oldestEntry,
      newestEntry,
      totalHits: this.stats.hits,
      totalMisses: this.stats.misses,
    };
  }

  resetStats(): void {
    this.stats = {
      hits: 0,
      misses: 0,
      evictions: 0,
      expired: 0,
    };
  }

  // ====== Specialized Todo Cache Methods ======

  async cacheEntity(entityId: UUID, entity: any, ttl: number = 5 * 60 * 1000): Promise<void> {
    await this.set(`entity:${entityId}`, entity, ttl);
  }

  async getCachedEntity(entityId: UUID): Promise<any | null> {
    return await this.get(`entity:${entityId}`);
  }

  async cacheUserBehavior(
    userId: UUID,
    behavior: any,
    ttl: number = 30 * 60 * 1000
  ): Promise<void> {
    await this.set(`behavior:${userId}`, behavior, ttl);
  }

  async getCachedUserBehavior(userId: UUID): Promise<any | null> {
    return await this.get(`behavior:${userId}`);
  }

  async cacheReminderRecommendation(
    todoId: UUID,
    recommendation: any,
    ttl: number = 10 * 60 * 1000
  ): Promise<void> {
    await this.set(`recommendation:${todoId}`, recommendation, ttl);
  }

  async getCachedReminderRecommendation(todoId: UUID): Promise<any | null> {
    return await this.get(`recommendation:${todoId}`);
  }

  async cacheServiceHealth(
    serviceName: string,
    health: any,
    ttl: number = 30 * 1000
  ): Promise<void> {
    await this.set(`health:${serviceName}`, health, ttl);
  }

  async getCachedServiceHealth(serviceName: string): Promise<any | null> {
    return await this.get(`health:${serviceName}`);
  }

  // ====== Cache Warming ======

  async warmUpCache(): Promise<void> {
    logger.info('Starting cache warm-up process...');

    try {
      // Pre-load frequently accessed data
      const entityIds = await this.getFrequentlyAccessedEntities();
      const serviceNames = ['TODO_REMINDER', 'TODO_INTEGRATION_BRIDGE', 'NOTIFICATION'];

      // Warm up entity cache
      for (const entityId of entityIds) {
        try {
          await this.warmUpEntity(entityId);
        } catch (error) {
          logger.debug(`Failed to warm up entity ${entityId}:`, error);
        }
      }

      // Warm up service health cache
      for (const serviceName of serviceNames) {
        try {
          await this.warmUpServiceHealth(serviceName);
        } catch (error) {
          logger.debug(`Failed to warm up service health ${serviceName}:`, error);
        }
      }

      logger.info('Cache warm-up completed');
    } catch (error) {
      logger.error('Error during cache warm-up:', error);
    }
  }

  private async getFrequentlyAccessedEntities(): Promise<UUID[]> {
    // This would typically query the database for active users
    // For now, return empty array
    return [];
  }

  private async warmUpEntity(entityId: UUID): Promise<void> {
    // This would typically fetch entity data from the database
    // For now, just create a placeholder entry
    await this.cacheEntity(entityId, { id: entityId, warmedUp: true });
  }

  private async warmUpServiceHealth(serviceName: string): Promise<void> {
    // This would typically check actual service health
    // For now, just create a placeholder entry
    await this.cacheServiceHealth(serviceName, {
      status: 'unknown',
      warmedUp: true,
      timestamp: Date.now(),
    });
  }

  // ====== Memory Management ======

  async optimize(): Promise<void> {
    logger.info('Optimizing cache...');

    // Remove expired entries
    this.cleanup();

    // If still over capacity, be more aggressive
    if (this.cache.size > this.maxSize * 0.9) {
      await this.aggressiveCleanup();
    }

    // Force garbage collection if available
    if (global.gc) {
      global.gc();
    }

    logger.info(`Cache optimization complete. Size: ${this.cache.size}/${this.maxSize}`);
  }

  private async aggressiveCleanup(): Promise<void> {
    // Sort entries by access count and last accessed time
    const entries = Array.from(this.cache.entries()).sort(([, a], [, b]) => {
      const scoreA = a.accessCount * 0.7 + (Date.now() - a.lastAccessed) * 0.3;
      const scoreB = b.accessCount * 0.7 + (Date.now() - b.lastAccessed) * 0.3;
      return scoreA - scoreB;
    });

    // Remove bottom 20%
    const toRemove = Math.floor(entries.length * 0.2);
    for (let i = 0; i < toRemove; i++) {
      this.cache.delete(entries[i][0]);
      this.stats.evictions++;
    }
  }

  // ====== Manager Lifecycle ======

  async stop(): Promise<void> {
    await this.clear();
    logger.info('CacheManager stopped');
  }
}
