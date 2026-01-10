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
 * Extract a string setting from the runtime, returning null if not found.
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

/**
 * Generate a new Solana keypair and store it in the runtime settings.
 * @param runtime The agent runtime to store the keypair in.
 * @returns The newly generated keypair.
 */
function generateAndStoreKeypair(runtime: IAgentRuntime): Keypair {
  const keypair = Keypair.generate();
  const privateKeyBase58 = bs58.encode(keypair.secretKey);
  const publicKeyBase58 = keypair.publicKey.toBase58();

  // Store the private key as a secret
  runtime.setSetting("SOLANA_PRIVATE_KEY", privateKeyBase58, true);
  // Also store the public key for convenience
  runtime.setSetting("SOLANA_PUBLIC_KEY", publicKeyBase58, false);

  logger.warn(
    "⚠️  No Solana wallet found in agent secrets. Generated new wallet automatically.",
  );
  logger.warn(`📍 New Solana wallet address: ${publicKeyBase58}`);
  logger.warn(
    "🔐 Private key has been stored securely in agent settings.",
  );
  logger.warn(
    "💡 Fund this wallet to enable SOL and token transfers.",
  );

  return keypair;
}

/**
 * Gets either a keypair or public key based on runtime settings.
 * If no keypair exists and one is required, a new keypair will be generated
 * and stored automatically.
 *
 * @param runtime The agent runtime
 * @param requirePrivateKey Whether to return a full keypair (true) or just public key (false)
 * @returns KeypairResult containing either keypair or public key
 */
export async function getWalletKey(
  runtime: IAgentRuntime,
  requirePrivateKey = true,
): Promise<KeypairResult> {
  if (requirePrivateKey) {
    const privateKeyString =
      getStringSetting(runtime, "SOLANA_PRIVATE_KEY") ??
      getStringSetting(runtime, "WALLET_PRIVATE_KEY");

    if (!privateKeyString) {
      // No private key found - generate a new one automatically
      const keypair = generateAndStoreKeypair(runtime);
      return { keypair };
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
    // When only public key is needed, check for existing keys first
    const publicKeyString =
      getStringSetting(runtime, "SOLANA_PUBLIC_KEY") ??
      getStringSetting(runtime, "WALLET_PUBLIC_KEY");

    if (publicKeyString) {
      return { publicKey: new PublicKey(publicKeyString) };
    }

    // No public key found, check if we have a private key to derive from
    const privateKeyString =
      getStringSetting(runtime, "SOLANA_PRIVATE_KEY") ??
      getStringSetting(runtime, "WALLET_PRIVATE_KEY");

    if (privateKeyString) {
      try {
        const secretKey = bs58.decode(privateKeyString);
        const keypair = Keypair.fromSecretKey(secretKey);
        return { publicKey: keypair.publicKey };
      } catch {
        try {
          const secretKey = Uint8Array.from(
            Buffer.from(privateKeyString, "base64"),
          );
          const keypair = Keypair.fromSecretKey(secretKey);
          return { publicKey: keypair.publicKey };
        } catch {
          // Fall through to generate new keypair
        }
      }
    }

    // No keys found at all - generate a new keypair
    const keypair = generateAndStoreKeypair(runtime);
    return { publicKey: keypair.publicKey };
  }
}
