import { loadElizaConfig, saveElizaConfig } from "@elizaos/agent/config/config";
import { deriveAgentVaultId } from "@elizaos/app-core";
import type { SecureStoreSecretKind } from "@elizaos/app-core";
import { createNodePlatformSecureStore } from "@elizaos/app-core";

const WALLET_PAIRS: [string, SecureStoreSecretKind][] = [
  ["EVM_PRIVATE_KEY", "wallet.evm_private_key"],
  ["SOLANA_PRIVATE_KEY", "wallet.solana_private_key"],
];

export async function deleteWalletSecretsFromOsStore(): Promise<void> {
  const store = createNodePlatformSecureStore();
  const vaultId = deriveAgentVaultId();
  await store.delete(vaultId, "wallet.evm_private_key");
  await store.delete(vaultId, "wallet.solana_private_key");
}

export type MigrateWalletPrivateKeysToOsStoreResult = {
  migrated: string[];
  failed: string[];
  /** True when the backend cannot run on this host (e.g. Linux without secret-tool). */
  unavailable?: boolean;
};

/**
 * Copies wallet keys from `process.env` and/or persisted `config.env` into the
 * OS store, strips them from saved config, and ensures `process.env` holds the
 * values for the running process.
 */
export async function migrateWalletPrivateKeysToOsStore(): Promise<MigrateWalletPrivateKeysToOsStoreResult> {
  const store = createNodePlatformSecureStore();
  const migrated: string[] = [];
  const failed: string[] = [];

  if (!(await store.isAvailable())) {
    return { migrated, failed: [], unavailable: true };
  }

  const vaultId = deriveAgentVaultId();
  const config = loadElizaConfig();
  const persisted =
    config.env && typeof config.env === "object" && !Array.isArray(config.env)
      ? (config.env as Record<string, unknown>)
      : {};

  for (const [envKey, kind] of WALLET_PAIRS) {
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

    const r = await store.set(vaultId, kind, value);
    if (!r.ok) {
      failed.push(envKey);
      continue;
    }

    migrated.push(envKey);
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
