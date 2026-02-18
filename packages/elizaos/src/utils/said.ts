/**
 * SAID Protocol Integration
 *
 * Registers ElizaOS agents with SAID Protocol — on-chain identity for AI agents on Solana.
 * Every new ElizaOS agent gets a free Solana identity automatically.
 *
 * SAID Protocol: https://saidprotocol.com
 * Docs: https://saidprotocol.com/docs.html
 */

import * as crypto from "node:crypto";

const SAID_API = "https://api.saidprotocol.com";

export interface SAIDRegistration {
  wallet: string;
  pda: string;
  profileUrl: string;
  registeredAt: string;
}

export interface SAIDWallet {
  publicKey: string;
  secretKey: string;
  createdAt: string;
}

/**
 * Generate a Solana-compatible Ed25519 keypair without requiring the full Solana SDK.
 */
export function generateSolanaKeypair(): SAIDWallet {
  const keypair = crypto.generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "der" },
    privateKeyEncoding: { type: "pkcs8", format: "der" },
  });

  // Extract raw 32-byte public key from DER (last 32 bytes of spki)
  const publicKeyBytes = keypair.publicKey.slice(-32);
  // Extract raw 32-byte private key from DER (bytes 16-48 of pkcs8)
  const privateKeyBytes = keypair.privateKey.slice(16, 48);
  // Solana secret key = privateKey (32 bytes) + publicKey (32 bytes)
  const secretKeyBytes = Buffer.concat([privateKeyBytes, publicKeyBytes]);

  return {
    publicKey: bs58Encode(publicKeyBytes),
    secretKey: bs58Encode(secretKeyBytes),
    createdAt: new Date().toISOString(),
  };
}

/**
 * Minimal base58 encoder (avoids heavy deps).
 */
function bs58Encode(bytes: Buffer): string {
  const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let num = BigInt(`0x${bytes.toString("hex")}`);
  let result = "";
  while (num > 0n) {
    result = ALPHABET[Number(num % 58n)] + result;
    num = num / 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    result = "1" + result;
  }
  return result;
}

/**
 * Register an ElizaOS agent with SAID Protocol.
 * Returns the SAID profile URL on success, null on failure.
 */
export async function registerWithSAID(
  wallet: string,
  name: string,
  options: {
    description?: string;
    website?: string;
    skills?: string[];
  } = {},
): Promise<SAIDRegistration | null> {
  try {
    const res = await fetch(`${SAID_API}/api/register/pending`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        wallet,
        name,
        description: options.description || `ElizaOS agent — ${name}`,
        capabilities: options.skills || ["conversation", "autonomous-tasks"],
        source: "elizaos",
        ...(options.website && { website: options.website }),
      }),
    });

    if (!res.ok) return null;

    const data = (await res.json()) as { wallet?: string; pda?: string };
    return {
      wallet: data.wallet || wallet,
      pda: data.pda || "",
      profileUrl: `https://saidprotocol.com/agents/${data.wallet || wallet}`,
      registeredAt: new Date().toISOString(),
    };
  } catch {
    return null;
  }
}
