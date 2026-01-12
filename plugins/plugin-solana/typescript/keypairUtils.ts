import { type IAgentRuntime, logger } from "@elizaos/core";
import { Keypair, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";

export interface KeypairResult {
  keypair?: Keypair;
  publicKey?: PublicKey;
}

function getStringSetting(runtime: IAgentRuntime, key: string): string | null {
  const value = runtime.getSetting(key);
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== "string") {
    throw new Error(`Setting ${key} must be a string, got ${typeof value}`);
  }
  return value;
}

function generateAndStoreKeypair(runtime: IAgentRuntime): Keypair {
  const keypair = Keypair.generate();
  const privateKeyBase58 = bs58.encode(keypair.secretKey);
  const publicKeyBase58 = keypair.publicKey.toBase58();

  runtime.setSetting("SOLANA_PRIVATE_KEY", privateKeyBase58, true);
  runtime.setSetting("SOLANA_PUBLIC_KEY", publicKeyBase58, false);

  logger.warn("⚠️  No Solana wallet found in agent secrets. Generated new wallet automatically.");
  logger.warn(`📍 New Solana wallet address: ${publicKeyBase58}`);
  logger.warn("🔐 Private key has been stored securely in agent settings.");
  logger.warn("💡 Fund this wallet to enable SOL and token transfers.");

  return keypair;
}

export async function getWalletKey(
  runtime: IAgentRuntime,
  requirePrivateKey = true
): Promise<KeypairResult> {
  if (requirePrivateKey) {
    const privateKeyString =
      getStringSetting(runtime, "SOLANA_PRIVATE_KEY") ??
      getStringSetting(runtime, "WALLET_PRIVATE_KEY");

    if (!privateKeyString) {
      const keypair = generateAndStoreKeypair(runtime);
      return { keypair };
    }

    try {
      const secretKey = bs58.decode(privateKeyString);
      return { keypair: Keypair.fromSecretKey(secretKey) };
    } catch (e) {
      logger.log({ e }, "Error decoding base58 private key:");
      try {
        logger.log("Try decoding base64 instead");
        const secretKey = Uint8Array.from(Buffer.from(privateKeyString, "base64"));
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
          const secretKey = Uint8Array.from(Buffer.from(privateKeyString, "base64"));
          const keypair = Keypair.fromSecretKey(secretKey);
          return { publicKey: keypair.publicKey };
        } catch {}
      }
    }

    const keypair = generateAndStoreKeypair(runtime);
    return { publicKey: keypair.publicKey };
  }
}
