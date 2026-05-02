/**
 * Per-agent vault profile resolver.
 *
 * Walks every vault entry that has profile metadata, asks the vault's
 * routing layer which profile applies for the current agent, and pumps
 * the resolved value into `process.env[KEY]`. Runtime hot paths read
 * env vars synchronously (`process.env.OPENROUTER_API_KEY`, etc.), so
 * we resolve once at agent boot rather than instrumenting every call
 * site.
 *
 * Scope: this is the minimum-viable wiring per the spec —
 *   - Only `agent` scope rules apply; the runtime knows agentId.
 *   - `app` and `skill` scope rules are persisted but not yet
 *     resolved here (no call site has the context).
 *
 * Idempotent: re-running for the same agent overwrites with the same
 * value. Opt-out via `ELIZA_DISABLE_VAULT_PROFILE_RESOLVER=1`.
 */

import { logger } from "@elizaos/core";
import {
  listVaultInventory,
  resolveActiveValue,
  type Vault,
  type VaultEntryMeta,
} from "@elizaos/vault";

export interface ResolveProfilesResult {
  /** Number of keys whose env value was overridden. */
  readonly overridden: number;
  /** Keys that had profiles but every candidate profile was empty. */
  readonly skipped: ReadonlyArray<string>;
  /** Keys where resolution failed (vault read error). */
  readonly failed: ReadonlyArray<string>;
}

/**
 * For each inventory entry that has `hasProfiles === true`, resolve
 * the active value for `agentId` and write it into `process.env[KEY]`.
 *
 * Keys without profiles are left alone — `process.env` already holds
 * whatever the legacy hydration path put there (config.env, eliza.json,
 * direct env). This resolver is purely additive.
 */
export async function applyVaultProfilesForAgent(
  vault: Vault,
  agentId: string,
): Promise<ResolveProfilesResult> {
  if (process.env.ELIZA_DISABLE_VAULT_PROFILE_RESOLVER === "1") {
    return { overridden: 0, skipped: [], failed: [] };
  }

  let entries: readonly VaultEntryMeta[];
  try {
    entries = await listVaultInventory(vault);
  } catch (err) {
    logger.warn(
      `[vault-profile-resolver] inventory listing failed for agent="${agentId}": ${err instanceof Error ? err.message : String(err)}`,
    );
    return { overridden: 0, skipped: [], failed: [] };
  }

  let overridden = 0;
  const skipped: string[] = [];
  const failed: string[] = [];

  for (const entry of entries) {
    if (!entry.hasProfiles) continue;
    if (entry.kind === "reference") {
      // Reference entries resolve through their backing password
      // manager, not through profiles. Skip — but only after auditing
      // we'd actually have a profile blob to read.
      continue;
    }
    try {
      const value = await resolveActiveValue(vault, entry.key, { agentId });
      if (typeof value !== "string" || value.length === 0) {
        skipped.push(entry.key);
        continue;
      }
      process.env[entry.key] = value;
      overridden += 1;
    } catch (err) {
      // resolveActiveValue throws when no profile and no bare value
      // resolves. Don't try to fall back to legacy env — the user
      // explicitly declared profiles for this key, so an unresolvable
      // active profile is a real failure they should see.
      failed.push(entry.key);
      logger.warn(
        `[vault-profile-resolver] failed to resolve agent="${agentId}" key="${entry.key}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  if (overridden > 0 || failed.length > 0) {
    logger.info(
      `[vault-profile-resolver] agent="${agentId}" overridden=${overridden} skipped=${skipped.length} failed=${failed.length}`,
    );
  }

  return {
    overridden,
    skipped: Object.freeze(skipped),
    failed: Object.freeze(failed),
  };
}
