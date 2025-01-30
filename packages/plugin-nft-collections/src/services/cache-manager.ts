import { LRUCache } from "lru-cache";

interface CacheOptions {
    ttl?: number;
    maxSize?: number;
}

interface CacheEntry<T> {
    data: T;
    expiresAt: number;
    priority: number;
}

export class MemoryCacheManager {
    private cache: LRUCache<string, CacheEntry<unknown>>;
    private readonly DEFAULT_TTL = 3600000; // 1 hour
    private readonly COLLECTION_TTL = 300000; // 5 minutes
    private readonly MARKET_TTL = 60000; // 1 minute

    constructor(options: CacheOptions = {}) {
        this.cache = new LRUCache({
            max: options.maxSize || 1000,
            ttl: options.ttl || this.DEFAULT_TTL,
            updateAgeOnGet: true,
            updateAgeOnHas: true,
        });
    }

    private getExpirationTime(key: string): number {
        if (key.startsWith("collection:")) return this.COLLECTION_TTL;
        if (key.startsWith("market:")) return this.MARKET_TTL;
        return this.DEFAULT_TTL;
    }

    async get<T>(key: string): Promise<T | null> {
        const entry = this.cache.get(key) as CacheEntry<T>;
        if (!entry) return null;

        if (Date.now() > entry.expiresAt) {
            this.cache.delete(key);
            return null;
        }

        return entry.data;
    }

    async set<T>(key: string, value: T, priority = 0): Promise<void> {
        const ttl = this.getExpirationTime(key);
        const entry: CacheEntry<T> = {
            data: value,
            expiresAt: Date.now() + ttl,
            priority,
        };

        this.cache.set(key, entry);
    }

    async delete(key: string): Promise<void> {
        this.cache.delete(key);
    }

    async clear(): Promise<void> {
        this.cache.clear();
    }

    async has(key: string): Promise<boolean> {
        const entry = this.cache.get(key) as CacheEntry<unknown>;
        if (!entry) return false;

        if (Date.now() > entry.expiresAt) {
            this.cache.delete(key);
            return false;
        }

        return true;
    }

    async prune(): Promise<void> {
        const now = Date.now();
        for (const [key, entry] of this.cache.entries()) {
            if (now > entry.expiresAt) {
                this.cache.delete(key);
            }
        }
    }
}
