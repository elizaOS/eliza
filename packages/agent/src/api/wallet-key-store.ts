import { ElizaError } from "@elizaos/core";
import type { ElizaConfig } from "@elizaos/host/protocol";
import { isWalletOsStoreEnabledInConfig } from "../config/config.ts";
import {
  getAgentHostBridge,
  hasDurableHostVault,
} from "../runtime/host-bridge.ts";
import { setSolanaWalletEnv } from "./wallet-keygen.ts";

export type WalletPrivateKeyName = "EVM_PRIVATE_KEY" | "SOLANA_PRIVATE_KEY";

const WALLET_PRIVATE_KEY_NAMES: readonly WalletPrivateKeyName[] = [
  "EVM_PRIVATE_KEY",
  "SOLANA_PRIVATE_KEY",
];

/**
 * Stores wallet private keys in the host vault when OS-store mode keeps them
 * out of the on-disk config (boot hydration reads them back from the vault).
 * All-or-nothing: on any failure the prior vault entries are restored.
 */
export async function persistWalletPrivateKeys(
  config: ElizaConfig,
  keys: Partial<Record<WalletPrivateKeyName, string>>,
  caller: string,
): Promise<void> {
  if (!isWalletOsStoreEnabledInConfig(config)) return;
  const entries = Object.entries(keys);
  if (entries.length === 0) return;
  if (!hasDurableHostVault()) {
    throw new ElizaError(
      `${entries.map(([key]) => key).join(", ")} cannot be stored: ELIZA_WALLET_OS_STORE keeps wallet keys out of config and this host has no durable vault`,
      { code: "WALLET_KEY_STORE_UNAVAILABLE" },
    );
  }
  const empty = entries.find(([, value]) => !value?.trim());
  if (empty) {
    throw new ElizaError(`${empty[0]} is empty`, {
      code: "WALLET_KEY_EMPTY",
    });
  }
  const vault = getAgentHostBridge().sharedVault();
  const options = { sensitive: true, caller };
  const previous: Array<[string, string | null]> = [];
  for (const [key] of entries) {
    previous.push([
      key,
      (await vault.has(key)) ? await vault.reveal(key, caller) : null,
    ]);
  }
  try {
    for (const [key, value] of entries) {
      await vault.set(key, value as string, options);
    }
  } catch (err) {
    const rollbackFailures: unknown[] = [];
    for (const [key, value] of previous) {
      try {
        if (value === null) await vault.remove(key);
        else await vault.set(key, value, options);
      } catch (rollbackError) {
        rollbackFailures.push(rollbackError);
      }
    }
    if (rollbackFailures.length > 0) {
      throw new AggregateError(
        [err, ...rollbackFailures],
        "Wallet key store failed and prior vault keys could not be restored",
      );
    }
    throw err;
  }
}

/**
 * Restores wallet private keys the durable vault already holds into blank env
 * slots before any provisioning decision. In OS-store mode the vault is the
 * only durable copy (config saves strip plaintext keys) and the boot-time
 * vault→env hydrate runs only after the API listener is live, so a first-run
 * wallet request or boot auto-provision that arrives earlier would otherwise
 * see blank env vars, treat the stored — possibly funded — wallet as missing,
 * and overwrite it with freshly generated keys. Only blank env slots are
 * filled, preserving the documented precedence (launch env > vault). Returns
 * true when at least one key was restored.
 */
export async function restoreWalletPrivateKeysFromVault(
  config: ElizaConfig,
): Promise<boolean> {
  if (!isWalletOsStoreEnabledInConfig(config)) return false;
  if (!hasDurableHostVault()) return false;
  const vault = getAgentHostBridge().sharedVault();
  const caller = "wallet-provision";
  let restored = false;
  for (const key of WALLET_PRIVATE_KEY_NAMES) {
    if (process.env[key]?.trim()) continue;
    let value: string | null = null;
    try {
      value = (await vault.has(key)) ? await vault.reveal(key, caller) : null;
    } catch (err) {
      // Fail closed: without proving the vault has no wallet key, generating a
      // replacement could destroy the stored wallet.
      throw new ElizaError(
        `${key} could not be read from the durable vault before wallet provisioning; refusing to generate a replacement that could overwrite the stored wallet`,
        {
          code: "WALLET_KEY_RESTORE_FAILED",
          context: { key },
          cause: err,
        },
      );
    }
    if (value === null || !value.trim()) continue;
    if (key === "EVM_PRIVATE_KEY") {
      process.env.EVM_PRIVATE_KEY = value.trim();
    } else {
      setSolanaWalletEnv(value.trim());
    }
    restored = true;
  }
  return restored;
}
