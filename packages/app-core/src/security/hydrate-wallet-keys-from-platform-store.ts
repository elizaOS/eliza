/**
 * Boot-time hydration of wallet (and steward) secrets into `process.env`.
 * Wallet keys are read from the shared vault (now the source of truth), with a
 * one-shot migration of any legacy values still only in the OS keystore;
 * steward env vars stay on the OS-keystore path because that backend's
 * lifecycle is independent of the unified vault.
 *
 * Precedence contract: launch env > vault/OS-keystore > persisted config.
 * app-core's `startApiServer` still calls this before it merges `config.env`,
 * where the contract holds by ordering alone; the agent boot path instead
 * defers the hydrate to the post-ready wave and captures a pre-merge baseline
 * (`captureWalletEnvBootBaseline`) so the same precedence holds there too.
 */
import { logger } from "@elizaos/core";

import { sharedVault } from "../services/vault-mirror";
import { deriveAgentVaultId } from "./agent-vault-id";
import type { SecureStoreSecretKind } from "./platform-secure-store";
import {
  createNodePlatformSecureStore,
  isWalletOsStoreReadEnabled,
} from "./platform-secure-store-node";

// TDZ-hardening (see also packages/app-core/src/services/vault-mirror.ts).
// These module-top `const` literals are referenced inside async functions
// that run on the boot path. If a circular import (e.g. vault-bootstrap →
// agent → app-core → … → this module) re-enters those functions before this
// file's top-level initializers complete, Bun's strict ESM throws
// `Cannot access 'WALLET_VAULT_KEYS' before initialization`. Wrapping the
// arrays in functions makes them callable regardless of init order — the
// array literal builds when the getter is invoked, not at module top.
function walletVaultKeys(): ReadonlyArray<keyof NodeJS.ProcessEnv> {
  return ["EVM_PRIVATE_KEY", "SOLANA_PRIVATE_KEY"];
}

/**
 * Steward-only env vars (non-wallet) that still ride the OS keystore. They
 * never moved into the unified vault because the steward backend has its
 * own auth model — leave them on the keystore-only path.
 */
function stewardOsPairs(): ReadonlyArray<
  readonly [keyof NodeJS.ProcessEnv, SecureStoreSecretKind]
> {
  return [
    ["STEWARD_API_URL", "steward.api_url"],
    ["STEWARD_TENANT_ID", "steward.tenant_id"],
    ["STEWARD_AGENT_ID", "steward.agent_id"],
    ["STEWARD_API_KEY", "steward.api_key"],
    ["STEWARD_AGENT_TOKEN", "steward.agent_token"],
  ];
}

// The hydrate used to run BEFORE config.env merged into process.env, so its
// "skip keys that already have a value" check naturally meant "skip keys the
// LAUNCH ENV set" — vault/keystore values beat persisted config, launch env
// beat both. Now that the agent boot defers the hydrate (it runs after the
// merge), the baseline preserves that exact precedence: the boot path records
// which handled keys the launch env set pre-merge, and `hasLaunchEnvValue`
// treats a post-merge value on a key absent from the baseline as
// overwritable. With no baseline captured (callers that still hydrate
// pre-merge, e.g. app-core's startApiServer), any present value is respected —
// the original semantics.
let walletEnvBootBaseline: ReadonlySet<string> | null = null;

/** Record which wallet/steward env keys currently hold values (pre-merge). */
export function captureWalletEnvBootBaseline(): void {
  const withValue = new Set<string>();
  for (const envKey of walletVaultKeys()) {
    if (process.env[envKey]?.trim()) withValue.add(String(envKey));
  }
  for (const [envKey] of stewardOsPairs()) {
    if (process.env[envKey]?.trim()) withValue.add(String(envKey));
  }
  walletEnvBootBaseline = withValue;
}

/** Test-only: drop the captured baseline (pre-merge semantics resume). */
export function _resetWalletEnvBootBaselineForTest(): void {
  walletEnvBootBaseline = null;
}

/**
 * True when `envKey`'s current process.env value must be respected: it either
 * predates the config merge (present in the captured baseline) or no baseline
 * was captured at all.
 */
function hasLaunchEnvValue(envKey: keyof NodeJS.ProcessEnv): boolean {
  const cur = process.env[envKey];
  if (typeof cur !== "string" || !cur.trim()) return false;
  return walletEnvBootBaseline === null
    ? true
    : walletEnvBootBaseline.has(String(envKey));
}

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
 * Persisted config only fills gaps that neither vault nor OS keystore
 * supplies — by call ordering on pre-merge callers, and via the captured
 * pre-merge baseline (see module header) on the deferred agent boot path.
 */
export async function hydrateWalletKeysFromNodePlatformSecureStore(): Promise<void> {
  // ── 1. Vault read for wallet keys ────────────────────────────────
  const vault = sharedVault();
  const missingWalletKeys: Array<keyof NodeJS.ProcessEnv> = [];
  for (const envKey of walletVaultKeys()) {
    if (hasLaunchEnvValue(envKey)) continue;
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
    for (const [envKey, kind] of stewardOsPairs()) {
      if (hasLaunchEnvValue(envKey)) continue;
      const got = await store.get(vaultId, kind);
      if (got.ok) process.env[envKey] = got.value;
    }
  } catch (err) {
    logger.warn(
      `[wallet][os-store] steward hydrate failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
