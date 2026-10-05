import { ElizaError } from "@elizaos/core";
import type { ElizaConfig } from "@elizaos/host/protocol";
import { isWalletOsStoreEnabledInConfig } from "../config/config.ts";
import {
  getAgentHostBridge,
  hasDurableHostVault,
} from "../runtime/host-bridge.ts";

export type WalletPrivateKeyName = "EVM_PRIVATE_KEY" | "SOLANA_PRIVATE_KEY";

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
