/**
 * Provision-time injection of pooled credentials (#11332).
 *
 * Called on the dedicated-container bootstrap path right after the agent's
 * own environment_vars are decrypted: for each pooled provider whose env key
 * the agent does NOT already carry, select a credential from the org pool and
 * merge the raw key into the in-memory bootstrap env. The bootstrap payload
 * flows through `buildRuntimeBootstrapAgent` into character
 * `settings.secrets` — pooled keys are NEVER persisted into the stored
 * `environment_vars` (they exist only in the create-request payload).
 *
 * Strict fallback: any failure returns the env unchanged (today's behavior).
 * An explicit per-agent key always wins over the pool.
 */

import { logger } from "../../utils/logger";
import { POOLED_DIRECT_PROVIDERS, POOLED_PROVIDER_ENV_KEYS } from "./provider-map";
import { getTeamPoolRegistry } from "./registry";

export interface ApplyPooledCredentialsParams {
  organizationId: string;
  /** Member the workload is attributed to (sandbox owner). */
  userId: string | null | undefined;
  /** Affinity key so restarts of the same agent keep the same credential. */
  sessionKey: string;
  env: Record<string, string>;
}

export async function applyPooledCredentialsToBootstrapEnv(
  params: ApplyPooledCredentialsParams,
): Promise<Record<string, string>> {
  try {
    const registry = getTeamPoolRegistry();
    const merged = { ...params.env };
    let applied = 0;
    for (const providerId of POOLED_DIRECT_PROVIDERS) {
      const envKey = POOLED_PROVIDER_ENV_KEYS[providerId];
      if (merged[envKey]?.trim()) continue; // per-agent key wins
      const selected = await registry.selectCredential({
        organizationId: params.organizationId,
        providerId,
        sessionKey: params.sessionKey,
      });
      if (!selected) continue;
      merged[envKey] = selected.apiKey;
      applied += 1;
      if (params.userId) {
        await registry.recordUse({
          organizationId: params.organizationId,
          credentialId: selected.credentialId,
          userId: params.userId,
        });
      }
    }
    if (applied > 0) {
      logger.info("[TeamCredentialPool] merged pooled credentials into bootstrap env", {
        organizationId: params.organizationId,
        applied,
      });
    }
    return merged;
  } catch (err) {
    logger.warn("[TeamCredentialPool] pooled-credential merge failed — using agent env as-is", {
      organizationId: params.organizationId,
      error: err instanceof Error ? err.message : String(err),
    });
    return params.env;
  }
}
