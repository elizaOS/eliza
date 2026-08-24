/**
 * Coordinates wallet-key publication between the durable host vault and the
 * sanitized agent config. OS-store mode writes both private keys to the vault
 * before config publication, compensates only when the old config is proven
 * authoritative, and never blind-rolls back an uncertain/published commit.
 */
import { ElizaError } from "@elizaos/core";
import type { Vault } from "@elizaos/vault";
import type { ElizaConfig, ElizaConfigCommitResult } from "../config/config.ts";
import type { WalletKeyProvisionResult } from "./server-helpers-config.ts";

const WALLET_PRIVATE_KEYS = ["EVM_PRIVATE_KEY", "SOLANA_PRIVATE_KEY"] as const;

type WalletPrivateKey = (typeof WALLET_PRIVATE_KEYS)[number];
type ProvisionedWallet = Extract<WalletKeyProvisionResult, { ok: true }>;

interface PreviousVaultValue {
  key: WalletPrivateKey;
  value: string | null;
}

export interface WalletKeyPersistenceTransaction {
  readonly stagedVault: boolean;
  commitConfig: (
    config: ElizaConfig,
    commit: (config: ElizaConfig) => ElizaConfigCommitResult,
  ) => Promise<ElizaConfigCommitResult>;
  compensate: () => Promise<void>;
}

/** Whether config serialization delegates wallet private keys to the vault. */
export function isWalletOsStoreEnabled(config: ElizaConfig): boolean {
  const value = (config.env as Record<string, unknown> | undefined)
    ?.ELIZA_WALLET_OS_STORE;
  return (
    typeof value === "string" &&
    ["1", "true", "on", "yes"].includes(value.trim().toLowerCase())
  );
}

/**
 * Hydrate missing planned wallet keys from the durable vault before deciding
 * whether startup must generate new credentials. Explicit launch env wins.
 */
export async function hydrateWalletKeysFromVault(
  config: ElizaConfig,
  environment: NodeJS.ProcessEnv,
  vault: Vault | null,
): Promise<void> {
  if (!isWalletOsStoreEnabled(config)) return;
  if (!vault) throw new Error("Durable wallet vault is unavailable");

  for (const key of WALLET_PRIVATE_KEYS) {
    if (environment[key]?.trim()) continue;
    if (!(await vault.has(key))) continue;
    const value = await vault.reveal(key, "wallet-startup-hydrate");
    if (!value.trim()) throw new Error(`Durable wallet key ${key} is blank`);
    environment[key] = value;
  }
}

/** Stage wallet keys in the durable vault and bind compensation to commit state. */
export async function beginWalletKeyPersistence(
  config: ElizaConfig,
  wallet: ProvisionedWallet,
  vault: Vault | null,
  caller: string,
): Promise<WalletKeyPersistenceTransaction> {
  if (!isWalletOsStoreEnabled(config)) {
    return {
      stagedVault: false,
      commitConfig: async (stagedConfig, commit) => commit(stagedConfig),
      compensate: async () => undefined,
    };
  }
  if (!vault) throw new Error("Durable wallet vault is unavailable");

  const values: Record<WalletPrivateKey, string> = {
    EVM_PRIVATE_KEY: wallet.evmPrivateKey,
    SOLANA_PRIVATE_KEY: wallet.solanaPrivateKey,
  };
  const previous: PreviousVaultValue[] = [];
  let commitStatus: ElizaConfigCommitResult["status"] | null = null;
  let compensated = false;

  const compensate = async (): Promise<void> => {
    if (
      compensated ||
      commitStatus === "published" ||
      commitStatus === "uncertain"
    ) {
      return;
    }
    try {
      for (const entry of [...previous].reverse()) {
        if (entry.value === null) await vault.remove(entry.key);
        else {
          await vault.set(entry.key, entry.value, {
            sensitive: true,
            caller: `${caller}-rollback`,
          });
        }
      }
    } catch (cause) {
      // error-policy:J2 retain a retryable transaction while adding the vault
      // keys and commit state needed to diagnose incomplete compensation.
      throw new ElizaError("Wallet key vault compensation failed", {
        code: "WALLET_KEY_VAULT_COMPENSATION_FAILED",
        cause,
        context: {
          caller,
          commitStatus: commitStatus ?? "staging",
          stagedKeys: previous.map((entry) => entry.key),
        },
        severity: "fatal",
      });
    }
    compensated = true;
  };

  try {
    for (const key of WALLET_PRIVATE_KEYS) {
      const hadValue = await vault.has(key);
      previous.push({
        key,
        value: hadValue ? await vault.reveal(key, caller) : null,
      });
      await vault.set(key, values[key], { sensitive: true, caller });
    }
  } catch (cause) {
    // error-policy:J2 a staging failure is rethrown with stable classification;
    // a failed compensation preserves both errors for the outer boundary.
    try {
      await compensate();
    } catch (rollbackCause) {
      // error-policy:J2 the aggregate cause retains both the primary vault
      // write failure and the separately classified rollback failure.
      throw new ElizaError(
        "Wallet key staging failed and vault compensation was incomplete",
        {
          code: "WALLET_KEY_STAGING_COMPENSATION_FAILED",
          cause: new AggregateError(
            [cause, rollbackCause],
            "Wallet key staging and compensation both failed",
          ),
          context: {
            caller,
            stagedKeys: previous.map((entry) => entry.key),
          },
          severity: "fatal",
        },
      );
    }
    throw new ElizaError("Wallet key staging failed", {
      code: "WALLET_KEY_STAGING_FAILED",
      cause,
      context: {
        caller,
        stagedKeys: previous.map((entry) => entry.key),
      },
      severity: "fatal",
    });
  }

  return {
    stagedVault: true,
    commitConfig: async (stagedConfig, commit) => {
      const result = commit(stagedConfig);
      commitStatus = result.status;
      if (result.status === "not-published") {
        try {
          await compensate();
        } catch (rollbackCause) {
          // error-policy:J2 preserve the config commit cause and the retryable
          // vault compensation failure in one structured transaction error.
          throw new ElizaError(
            "Unpublished wallet config could not be compensated",
            {
              code: "WALLET_KEY_COMMIT_COMPENSATION_FAILED",
              cause: new AggregateError(
                [result.cause, rollbackCause],
                "Wallet config commit and vault compensation both failed",
              ),
              context: {
                caller,
                commitStatus: result.status,
                stagedKeys: previous.map((entry) => entry.key),
              },
              severity: "fatal",
            },
          );
        }
      }
      return result;
    },
    compensate,
  };
}
