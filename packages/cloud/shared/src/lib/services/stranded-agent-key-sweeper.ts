/** Reaps unusable sandbox credentials and invalidates caches for rows actually removed. */
import { strandedAgentKeyRepository } from "../../db/repositories/stranded-agent-keys";
import { logger } from "../utils/logger";
import { apiKeysService } from "./api-keys";

/** Returns the number of database rows atomically revoked before the cutoff. */
export async function sweepStrandedAgentKeys(olderThan: Date): Promise<number> {
  const stranded = await strandedAgentKeyRepository.deleteOlderThan(olderThan);

  for (const key of stranded) {
    try {
      await apiKeysService.invalidateCache(key.key_hash);
    } catch (error) {
      // error-policy:J6 The database revocation is complete; cache TTL bounds stale access.
      logger.error("[ApiKeys] Stranded-key cache invalidation was not confirmed", {
        apiKeyId: key.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (stranded.length > 0) {
    logger.warn("[ApiKeys] Swept stranded agent-sandbox keys", {
      revoked: stranded.length,
      olderThan: olderThan.toISOString(),
    });
  }
  return stranded.length;
}

/** Injectable route boundary retained as an object so cron wiring tests can spy without module mocks. */
export const strandedAgentKeySweeper = { sweep: sweepStrandedAgentKeys };
