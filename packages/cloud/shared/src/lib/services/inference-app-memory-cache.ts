/**
 * Worker-lifetime state for inference app reads, shared between the apps
 * service and repository mutation boundary. Cache eviction and hydration
 * generations move together so an in-flight read cannot republish a row that
 * a concurrent mutation already invalidated.
 */
import type { App } from "../../db/repositories/apps";
import { InMemoryLRUCache } from "../cache/in-memory-lru-cache";

const inferenceAppMemoryCache = new InMemoryLRUCache<App>(100, 30_000);
const appByIdHydrationGeneration = new Map<string, number>();

export function getInferenceAppById(appId: string): App | null {
  return inferenceAppMemoryCache.get(appId);
}

export function setInferenceAppById(appId: string, app: App): void {
  inferenceAppMemoryCache.set(appId, app);
}

export function getAppByIdHydrationGeneration(appId: string): number {
  return appByIdHydrationGeneration.get(appId) ?? 0;
}

/**
 * Invalidates the memory cache and any authoritative read already in flight.
 * Callers must use this single boundary rather than deleting the LRU directly;
 * the generation bump prevents an older read from restoring stale state.
 */
export function invalidateInferenceAppByIdState(appId: string): void {
  inferenceAppMemoryCache.delete(appId);
  appByIdHydrationGeneration.set(appId, getAppByIdHydrationGeneration(appId) + 1);
}
