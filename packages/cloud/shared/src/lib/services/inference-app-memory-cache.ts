/**
 * Worker-lifetime memory cache for inference app rows, shared between the
 * apps service (reads) and the apps repository (eviction on mutation). Lives
 * in its own module so the repository can evict without importing the service
 * layer, which itself imports the repository.
 */
import type { App } from "../../db/repositories/apps";
import { InMemoryLRUCache } from "../cache/in-memory-lru-cache";

export const inferenceAppMemoryCache = new InMemoryLRUCache<App>(100, 30_000);

/**
 * Evict one app from the worker-lifetime memory cache. Called by the apps
 * repository after every persisting mutation so a same-worker read cannot
 * return the pre-mutation row for up to the cache TTL — the shared-cache
 * eviction alone cannot reach this layer.
 */
export function evictInferenceAppMemoryCache(appId: string): void {
  inferenceAppMemoryCache.delete(appId);
}
