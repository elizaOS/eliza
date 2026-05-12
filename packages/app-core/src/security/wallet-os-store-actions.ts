/**
 * Wallet-key migration helpers for `EVM_PRIVATE_KEY` / `SOLANA_PRIVATE_KEY`.
 *
 * Storage layout (post-unification):
 *   - The shared vault is the source of truth. Keys are written at the
 *     bare `EVM_PRIVATE_KEY` / `SOLANA_PRIVATE_KEY` slots so the existing
 *     inventory categorizer (`categorizeKey`) surfaces them under
 *     Settings → Vault → Secrets in the "Wallet" group automatically.
 *   - The OS keystore (Keychain / libsecret) remains a one-shot read
 *     source for migrating off the legacy split-storage layout. We never
 *     write back into it from this module.
 *
 * Hydration (see `hydrate-wallet-keys-from-platform-store.ts`) reads the
 * vault first and copies the OS-keystore value across on the next boot
 * when the OS-keystore read path is enabled (default on supported desktops,
 * or explicitly via `ELIZA_WALLET_OS_STORE=1`).
 */

import { loadElizaConfig, saveElizaConfig } from "@elizaos/agent";
import { setEntryMeta } from "@elizaos/vault";
import { sharedVault } from "../services/vault-mirror";
import { deriveAgentVaultId } from "./agent-vault-id";
import type { SecureStoreSecretKind } from "./platform-secure-store";
import {
  createNodePlatformSecureStore,
  isWalletOsStoreReadEnabled,
} from "./platform-secure-store-node";

const WALLET_PAIRS: ReadonlyArray<readonly [string, SecureStoreSecretKind]> = [
  ["EVM_PRIVATE_KEY", "wallet.evm_private_key"],
  ["SOLANA_PRIVATE_KEY", "wallet.solana_private_key"],
];

/**
 * Remove main wallet keys from BOTH the vault and the OS keystore.
 * Used by `POST /api/agent/reset` and the equivalent CLI flow.
 */
export async function deleteWalletSecretsFromOsStore(): Promise<void> {
  const vault = sharedVault();
  for (const [envKey] of WALLET_PAIRS) {
    if (await vault.has(envKey)) {
      await vault.remove(envKey);
    }
  }

  // Best-effort cleanup of the legacy OS keystore copy. We only attempt
  // this when the user previously opted into the OS-keystore read path —
  // otherwise the keystore was never written from this module.
  if (!isWalletOsStoreReadEnabled()) {
    return;
  }
  const store = createNodePlatformSecureStore();
  if (!(await store.isAvailable())) {
    return;
  }
  const vaultId = deriveAgentVaultId();
  await store.delete(vaultId, "wallet.evm_private_key");
  await store.delete(vaultId, "wallet.solana_private_key");
}

export type MigrateWalletPrivateKeysToOsStoreResult = {
  migrated: string[];
  failed: string[];
  /** Reserved for compat — vault writes are always available. Always undefined now. */
  unavailable?: boolean;
};

/**
 * Copies wallet keys from `process.env` and/or persisted `config.env` into
 * the shared vault, strips them from saved config, and ensures
 * `process.env` holds the values for the running process.
 *
 * Idempotent: if the vault already holds a key, the env value (if any)
 * is left in place but not re-written to the vault.
 */
export async function migrateWalletPrivateKeysToOsStore(): Promise<MigrateWalletPrivateKeysToOsStoreResult> {
  const vault = sharedVault();
  const migrated: string[] = [];
  const failed: string[] = [];

  const config = loadElizaConfig();
  const persisted =
    config.env && typeof config.env === "object" && !Array.isArray(config.env)
      ? (config.env as Record<string, unknown>)
      : {};

  for (const [envKey] of WALLET_PAIRS) {
    const fromProcess =
      typeof process.env[envKey] === "string"
        ? process.env[envKey]?.trim()
        : "";
    const fromConfig =
      typeof persisted[envKey] === "string"
        ? String(persisted[envKey]).trim()
        : "";
    const value = fromProcess || fromConfig;
    if (!value) {
      continue;
    }

    if (await vault.has(envKey)) {
      // Already migrated — don't overwrite a vault entry that may have
      // been rotated since.
      continue;
    }

    try {
      await vault.set(envKey, value, {
        sensitive: true,
        caller: "wallet-migrate",
      });
      migrated.push(envKey);
    } catch (err) {
      failed.push(envKey);
      throw err instanceof Error
        ? err
        : new Error(`vault write failed for ${envKey}: ${String(err)}`);
    }

    if (!fromProcess) {
      process.env[envKey] = value;
    }
  }

  let dirty = false;
  const nextEnv = { ...persisted };
  for (const [envKey] of WALLET_PAIRS) {
    if (typeof nextEnv[envKey] === "string") {
      delete nextEnv[envKey];
      dirty = true;
    }
  }

  if (dirty) {
    if (Object.keys(nextEnv).length === 0) {
      delete config.env;
    } else {
      config.env = nextEnv as typeof config.env;
    }
    saveElizaConfig(config);
  }

  return { migrated, failed };
}

/**
 * Re-export for callers that want to write the wallet metadata explicitly
 * (currently unused by external code; the inventory categorizer already
 * recognizes `EVM_PRIVATE_KEY` / `SOLANA_PRIVATE_KEY` via heuristic).
 */
export { setEntryMeta };
