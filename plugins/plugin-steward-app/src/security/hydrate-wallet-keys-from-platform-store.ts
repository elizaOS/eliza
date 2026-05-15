import type { SecureStoreSecretKind } from "@elizaos/app-core";
import {
  createNodePlatformSecureStore,
  deriveAgentVaultId,
  isWalletOsStoreReadEnabled,
} from "@elizaos/app-core";
import { logger } from "@elizaos/core";

const WALLET_ENV_PAIRS: [keyof NodeJS.ProcessEnv, SecureStoreSecretKind][] = [
  ["EVM_PRIVATE_KEY", "wallet.evm_private_key"],
  ["SOLANA_PRIVATE_KEY", "wallet.solana_private_key"],
  ["STEWARD_API_URL", "steward.api_url"],
  ["STEWARD_AGENT_ID", "steward.agent_id"],
  ["STEWARD_AGENT_TOKEN", "steward.agent_token"],
];

/**
 * Fills `process.env` wallet keys from the OS secret store when the key is
 * unset/blank. Runs before upstream `startApiServer` merges `config.env`, so
 * persisted config only fills gaps the store did not supply.
 */
export async function hydrateWalletKeysFromNodePlatformSecureStore(): Promise<void> {
  if (!isWalletOsStoreReadEnabled()) {
    return;
  }

  try {
    const store = createNodePlatformSecureStore();
    if (!(await store.isAvailable())) {
      return;
    }

    const vaultId = deriveAgentVaultId();

    for (const [envKey, kind] of WALLET_ENV_PAIRS) {
      const cur = process.env[envKey];
      if (typeof cur === "string" && cur.trim()) {
        continue;
      }

      const got = await store.get(vaultId, kind);
      if (got.ok) {
        process.env[envKey] = got.value;
      }
    }
  } catch (err) {
    logger.warn(
      `[wallet][os-store] hydrate failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
