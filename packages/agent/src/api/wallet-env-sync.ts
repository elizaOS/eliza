/**
 * Lightweight Solana public-key env-sync helper extracted from wallet.ts
 * to break the circular dependency: config/config.ts → api/wallet.ts →
 * wallet-evm-balance.ts → wallet-rpc.ts → config/config.ts.
 *
 * This file must NOT import from ./wallet.ts or ../config/config.ts.
 */
import crypto from "node:crypto";

// ── Base58 (Bitcoin alphabet) — duplicated from wallet.ts to stay leaf-level ─

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

function base58Decode(str: string): Buffer {
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

// ── Helpers duplicated from wallet.ts ────────────────────────────────────

/** Sentinel values that appear as env placeholders — skip without error. */
const PLACEHOLDER_RE =
  /^\[?\s*(REDACTED|PLACEHOLDER|T(?:O)D(?:O)|CHANGEME|EMPTY)\s*]?$/i;

function decodeSolanaPrivateKey(key: string): Buffer {
  if (PLACEHOLDER_RE.test(key)) {
    throw new Error("placeholder value");
  }
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
      throw new Error("Invalid JSON byte-array format");
    }
  }
  return base58Decode(key);
}

function deriveSolanaAddress(privateKeyString: string): string {
  const secretBytes = decodeSolanaPrivateKey(privateKeyString);
  if (secretBytes.length === 64) return base58Encode(secretBytes.subarray(32));
  if (secretBytes.length === 32) {
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

// ── Exported function ────────────────────────────────────────────────────

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
    return null;
  }
}
