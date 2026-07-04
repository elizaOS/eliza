/**
 * Generates fresh local wallet key material for the agent: a random secp256k1 EVM
 * private key with its EIP-55 checksummed address, and an ed25519 Solana keypair
 * encoded as base58. deriveEvmAddress recovers the address from a private key, and
 * setSolanaWalletEnv installs a Solana secret into the process env and re-syncs the
 * derived public-key env var. Pure key generation — no persistence or network.
 */
import crypto from "node:crypto";
import type { WalletKeys } from "@elizaos/shared/contracts/wallet";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { syncSolanaPublicKeyEnv } from "./wallet-env-sync.ts";

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58Encode(data: Buffer | Uint8Array): string {
  let num = BigInt(`0x${Buffer.from(data).toString("hex")}`);
  const chars: string[] = [];
  while (num > 0n) {
    chars.unshift(B58[Number(num % 58n)]);
    num /= 58n;
  }
  for (const byte of data) {
    if (byte === 0) chars.unshift("1");
    else break;
  }
  return chars.join("") || "1";
}

function generateEvmPrivateKey(): string {
  return `0x${crypto.randomBytes(32).toString("hex")}`;
}

function toChecksumEvmAddress(addressHex: string): string {
  const lower = addressHex.toLowerCase().replace(/^0x/, "");
  const hash = Buffer.from(keccak_256(Buffer.from(lower, "ascii"))).toString(
    "hex",
  );
  let out = "0x";
  for (let i = 0; i < lower.length; i += 1) {
    const char = lower[i];
    out += Number.parseInt(hash[i], 16) >= 8 ? char.toUpperCase() : char;
  }
  return out;
}

export function deriveEvmAddress(privateKeyHex: string): string {
  const cleaned = privateKeyHex.startsWith("0x")
    ? privateKeyHex.slice(2)
    : privateKeyHex;
  const pubKey = secp256k1.getPublicKey(Buffer.from(cleaned, "hex"), false);
  const hash = Buffer.from(keccak_256(pubKey.subarray(1))).toString("hex");
  return toChecksumEvmAddress(hash.slice(-40));
}

function generateSolanaKeypair(): { privateKey: string; publicKey: string } {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  const privBytes = privateKey.export({ type: "pkcs8", format: "der" });
  const pubBytes = publicKey.export({ type: "spki", format: "der" });
  const seed = (privBytes as Buffer).subarray(16, 48);
  const pubRaw = (pubBytes as Buffer).subarray(12, 44);
  return {
    privateKey: base58Encode(Buffer.concat([seed, pubRaw])),
    publicKey: base58Encode(pubRaw),
  };
}

export function generateWalletKeys(): WalletKeys {
  const evmPrivateKey = generateEvmPrivateKey();
  const solana = generateSolanaKeypair();
  return {
    evmPrivateKey,
    evmAddress: deriveEvmAddress(evmPrivateKey),
    solanaPrivateKey: solana.privateKey,
    solanaAddress: solana.publicKey,
  };
}

export function setSolanaWalletEnv(privateKey: string): string | null {
  const trimmed = privateKey.trim();
  process.env.SOLANA_PRIVATE_KEY = trimmed;
  return syncSolanaPublicKeyEnv(trimmed);
}
