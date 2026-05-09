/**
 * Steward EVM Bridge — intercepts plugin-wallet EVM initialization in cloud-provisioned
 * containers to route signing through Steward API instead of local private keys.
 *
 * Strategy:
 *   1. Before the runtime starts plugins, check if we're in cloud-provisioned mode
 *   2. If so, create a Steward viem Account
 *   3. Inject a synthetic EVM_PRIVATE_KEY setting so initWalletProvider doesn't
 *      generate a random key, then immediately replace the account on the
 *      WalletProvider after EVMService starts
 *
 * This module exports a boot hook that should be called early in the runtime
 * initialization, before plugins are loaded.
 */

import { setStewardEvmBridgeActive } from "@elizaos/agent";
import type { IAgentRuntime } from "@elizaos/core";
import {
  initStewardEvmAccount,
  isStewardCloudProvisioned,
  isStewardSigningReady,
} from "./steward-evm-account";

// A dummy private key that satisfies validation but won't be used for actual signing.
// This is a well-known "zero" key — funds sent to its address are unrecoverable.
// It's only used as a placeholder so initWalletProvider doesn't generate a random key.
const DUMMY_PRIVATE_KEY =
  "0x0000000000000000000000000000000000000000000000000000000000000001";

/** Stash the account globally so we can retrieve it in the post-start hook. */
let _stewardAccount: Awaited<ReturnType<typeof initStewardEvmAccount>> = null;
let _initialized = false;

/**
 * Pre-boot hook: call before plugins are loaded.
 * Sets a dummy EVM_PRIVATE_KEY if in Steward cloud mode so that initWalletProvider
 * doesn't auto-generate and persist a random key.
 */
export async function stewardEvmPreBoot(runtime: IAgentRuntime): Promise<void> {
  if (process.env.ELIZA_LEGACY_STEWARD_EVM_BRIDGE === "0") {
    return;
  }
  if (!isStewardSigningReady()) {
    return;
  }

  console.log(
    isStewardCloudProvisioned()
      ? "[StewardEvmBridge] Cloud-provisioned Steward detected"
      : "[StewardEvmBridge] Self-hosted Steward detected",
  );

  try {
    _stewardAccount = await initStewardEvmAccount();
    if (_stewardAccount) {
      // Set the dummy key so initWalletProvider doesn't generate a random one
      // and doesn't try to persist it to the database
      const existing = runtime.getSetting("EVM_PRIVATE_KEY");
      if (!existing) {
        runtime.setSetting("EVM_PRIVATE_KEY", DUMMY_PRIVATE_KEY);
        console.log("[StewardEvmBridge] Set dummy EVM_PRIVATE_KEY placeholder");
      }
      // Expose the steward-managed address so getWalletAddresses() and
      // resolveWalletCapabilityStatus() can discover it synchronously,
      // even before initStewardWalletCache() runs.
      const addr = _stewardAccount.address;
      if (addr && addr !== "0x0000000000000000000000000000000000000000") {
        process.env.ELIZA_MANAGED_EVM_ADDRESS = addr;
        console.log(`[StewardEvmBridge] Set ELIZA_MANAGED_EVM_ADDRESS=${addr}`);
      }
      _initialized = true;
      setStewardEvmBridgeActive(true);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[StewardEvmBridge] Pre-boot failed: ${msg}`);
    console.warn("[StewardEvmBridge] Plugin-evm will use default key behavior");
  }
}

/**
 * Post-boot hook: call after plugins have started.
 * Replaces the WalletProvider's account on the EVMService with the Steward account.
 */
export async function stewardEvmPostBoot(
  runtime: IAgentRuntime,
): Promise<void> {
  if (process.env.ELIZA_LEGACY_STEWARD_EVM_BRIDGE === "0") {
    return;
  }
  if (!_initialized || !_stewardAccount) {
    return;
  }

  try {
    const evmService = runtime.getService("evm") as {
      walletProvider?: {
        _account?: unknown;
        getAddress?: () => string;
      };
    } | null;

    if (!evmService?.walletProvider) {
      console.warn(
        "[StewardEvmBridge] EVMService not found or no walletProvider — cannot inject Steward account",
      );
      return;
    }

    // Replace the account on the WalletProvider instance.
    // WalletProvider stores the account as `this._account` (see initializeAccount).
    // TypeScript doesn't expose it, but it's a simple property assignment.
    const wp = evmService.walletProvider as Record<string, unknown>;
    const oldAddress = (
      evmService.walletProvider as { getAddress?: () => string }
    ).getAddress?.();
    wp._account = _stewardAccount;

    const newAddress = (
      evmService.walletProvider as { getAddress?: () => string }
    ).getAddress?.();
    console.log(
      `[StewardEvmBridge] ✓ Replaced EVM account: ${oldAddress} → ${newAddress} (Steward-backed)`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[StewardEvmBridge] Post-boot failed: ${msg}`);
  }
}

/**
 * Get the Steward account if initialized (for use by other services).
 */
export function getStewardEvmAccount() {
  return _stewardAccount;
}

/**
 * Check if Steward EVM bridge is active.
 */
export function isStewardEvmBridgeActive(): boolean {
  return _initialized && _stewardAccount !== null;
}
