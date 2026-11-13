/**
 * Loads and warms the Apps catalog by merging internal tools, server apps,
 * catalog entries, and overlay app registrations.
 */

import type { RegistryAppInfo } from "@elizaos/core/protocol";
import { writeAppsCache } from "./apps-cache";
import { loadMergedCatalogApps } from "./catalog-loader";
/**
 * Fetch the merged apps catalog used by the launcher catalog, hidden apps
 * included. Shares the merge with the chat surfaces so the AOSP-only gate and
 * per-source failure tolerance apply here too.
 */
export function loadAppsCatalog(): Promise<RegistryAppInfo[]> {
  return loadMergedCatalogApps({ includeHiddenApps: true });
}
/**
 * Fire-and-forget prefetch used at hydration so the Apps tab opens warm.
 * Errors are ignored here because the UI's own loadApps retries on mount.
 */
export async function prefetchAppsCatalog(): Promise<void> {
  try {
    const apps = await loadAppsCatalog();
    writeAppsCache(apps);
  } catch {
    // AppsView performs the visible load path on mount.
  }
}
