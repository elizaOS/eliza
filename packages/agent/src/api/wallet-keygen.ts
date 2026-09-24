/**
 * Owns local wallet key generation, address derivation, and Solana environment
 * synchronization. This leaf has no configuration or RPC imports, so config
 * loading can derive public keys without importing the wallet HTTP service.
 */
import crypto from "node:crypto";
import type {
  WalletChain,
  WalletGenerateResult,
  WalletKeys,
} from "@elizaos/shared";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import {
  assertSolanaBase58CharBudget,
  assertSolanaSecretCharBudget,
} from "./solana-secret-budget.ts";

function generateEvmPrivateKey(): string {
  return `0x${crypto.randomBytes(32).toString("hex")}`;
}

export function deriveEvmAddress(privateKeyHex: string): string {
  const cleaned = privateKeyHex.startsWith("0x")
    ? privateKeyHex.slice(2)
    : privateKeyHex;
  // Use @noble/curves — works in Node, Bun, and browsers.
  // (Node's crypto.createECDH("secp256k1") fails in Bun due to BoringSSL.)
  const pubKey = secp256k1.getPublicKey(Buffer.from(cleaned, "hex"), false); // uncompressed (65 bytes)
  const pubNoPrefix = pubKey.subarray(1); // drop the 04 prefix
  // Ethereum address = last 20 bytes of keccak-256(pubkey).
  const hash = Buffer.from(keccak_256(pubNoPrefix)).toString("hex");
  const raw = hash.slice(-40);
  return toChecksumEvmAddress(raw);
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

function generateSolanaKeypair(): { privateKey: string; publicKey: string } {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  const privBytes = privateKey.export({ type: "pkcs8", format: "der" });
  const pubBytes = publicKey.export({ type: "spki", format: "der" });
  // Ed25519 PKCS8 DER: raw 32-byte seed at offset 16; SPKI DER: raw 32-byte pubkey at offset 12
  const seed = (privBytes as Buffer).subarray(16, 48);
  const pubRaw = (pubBytes as Buffer).subarray(12, 44);
  // Solana secret key = seed(32) + pubkey(32)
  return {
    privateKey: base58Encode(Buffer.concat([seed, pubRaw])),
    publicKey: base58Encode(pubRaw),
  };
}

export function deriveSolanaAddress(privateKeyString: string): string {
  const secretBytes = decodeSolanaPrivateKey(privateKeyString);
  if (secretBytes.length === 64) return base58Encode(secretBytes.subarray(32));
  if (secretBytes.length === 32) {
    // Derive pubkey from 32-byte seed
    const keyObj = crypto.createPrivateKey({
      key: Buffer.concat([
        Buffer.from("302e020100300506032b657004220420", "hex"),
        secretBytes,
      ]),
      format: "der",
      type: "pkcs8",
    });
    const pubDer = crypto
      .createPublicKey(keyObj)
      .export({ type: "spki", format: "der" }) as Buffer;
    return base58Encode(pubDer.subarray(12, 44));
  }
  throw new Error(`Invalid Solana secret key length: ${secretBytes.length}`);
}

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58Encode(data: Buffer | Uint8Array): string {
  let num = BigInt(`0x${Buffer.from(data).toString("hex")}`);
  const chars: string[] = [];
  while (num > 0n) {
    const digit = B58[Number(num % 58n)];
    if (!digit) {
      throw new Error("Invalid base58 digit");
    }
    chars.unshift(digit);
    num /= 58n;
  }
  for (const byte of data) {
    if (byte === 0) chars.unshift("1");
    else break;
  }
  return chars.join("") || "1";
}

export function decodeSolanaBase58(str: string): Buffer {
  assertSolanaBase58CharBudget(str);
  if (str.length === 0) return Buffer.alloc(0);
  let num = 0n;
  for (const c of str) {
    const i = B58.indexOf(c);
    if (i === -1) throw new Error(`Invalid base58: ${c}`);
    num = num * 58n + BigInt(i);
  }
  const hex = num.toString(16).padStart(2, "0");
  const bytes = Buffer.from(hex.length % 2 ? `0${hex}` : hex, "hex");
  let zeros = 0;
  for (const c of str) {
    if (c === "1") zeros++;
    else break;
  }
  return zeros > 0 ? Buffer.concat([Buffer.alloc(zeros), bytes]) : bytes;
}

const PLACEHOLDER_RE =
  /^\[?\s*(REDACTED|PLACEHOLDER|T(?:O)D(?:O)|CHANGEME|EMPTY)\s*]?$/i;

/** Identifies configuration sentinels that do not represent wallet keys. */
export function isWalletKeyPlaceholder(value: string): boolean {
  return PLACEHOLDER_RE.test(value);
}

export function decodeSolanaPrivateKey(key: string): Buffer {
  assertSolanaSecretCharBudget(key);
  if (PLACEHOLDER_RE.test(key)) {
    throw new Error("placeholder value");
  }
  // Only attempt JSON array parse when the content looks like a numeric array
  // e.g. [1,2,3,...] — not [REDACTED] or other bracket-wrapped strings
  if (key.startsWith("[") && key.endsWith("]") && /^\[\s*\d/.test(key)) {
    try {
      const parsed = JSON.parse(key) as unknown;
      if (
        !Array.isArray(parsed) ||
        !parsed.every((v) => typeof v === "number")
      ) {
        throw new Error("not a numeric array");
      }
      return Buffer.from(parsed);
    } catch {
      // error-policy:J3 Reject malformed secret input at the key decoder.
      throw new Error("Invalid JSON byte-array format");
    }
  }
  return decodeSolanaBase58(key);
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

export function generateWalletForChain(
  chain: WalletChain,
): WalletGenerateResult {
  if (chain === "evm") {
    const pk = generateEvmPrivateKey();
    return { chain, address: deriveEvmAddress(pk), privateKey: pk };
  }
  const sol = generateSolanaKeypair();
  return {
    chain: "solana",
    address: sol.publicKey,
    privateKey: sol.privateKey,
  };
}

export function setSolanaWalletEnv(privateKey: string): string | null {
  const trimmed = privateKey.trim();
  process.env.SOLANA_PRIVATE_KEY = trimmed;
  return syncSolanaPublicKeyEnv(trimmed);
}

export function syncSolanaPublicKeyEnv(
  privateKey = process.env.SOLANA_PRIVATE_KEY,
): string | null {
  const trimmed = privateKey?.trim();
  if (!trimmed || PLACEHOLDER_RE.test(trimmed)) {
    return null;
  }

  try {
    const publicKey = deriveSolanaAddress(trimmed);
    process.env.SOLANA_PUBLIC_KEY = publicKey;
    process.env.WALLET_PUBLIC_KEY = publicKey;
    return publicKey;
  } catch {
    // error-policy:J3 Invalid key input has no derived public address.
    return null;
  }
}
