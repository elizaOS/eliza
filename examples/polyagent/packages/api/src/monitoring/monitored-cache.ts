/**
 * Monitored Cache Service
 * Wraps cache operations with performance monitoring
 *
 * Note: This file provides the interface but requires the cache service
 * to be injected from the application layer.
 */

import { performanceMonitor } from "./performance-monitor";

export interface CacheOptions {
  ttl?: number;
  tags?: string[];
}

// Cache service interface - to be injected from app
export interface CacheService {
  get<T>(key: string, options?: CacheOptions): Promise<T | null>;
  set<T>(key: string, value: T, options?: CacheOptions): Promise<void>;
  invalidate(key: string, options?: CacheOptions): Promise<void>;
}

let cacheServiceInstance: CacheService | null = null;

export function setCacheService(service: CacheService): void {
  cacheServiceInstance = service;
}

function getCacheService(): CacheService {
  if (!cacheServiceInstance) {
    throw new Error(
      "CacheService not initialized. Call setCacheService() first.",
    );
  }
  return cacheServiceInstance;
}

/**
 * Get value from cache with monitoring
 */
export async function getMonitoredCache<T>(
  key: string,
  options: CacheOptions = {},
): Promise<T | null> {
  const startTime = performance.now();

  const cacheService = getCacheService();
  const value = await cacheService.get<T>(key, options);
  const latency = performance.now() - startTime;
  const hit = value !== null;

  // Estimate size (rough approximation)
  const bytes = value ? JSON.stringify(value).length : 0;

  performanceMonitor.recordCacheOperation("get", hit, latency, bytes);

  return value;
}

/**
 * Set value in cache with monitoring
 */
export async function setMonitoredCache<T>(
  key: string,
  value: T,
  options: CacheOptions = {},
): Promise<void> {
  const startTime = performance.now();

  const cacheService = getCacheService();
  await cacheService.set(key, value, options);
  const latency = performance.now() - startTime;

  // Estimate size
  const bytes = JSON.stringify(value).length;

  performanceMonitor.recordCacheOperation("set", true, latency, bytes);
}

/**
 * Invalidate cache entry with monitoring
 */
export async function invalidateMonitoredCache(
  key: string,
  options: CacheOptions = {},
): Promise<void> {
  const startTime = performance.now();

  const cacheService = getCacheService();
  await cacheService.invalidate(key, options);
  const latency = performance.now() - startTime;

  performanceMonitor.recordCacheOperation("delete", true, latency);
}
