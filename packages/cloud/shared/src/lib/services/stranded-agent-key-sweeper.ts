/** Reaps unusable sandbox credentials and invalidates caches for rows actually removed. */
import { strandedAgentKeyRepository } from "../../db/repositories/stranded-agent-keys";
import { logger } from "../utils/logger";
import { apiKeysService } from "./api-keys";
import {
  revokeInferenceApiKey,
  settlePostCommitRevocations,
} from "./inference-credential-revocation";

/** Returns the number of database rows atomically revoked before the cutoff. */
export async function sweepStrandedAgentKeys(olderThan: Date): Promise<number> {
  const stranded = await strandedAgentKeyRepository.deleteOlderThan(olderThan);

  const failures = await settlePostCommitRevocations(stranded, (key) => [
    revokeInferenceApiKey(key.organization_id, key.id),
    apiKeysService.invalidateCache(key.key_hash),
  ]);
  // error-policy:J6 The database revocation is complete; cache TTL bounds stale access.
  for (const { item, reasons } of failures) {
    logger.error("[ApiKeys] Stranded-key revocation was not confirmed", {
      apiKeyId: item.id,
      error: reasons.map(String).join("; "),
    });
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
