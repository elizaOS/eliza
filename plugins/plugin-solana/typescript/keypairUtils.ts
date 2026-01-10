import { type IAgentRuntime, logger } from "@elizaos/core";
import { Keypair, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";

/**
 * Interface representing the result of a keypair generation.
 * @typedef {Object} KeypairResult
 * @property {Keypair} [keypair] - The generated keypair.
 * @property {PublicKey} [publicKey] - The public key corresponding to the generated keypair.
 */
export interface KeypairResult {
  keypair?: Keypair;
  publicKey?: PublicKey;
}

/**
 * Gets either a keypair or public key based on TEE mode and runtime settings
 * @param runtime The agent runtime
 * @param requirePrivateKey Whether to return a full keypair (true) or just public key (false)
 * @returns KeypairResult containing either keypair or public key
 */
/**
 * Retrieves the wallet keypair or public key based on the specified runtime settings.
 *
 * @param {IAgentRuntime} runtime - The IAgentRuntime instance to retrieve settings from.
 * @param {boolean} [requirePrivateKey=true] - Specify whether the private key is required. Default is true.
 * @returns {Promise<KeypairResult>} The keypair result object containing the keypair or public key.
 */
/**
 * Extract a string setting from the runtime, throwing if not a string.
 */
function getStringSetting(
  runtime: IAgentRuntime,
  key: string,
): string | null {
  const value = runtime.getSetting(key);
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== "string") {
    throw new Error(`Setting ${key} must be a string, got ${typeof value}`);
  }
  return value;
}

export async function getWalletKey(
  runtime: IAgentRuntime,
  requirePrivateKey = true,
): Promise<KeypairResult> {
  // TEE mode is OFF
  if (requirePrivateKey) {
    const privateKeyString =
      getStringSetting(runtime, "SOLANA_PRIVATE_KEY") ??
      getStringSetting(runtime, "WALLET_PRIVATE_KEY");

    if (!privateKeyString) {
      throw new Error("Private key not found in settings");
    }

    try {
      // First try base58
      const secretKey = bs58.decode(privateKeyString);
      return { keypair: Keypair.fromSecretKey(secretKey) };
    } catch (e) {
      logger.log({ e }, "Error decoding base58 private key:");
      try {
        // Then try base64
        logger.log("Try decoding base64 instead");
        const secretKey = Uint8Array.from(
          Buffer.from(privateKeyString, "base64"),
        );
        return { keypair: Keypair.fromSecretKey(secretKey) };
      } catch (e2) {
        logger.error({ e: e2 }, "Error decoding private key: ");
        throw new Error("Invalid private key format");
      }
    }
  } else {
    const publicKeyString =
      getStringSetting(runtime, "SOLANA_PUBLIC_KEY") ??
      getStringSetting(runtime, "WALLET_PUBLIC_KEY");

    if (!publicKeyString) {
      throw new Error(
        "Solana Public key not found in settings, but plugin was loaded, please set SOLANA_PUBLIC_KEY",
      );
    }

    return { publicKey: new PublicKey(publicKeyString) };
  }
}
