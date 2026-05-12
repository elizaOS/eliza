/**
 * Shared OAuth state invalidation helper.
 *
 * Runs the full 4-step invalidation chain that must execute after
 * any OAuth credential write or delete so that cached runtimes,
 * entity settings, and edge runtime caches stay consistent.
 */

import { edgeRuntimeCache } from "@/lib/cache/edge-runtime-cache";
import { invalidateOrganizationRuntimesFromRegistry } from "@/lib/eliza/runtime-cache-registry";
import { entitySettingsCache } from "@/lib/services/entity-settings/cache";
import { logger } from "@/lib/utils/logger";
import { incrementOAuthVersion } from "./cache-version";

export async function invalidateOAuthState(
  orgId: string,
  platform: string,
  userId?: string,
  opts?: { skipVersionBump?: boolean },
): Promise<void> {
  const results = await Promise.allSettled([
    opts?.skipVersionBump ? Promise.resolve() : incrementOAuthVersion(orgId, platform),
    invalidateOrganizationRuntimesFromRegistry(orgId),
    userId ? entitySettingsCache.invalidateUser(userId) : Promise.resolve(),
    edgeRuntimeCache.bumpMcpVersion(orgId),
  ]);

  for (const result of results) {
    if (result.status === "rejected") {
      logger.warn("[OAuth] Invalidation chain partially failed", {
        orgId,
        platform,
        error: result.reason instanceof Error ? result.reason.message : String(result.reason),
      });
    }
  }
}
