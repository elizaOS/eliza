/**
 * HD wallet derivation — BIP-39 mnemonic + BIP-32 child-key derivation +
 * BIP-44 path conventions for EVM and Solana.
 *
 * This is the "12/24-word recovery phrase" UX consumer wallets ship. A user
 * generates a mnemonic once; every chain-specific keypair the wallet ever
 * uses is deterministically derived from it. The mnemonic is the entire
 * backup — write it down and you can re-create every key on every chain.
 *
 * Paths used here:
 *   EVM:    m/44'/60'/account'/0/index   (BIP-44 + Ethereum)
 *   Solana: m/44'/501'/account'/0'       (Phantom / Solflare convention)
 *
 * The EVM path is the canonical one used by every major wallet. The Solana
 * path matches Phantom's default; some wallets (Solflare deep paths) use
 * m/44'/501'/account'/0'/index' but Phantom's shape is far more widely
 * deployed and what users will recognize when they import a phrase.
 *
 * Mnemonic generation uses 128 bits of entropy for 12 words; 256 bits for
 * 24 words. Both are spec strengths. 24 words is recommended for any
 * material-value vault; 12 words is fine for ephemeral or low-value keys.
 *
 * Library: @scure/bip39 and @scure/bip32 — audited, no native deps.
 */

import { createHash } from "node:crypto";
import { HDKey } from "@scure/bip32";
import * as bip39 from "@scure/bip39";
import { wordlist as englishWordlist } from "@scure/bip39/wordlists/english";

const EVM_PATH_PREFIX = "m/44'/60'";
const SOLANA_PATH_PREFIX = "m/44'/501'";
const BITCOIN_NATIVE_SEGWIT_PATH_PREFIX = "m/84'";
const BITCOIN_TAPROOT_PATH_PREFIX = "m/86'";
const BECH32_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";

export type MnemonicStrength = 128 | 160 | 192 | 224 | 256;

/**
 * Generate a fresh BIP-39 mnemonic with the requested entropy.
 *   128 → 12 words   192 → 18 words   256 → 24 words
 * Defaults to 256 bits / 24 words.
 */
export function generateMnemonic(strength: MnemonicStrength = 256): string {
  if (![128, 160, 192, 224, 256].includes(strength)) {
    throw new Error("strength must be one of 128, 160, 192, 224, 256");
  }
  return bip39.generateMnemonic(englishWordlist, strength);
}

/** True if `mnemonic` is a valid BIP-39 phrase (checksum + wordlist verified). */
export function isValidMnemonic(mnemonic: string): boolean {
  if (typeof mnemonic !== "string") return false;
  return bip39.validateMnemonic(mnemonic.trim(), englishWordlist);
}

/** Derive the 64-byte BIP-39 seed (PBKDF2 with optional passphrase). */
export async function mnemonicToSeed(
  mnemonic: string,
  passphrase = "",
): Promise<Uint8Array> {
  if (!isValidMnemonic(mnemonic)) {
    throw new Error("invalid mnemonic — checksum or wordlist mismatch");
  }
  return bip39.mnemonicToSeed(mnemonic.trim(), passphrase);
}

export interface DerivedEvmKey {
  /** 0x-prefixed 32-byte hex. */
  privateKey: `0x${string}`;
  /** Uncompressed public key, 65 bytes hex (0x04 || X || Y). */
  publicKey: `0x${string}`;
  path: string;
}

/**
 * Derive an EVM account at index `account/0/index` (BIP-44 / Ethereum spec).
 *
 * Default path m/44'/60'/0'/0/0 — what MetaMask and every reference wallet
 * use for the first account. Importing the same mnemonic into MetaMask
 * yields the same address.
 */
export async function deriveEvmKey(
  mnemonic: string,
  options: { account?: number; index?: number; passphrase?: string } = {},
): Promise<DerivedEvmKey> {
  const account = options.account ?? 0;
  const index = options.index ?? 0;
  if (!Number.isInteger(account) || account < 0) {
    throw new Error("account must be a non-negative integer");
  }
  if (!Number.isInteger(index) || index < 0) {
    throw new Error("index must be a non-negative integer");
  }
  const seed = await mnemonicToSeed(mnemonic, options.passphrase);
  const root = HDKey.fromMasterSeed(seed);
  const path = `${EVM_PATH_PREFIX}/${account}'/0/${index}`;
  const child = root.derive(path);
  if (!child.privateKey || !child.publicKey) {
    throw new Error("derivation failed (no key material)");
  }
  return {
    privateKey: bytesToHex0x(child.privateKey),
    publicKey: bytesToHex0x(uncompressSecp256k1(child.publicKey)),
    path,
  };
}

export interface DerivedSolanaKey {
  /** 32-byte Ed25519 seed (the canonical "private key" form for Solana). */
  secretKey: Uint8Array;
  /** 32-byte Ed25519 public key. */
  publicKey: Uint8Array;
  path: string;
}

/**
 * Derive a Solana keypair at Phantom's path m/44'/501'/account'/0'.
 *
 * Ed25519 derivation is SLIP-10 (hardened-only). The implementation here is
 * intentionally self-contained — it follows the SLIP-10 spec exactly so we
 * do not add another transitive dependency for one well-defined function.
 */
export async function deriveSolanaKey(
  mnemonic: string,
  options: { account?: number; passphrase?: string } = {},
): Promise<DerivedSolanaKey> {
  const account = options.account ?? 0;
  if (!Number.isInteger(account) || account < 0) {
    throw new Error("account must be a non-negative integer");
  }
  const seed = await mnemonicToSeed(mnemonic, options.passphrase);
  const path = `${SOLANA_PATH_PREFIX}/${account}'/0'`;

  // SLIP-10 Ed25519: each step uses HMAC-SHA-512 with the chain code as key.
  // The first step seeds from "ed25519 seed".
  const initial = await hmacSha512(
    new TextEncoder().encode("ed25519 seed"),
    seed,
  );
  let key = initial.slice(0, 32);
  let chain = initial.slice(32, 64);

  const indices = [
    44 | 0x80000000,
    501 | 0x80000000,
    account | 0x80000000,
    0 | 0x80000000,
  ];
  for (const idx of indices) {
    const data = new Uint8Array(37);
    data[0] = 0x00;
    data.set(key, 1);
    data[33] = (idx >>> 24) & 0xff;
    data[34] = (idx >>> 16) & 0xff;
    data[35] = (idx >>> 8) & 0xff;
    data[36] = idx & 0xff;
    const I = await hmacSha512(chain, data);
    key = I.slice(0, 32);
    chain = I.slice(32, 64);
  }

  // Convert the 32-byte Ed25519 seed to the public key via the noble curves
  // wrapper that @scure/bip32 already brings in.
  const { ed25519 } = await import("@noble/curves/ed25519");
  const publicKey = ed25519.getPublicKey(key);
  return { secretKey: key, publicKey, path };
}

export type BitcoinNetwork = "mainnet" | "testnet";
export type BitcoinAddressType = "p2wpkh" | "p2tr";

export interface DerivedBitcoinKey {
  /** 0x-prefixed 32-byte secp256k1 private key at the derived BIP path. */
  privateKey: `0x${string}`;
  /** Compressed SEC1 public key, 33 bytes hex. */
  publicKey: `0x${string}`;
  /** X-only public key used by Taproot, 32 bytes hex. */
  xOnlyPublicKey: `0x${string}`;
  address: string;
  addressType: BitcoinAddressType;
  network: BitcoinNetwork;
  path: string;
}

/**
 * Derive a Bitcoin native SegWit (BIP-84/P2WPKH) or Taproot (BIP-86/P2TR)
 * receive/change key from the same BIP-39 seed used for the EVM/Solana wallet.
 *
 * This intentionally returns key material and address metadata only. Persisting
 * Bitcoin wallets requires a DB chain-family migration because the current
 * schema stores only EVM/Solana chain families.
 */
export async function deriveBitcoinKey(
  mnemonic: string,
  options: {
    addressType?: BitcoinAddressType;
    network?: BitcoinNetwork;
    account?: number;
    change?: 0 | 1;
    index?: number;
    passphrase?: string;
  } = {},
): Promise<DerivedBitcoinKey> {
  const addressType = options.addressType ?? "p2wpkh";
  const network = options.network ?? "mainnet";
  const account = options.account ?? 0;
  const change = options.change ?? 0;
  const index = options.index ?? 0;
  if (addressType !== "p2wpkh" && addressType !== "p2tr") {
    throw new Error("addressType must be p2wpkh or p2tr");
  }
  if (network !== "mainnet" && network !== "testnet") {
    throw new Error("network must be mainnet or testnet");
  }
  if (!Number.isInteger(account) || account < 0) {
    throw new Error("account must be a non-negative integer");
  }
  if (change !== 0 && change !== 1) {
    throw new Error("change must be 0 or 1");
  }
  if (!Number.isInteger(index) || index < 0) {
    throw new Error("index must be a non-negative integer");
  }

  const seed = await mnemonicToSeed(mnemonic, options.passphrase);
  const root = HDKey.fromMasterSeed(seed);
  const coinType = network === "mainnet" ? 0 : 1;
  const purpose =
    addressType === "p2tr"
      ? BITCOIN_TAPROOT_PATH_PREFIX
      : BITCOIN_NATIVE_SEGWIT_PATH_PREFIX;
  const path = `${purpose}/${coinType}'/${account}'/${change}/${index}`;
  const child = root.derive(path);
  if (!child.privateKey || !child.publicKey) {
    throw new Error("derivation failed (no key material)");
  }

  const publicKey = compressSecp256k1(child.publicKey);
  const xOnlyPublicKey = publicKey.slice(1);
  const hrp = network === "mainnet" ? "bc" : "tb";
  const address =
    addressType === "p2tr"
      ? encodeSegwitAddress(hrp, 1, taprootOutputKey(xOnlyPublicKey))
      : encodeSegwitAddress(hrp, 0, hash160(publicKey));

  return {
    privateKey: bytesToHex0x(child.privateKey),
    publicKey: bytesToHex0x(publicKey),
    xOnlyPublicKey: bytesToHex0x(xOnlyPublicKey),
    address,
    addressType,
    network,
    path,
  };
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function bytesToHex0x(bytes: Uint8Array): `0x${string}` {
  let out = "0x";
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, "0");
  }
  return out as `0x${string}`;
}

/**
 * Uncompress a 33-byte secp256k1 SEC1 public key to its 65-byte form. Used
 * because viem and most EVM tooling expect the uncompressed form for things
 * like `keccak256(pubkey).slice(-20) → address`.
 */
function uncompressSecp256k1(compressed: Uint8Array): Uint8Array {
  if (compressed.length === 65 && compressed[0] === 0x04) return compressed;
  if (
    compressed.length !== 33 ||
    (compressed[0] !== 0x02 && compressed[0] !== 0x03)
  ) {
    throw new Error(
      "expected compressed secp256k1 public key (33 bytes, 0x02/0x03 prefix)",
    );
  }
  // Defer to noble — @scure/bip32 depends on it, so it's already installed.
  const { secp256k1 } =
    require("@noble/curves/secp256k1") as typeof import("@noble/curves/secp256k1");
  const point = secp256k1.ProjectivePoint.fromHex(compressed);
  return point.toRawBytes(false);
}

function compressSecp256k1(publicKey: Uint8Array): Uint8Array {
  if (
    publicKey.length === 33 &&
    (publicKey[0] === 0x02 || publicKey[0] === 0x03)
  ) {
    return publicKey;
  }
  if (publicKey.length !== 65 || publicKey[0] !== 0x04) {
    throw new Error("expected secp256k1 public key");
  }
  const { secp256k1 } =
    require("@noble/curves/secp256k1") as typeof import("@noble/curves/secp256k1");
  const point = secp256k1.ProjectivePoint.fromHex(publicKey);
  return point.toRawBytes(true);
}

function hash160(bytes: Uint8Array): Uint8Array {
  return createHash("ripemd160")
    .update(createHash("sha256").update(bytes).digest())
    .digest();
}

function taprootOutputKey(xOnlyPublicKey: Uint8Array): Uint8Array {
  if (xOnlyPublicKey.length !== 32)
    throw new Error("Taproot x-only public key must be 32 bytes");
  const { secp256k1 } =
    require("@noble/curves/secp256k1") as typeof import("@noble/curves/secp256k1");
  const tweak =
    bytesToNumber(taggedHash("TapTweak", xOnlyPublicKey)) % secp256k1.CURVE.n;
  const internal = secp256k1.ProjectivePoint.fromHex(
    concatBytes(new Uint8Array([0x02]), xOnlyPublicKey),
  );
  const output =
    tweak === 0n
      ? internal
      : internal.add(secp256k1.ProjectivePoint.BASE.multiply(tweak));
  return output.toRawBytes(true).slice(1);
}

function taggedHash(tag: string, message: Uint8Array): Uint8Array {
  const tagHash = createHash("sha256").update(tag).digest();
  return createHash("sha256")
    .update(tagHash)
    .update(tagHash)
    .update(message)
    .digest();
}

function bytesToNumber(bytes: Uint8Array): bigint {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) + BigInt(byte);
  return value;
}

function encodeSegwitAddress(
  hrp: string,
  version: number,
  program: Uint8Array,
): string {
  if (version < 0 || version > 16) throw new Error("invalid witness version");
  const words = [version, ...convertBits(program, 8, 5, true)];
  return bech32Encode(hrp, words, version === 0 ? 1 : 0x2bc830a3);
}

function bech32Encode(
  hrp: string,
  words: number[],
  checksumConstant: number,
): string {
  const checksum = bech32CreateChecksum(hrp, words, checksumConstant);
  const combined = [...words, ...checksum];
  return `${hrp}1${combined.map((word) => BECH32_CHARSET[word]).join("")}`;
}

function bech32CreateChecksum(
  hrp: string,
  words: number[],
  checksumConstant: number,
): number[] {
  const values = [...bech32HrpExpand(hrp), ...words, 0, 0, 0, 0, 0, 0];
  const mod = bech32Polymod(values) ^ checksumConstant;
  const result: number[] = [];
  for (let p = 0; p < 6; p++) result.push((mod >> (5 * (5 - p))) & 31);
  return result;
}

function bech32HrpExpand(hrp: string): number[] {
  const high = Array.from(hrp, (char) => char.charCodeAt(0) >> 5);
  const low = Array.from(hrp, (char) => char.charCodeAt(0) & 31);
  return [...high, 0, ...low];
}

function bech32Polymod(values: number[]): number {
  const generator = [
    0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3,
  ];
  let chk = 1;
  for (const value of values) {
    const top = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ value;
    for (let i = 0; i < 5; i++) {
      if ((top >> i) & 1) chk ^= generator[i] as number;
    }
  }
  return chk;
}

function convertBits(
  data: Uint8Array,
  fromBits: number,
  toBits: number,
  pad: boolean,
): number[] {
  let acc = 0;
  let bits = 0;
  const result: number[] = [];
  const maxv = (1 << toBits) - 1;
  for (const value of data) {
    if (value < 0 || value >> fromBits !== 0)
      throw new Error("invalid value for bit conversion");
    acc = (acc << fromBits) | value;
    bits += fromBits;
    while (bits >= toBits) {
      bits -= toBits;
      result.push((acc >> bits) & maxv);
    }
  }
  if (pad && bits > 0) result.push((acc << (toBits - bits)) & maxv);
  if (!pad && (bits >= fromBits || ((acc << (toBits - bits)) & maxv) !== 0)) {
    throw new Error("invalid incomplete bit group");
  }
  return result;
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

async function hmacSha512(
  key: Uint8Array,
  message: Uint8Array,
): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key.buffer.slice(
      key.byteOffset,
      key.byteOffset + key.byteLength,
    ) as ArrayBuffer,
    { name: "HMAC", hash: "SHA-512" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    cryptoKey,
    message.buffer.slice(
      message.byteOffset,
      message.byteOffset + message.byteLength,
    ) as ArrayBuffer,
  );
  return new Uint8Array(sig);
}
