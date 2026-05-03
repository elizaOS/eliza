import { logger } from "@elizaos/core";

import { sharedVault } from "../services/vault-mirror";
import { deriveAgentVaultId } from "./agent-vault-id";
import type { SecureStoreSecretKind } from "./platform-secure-store";
import {
  createNodePlatformSecureStore,
  isWalletOsStoreReadEnabled,
} from "./platform-secure-store-node";

const WALLET_VAULT_KEYS: ReadonlyArray<keyof NodeJS.ProcessEnv> = [
  "EVM_PRIVATE_KEY",
  "SOLANA_PRIVATE_KEY",
];

/**
 * Steward-only env vars (non-wallet) that still ride the OS keystore. They
 * never moved into the unified vault because the steward backend has its
 * own auth model — leave them on the keystore-only path.
 */
const STEWARD_OS_PAIRS: ReadonlyArray<
  readonly [keyof NodeJS.ProcessEnv, SecureStoreSecretKind]
> = [
  ["STEWARD_API_URL", "steward.api_url"],
  ["STEWARD_AGENT_ID", "steward.agent_id"],
  ["STEWARD_AGENT_TOKEN", "steward.agent_token"],
];

/**
 * One-shot copy of legacy OS-keystore wallet keys into the shared vault.
 * Returns the env keys that were copied across so the caller can log /
 * surface a migration banner.
 */
async function migrateOsStoreWalletKeysIntoVault(
  envKeys: ReadonlyArray<keyof NodeJS.ProcessEnv>,
): Promise<string[]> {
  if (envKeys.length === 0) return [];
  if (!isWalletOsStoreReadEnabled()) return [];

  const store = createNodePlatformSecureStore();
  if (!(await store.isAvailable())) return [];

  const vault = sharedVault();
  const vaultId = deriveAgentVaultId();
  const keychainKindFor: Record<string, SecureStoreSecretKind> = {
    EVM_PRIVATE_KEY: "wallet.evm_private_key",
    SOLANA_PRIVATE_KEY: "wallet.solana_private_key",
  };
  const migrated: string[] = [];

  for (const envKey of envKeys) {
    const kind = keychainKindFor[envKey as string];
    if (!kind) continue;
    const got = await store.get(vaultId, kind);
    if (!got.ok) continue;
    process.env[envKey] = got.value;
    if (!(await vault.has(envKey as string))) {
      await vault.set(envKey as string, got.value, {
        sensitive: true,
        caller: "wallet-os-store-migrate",
      });
      migrated.push(String(envKey));
    }
  }

  return migrated;
}

/**
 * Fills `process.env` wallet keys from the shared vault (now the source
 * of truth). On first boot after the storage unification, copies any
 * legacy OS-keystore values into the vault and then proceeds normally.
 *
 * Steward env vars stay on the OS-keystore path — the steward backend's
 * lifecycle is independent of the unified wallet vault.
 *
 * Runs before upstream `startApiServer` merges `config.env`, so persisted
 * config only fills gaps that neither vault nor OS keystore supplies.
 */
export async function hydrateWalletKeysFromNodePlatformSecureStore(): Promise<void> {
  // ── 1. Vault read for wallet keys ────────────────────────────────
  const vault = sharedVault();
  const missingWalletKeys: Array<keyof NodeJS.ProcessEnv> = [];
  for (const envKey of WALLET_VAULT_KEYS) {
    const cur = process.env[envKey];
    if (typeof cur === "string" && cur.trim()) continue;
    if (await vault.has(envKey as string)) {
      const value = await vault.reveal(envKey as string, "wallet-hydrate-boot");
      process.env[envKey] = value;
      continue;
    }
    missingWalletKeys.push(envKey);
  }

  // ── 2. One-shot migration from OS keystore for any wallet keys
  //      that the vault did not have. ──────────────────────────────
  if (missingWalletKeys.length > 0) {
    try {
      const migrated =
        await migrateOsStoreWalletKeysIntoVault(missingWalletKeys);
      if (migrated.length > 0) {
        logger.info(
          `[wallet][vault] migrated ${migrated.length} key(s) from OS keystore: ${migrated.join(", ")}`,
        );
      }
    } catch (err) {
      logger.warn(
        `[wallet][vault] os-store migration failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // ── 3. Steward OS-keystore reads (unchanged) ─────────────────────
  if (!isWalletOsStoreReadEnabled()) return;
  try {
    const store = createNodePlatformSecureStore();
    if (!(await store.isAvailable())) return;
    const vaultId = deriveAgentVaultId();
    for (const [envKey, kind] of STEWARD_OS_PAIRS) {
      const cur = process.env[envKey];
      if (typeof cur === "string" && cur.trim()) continue;
      const got = await store.get(vaultId, kind);
      if (got.ok) process.env[envKey] = got.value;
    }
  } catch (err) {
    logger.warn(
      `[wallet][os-store] steward hydrate failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
