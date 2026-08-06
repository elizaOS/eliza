/**
 * Owns the process-local app-by-id cache state shared by app readers and
 * mutation boundaries. Writers advance the hydration generation while
 * evicting so an in-flight authoritative read cannot republish stale data.
 */

import type { App } from "../../db/schemas/apps";
import { InMemoryLRUCache } from "./in-memory-lru-cache";

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

export function invalidateInferenceAppByIdState(appId: string): void {
  inferenceAppMemoryCache.delete(appId);
  appByIdHydrationGeneration.set(appId, getAppByIdHydrationGeneration(appId) + 1);
}
