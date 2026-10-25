/**
 * Owns process-local app inference cache state shared by repository mutations and service reads.
 * Hydration generations prevent an in-flight database read from restoring an invalidated entry.
 */

import type { App } from "../../db/repositories/apps";
import { InMemoryLRUCache } from "./in-memory-lru-cache";

const inferenceAppMemoryCache = new InMemoryLRUCache<App>(100, 30_000);
const appByIdHydrationGeneration = new Map<string, number>();

export function getInferenceApp(appId: string): App | null {
  return inferenceAppMemoryCache.get(appId);
}

export function setInferenceApp(appId: string, app: App): void {
  inferenceAppMemoryCache.set(appId, app);
}

export function getAppHydrationGeneration(appId: string): number {
  return appByIdHydrationGeneration.get(appId) ?? 0;
}

export function invalidateInferenceApp(appId: string): void {
  inferenceAppMemoryCache.delete(appId);
  appByIdHydrationGeneration.set(appId, getAppHydrationGeneration(appId) + 1);
}
