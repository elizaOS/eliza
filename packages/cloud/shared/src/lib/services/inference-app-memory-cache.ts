/**
 * Worker-lifetime memory cache for inference app rows, shared between the
 * apps service (reads) and the apps repository (eviction on mutation). Lives
 * in its own module so the repository can evict without importing the service
 * layer, which itself imports the repository.
 *
 * The hydration generation lives here too, alongside the cache it guards. An
 * authoritative read samples it before its DB round trip and re-checks it
 * afterwards, so any invalidation that raced the read is visible and the read
 * declines to publish its now-stale row. Splitting the two — evicting here
 * while the counter lived in the service — let the repository path evict
 * without advancing the generation, which is the failure this module exists
 * to make unrepresentable.
 */
import type { App } from "../../db/repositories/apps";
import { InMemoryLRUCache } from "../cache/in-memory-lru-cache";

export const inferenceAppMemoryCache = new InMemoryLRUCache<App>(100, 30_000);

const appByIdHydrationGeneration = new Map<string, number>();

/** The current hydration generation for an app, 0 before any invalidation. */
export function getInferenceAppCacheGeneration(appId: string): number {
  return appByIdHydrationGeneration.get(appId) ?? 0;
}

/**
 * Invalidate one app's worker-lifetime state after a persisting mutation.
 *
 * Deletes the memory entry AND advances the hydration generation. Both halves
 * are required: the delete stops a same-worker read from returning the
 * pre-mutation row for up to the cache TTL, and the generation bump stops an
 * authoritative read that started BEFORE this call from republishing that same
 * row into the shared cache after it — where every worker would then read it
 * for the full shared TTL.
 */
export function evictInferenceAppMemoryCache(appId: string): void {
  inferenceAppMemoryCache.delete(appId);
  appByIdHydrationGeneration.set(appId, getInferenceAppCacheGeneration(appId) + 1);
}
