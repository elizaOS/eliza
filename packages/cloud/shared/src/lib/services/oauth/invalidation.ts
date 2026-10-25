/**
 * Shared OAuth state invalidation helper.
 *
 * Runs the full 4-step invalidation chain that must execute after
 * any OAuth credential write or delete so that cached runtimes,
 * entity settings, and edge runtime caches stay consistent.
 */

import { edgeRuntimeCache } from "../../cache/edge-runtime-cache";
import { invalidateOrganizationRuntimesFromRegistry } from "../../eliza/runtime-cache-registry";
import { logger } from "../../utils/logger";
import { entitySettingsCache } from "../entity-settings/cache";
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
