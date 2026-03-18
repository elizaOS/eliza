/**
 * Wallet key generation, address derivation, and balance/NFT fetching.
 * Uses Node crypto primitives (no viem/@solana/web3.js dependency).
 * Balance data from Alchemy/Ankr (EVM), NodeReal/QuickNode (BSC RPC),
 * and Helius (Solana) REST APIs.
 *
 * DEX price oracle logic lives in ./wallet-dex-prices.ts
 * EVM balance + NFT fetching lives in ./wallet-evm-balance.ts
 */
import crypto from "node:crypto";
import { logger } from "@elizaos/core";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import type {
  KeyValidationResult,
  SolanaNft,
  SolanaTokenBalance,
  WalletAddresses,
  WalletChain,
  WalletGenerateResult,
  WalletImportResult,
  WalletKeys,
} from "../contracts/wallet";

// ── Re-exports from contracts/wallet ──────────────────────────────────

export type {
  BscTradeExecuteRequest,
  BscTradeExecuteResponse,
  BscTradeExecutionResult,
  BscTradePreflightRequest,
  BscTradePreflightResponse,
  BscTradeQuoteRequest,
  BscTradeQuoteResponse,
  BscTradeSide,
  BscTradeTxStatus,
  BscTradeTxStatusResponse,
  BscTransferExecuteRequest,
  BscTransferExecuteResponse,
  BscTransferExecutionResult,
  BscUnsignedApprovalTx,
  BscUnsignedTradeTx,
  BscUnsignedTransferTx,
  EvmChainBalance,
  EvmNft,
  EvmTokenBalance,
  KeyValidationResult,
  SolanaNft,
  SolanaTokenBalance,
  TradePermissionMode,
  WalletAddresses,
  WalletBalancesResponse,
  WalletChain,
  WalletConfigStatus,
  WalletGenerateResult,
  WalletImportResult,
  WalletKeys,
  WalletNftsResponse,
  WalletTradeLedgerEntry,
  WalletTradeSource,
  WalletTradingProfileResponse,
  WalletTradingProfileSourceFilter,
  WalletTradingProfileWindow,
} from "../contracts/wallet";

// ── Re-exports from extracted modules ─────────────────────────────────

export {
  computeValueUsd,
  DEX_PRICE_TIMEOUT_MS,
  DEXPAPRIKA_CHAIN_MAP,
  DEXSCREENER_CHAIN_MAP,
  type DexScreenerPair,
  type DexTokenMeta,
  fetchDexPaprikaPrices,
  fetchDexPrices,
  fetchDexScreenerPrices,
  WRAPPED_NATIVE,
} from "./wallet-dex-prices";

export {
  type AnkrTokenAsset,
  DEFAULT_EVM_CHAINS,
  type EvmProviderKeys,
  fetchEvmBalances,
  fetchEvmNfts,
  resolveEvmProviderKeys,
} from "./wallet-evm-balance";

// ── Constants ─────────────────────────────────────────────────────────

const FETCH_TIMEOUT_MS = 15_000;
export const MANAGED_EVM_ADDRESS_ENV_KEY = "MILADY_MANAGED_EVM_ADDRESS";
export const MANAGED_SOLANA_ADDRESS_ENV_KEY = "MILADY_MANAGED_SOLANA_ADDRESS";

// ── EVM key derivation (secp256k1 via @noble/curves + keccak-256) ─────

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
  const hash = keccak256(pubNoPrefix);
  return toChecksumAddress(`0x${hash.subarray(12).toString("hex")}`);
}

// ── Keccak-256 (minimal sponge implementation) ───────────────────────

const RC = [
  0x0000000000000001n,
  0x0000000000008082n,
  0x800000000000808an,
  0x8000000080008000n,
  0x000000000000808bn,
  0x0000000080000001n,
  0x8000000080008081n,
  0x8000000000008009n,
  0x000000000000008an,
  0x0000000000000088n,
  0x0000000080008009n,
  0x000000008000000an,
  0x000000008000808bn,
  0x800000000000008bn,
  0x8000000000008089n,
  0x8000000000008003n,
  0x8000000000008002n,
  0x8000000000000080n,
  0x000000000000800an,
  0x800000008000000an,
  0x8000000080008081n,
  0x8000000000008080n,
  0x0000000080000001n,
  0x8000000080008008n,
];

const ROT = [
  [0, 36, 3, 41, 18],
  [1, 44, 10, 45, 2],
  [62, 6, 43, 15, 61],
  [28, 55, 25, 21, 56],
  [27, 20, 39, 8, 14],
];

function keccak256(data: Buffer | Uint8Array): Buffer {
  const rate = 136; // 1088 bits
  const state: bigint[][] = Array.from({ length: 5 }, () =>
    Array.from({ length: 5 }, () => 0n),
  );

  // Keccak padding (0x01, NOT SHA-3's 0x06)
  const q = rate - (data.length % rate);
  const padded = Buffer.alloc(data.length + q);
  padded.set(data);
  padded[data.length] = 0x01;
  padded[padded.length - 1] |= 0x80;

  // Absorb
  for (let off = 0; off < padded.length; off += rate) {
    for (let i = 0; i < rate / 8; i++) {
      let w = 0n;
      for (let b = 0; b < 8; b++)
        w |= BigInt(padded[off + i * 8 + b]) << BigInt(b * 8);
      state[i % 5][Math.floor(i / 5)] ^= w;
    }
    keccakF1600(state);
  }

  // Squeeze (32 bytes)
  const out = Buffer.alloc(32);
  for (let i = 0; i < 4; i++) {
    const v = state[i % 5][Math.floor(i / 5)];
    for (let b = 0; b < 8; b++)
      out[i * 8 + b] = Number((v >> BigInt(b * 8)) & 0xffn);
  }
  return out;
}

function keccakF1600(state: bigint[][]): void {
  const M = (1n << 64n) - 1n;
  const rot = (v: bigint, s: number) =>
    s === 0 ? v : ((v << BigInt(s)) | (v >> BigInt(64 - s))) & M;

  for (let round = 0; round < 24; round++) {
    // theta
    const c: bigint[] = [];
    for (let x = 0; x < 5; x++)
      c[x] =
        state[x][0] ^ state[x][1] ^ state[x][2] ^ state[x][3] ^ state[x][4];
    for (let x = 0; x < 5; x++) {
      const d = c[(x + 4) % 5] ^ rot(c[(x + 1) % 5], 1);
      for (let y = 0; y < 5; y++) state[x][y] = (state[x][y] ^ d) & M;
    }
    // rho + pi
    const b: bigint[][] = Array.from({ length: 5 }, () =>
      Array.from({ length: 5 }, () => 0n),
    );
    for (let x = 0; x < 5; x++)
      for (let y = 0; y < 5; y++)
        b[y][(2 * x + 3 * y) % 5] = rot(state[x][y], ROT[x][y]);
    // chi
    for (let x = 0; x < 5; x++)
      for (let y = 0; y < 5; y++)
        state[x][y] =
          (b[x][y] ^ (~b[(x + 1) % 5][y] & M & b[(x + 2) % 5][y])) & M;
    // iota
    state[0][0] = (state[0][0] ^ RC[round]) & M;
  }
}

function toChecksumAddress(address: string): string {
  const addr = address.toLowerCase().replace("0x", "");
  const hash = keccak256(Buffer.from(addr, "utf8")).toString("hex");
  let out = "0x";
  for (let i = 0; i < 40; i++)
    out += Number.parseInt(hash[i], 16) >= 8 ? addr[i].toUpperCase() : addr[i];
  return out;
}

// ── Solana key derivation (Ed25519 via Node crypto) ───────────────────

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

// ── Base58 (Bitcoin alphabet) ─────────────────────────────────────────

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

/** Sentinel values that appear as env placeholders – skip without error. */
const PLACEHOLDER_RE =
  /^\[?\s*(REDACTED|PLACEHOLDER|TODO|CHANGEME|EMPTY)\s*]?$/i;

function decodeSolanaPrivateKey(key: string): Buffer {
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
      throw new Error("Invalid JSON byte-array format");
    }
  }
  return base58Decode(key);
}

// ── Key validation ────────────────────────────────────────────────────

const HEX_RE = /^[0-9a-fA-F]+$/;

export function validateEvmPrivateKey(key: string): KeyValidationResult {
  const cleaned = key.startsWith("0x") ? key.slice(2) : key;
  if (cleaned.length !== 64)
    return {
      valid: false,
      chain: "evm",
      address: null,
      error: "Must be 64 hex characters",
    };
  if (!HEX_RE.test(cleaned))
    return {
      valid: false,
      chain: "evm",
      address: null,
      error: "Invalid hex characters",
    };
  try {
    return {
      valid: true,
      chain: "evm",
      address: deriveEvmAddress(key),
      error: null,
    };
  } catch (err) {
    return {
      valid: false,
      chain: "evm",
      address: null,
      error: `Derivation failed: ${err instanceof Error ? err.message : err}`,
    };
  }
}

export function validateSolanaPrivateKey(key: string): KeyValidationResult {
  try {
    const bytes = decodeSolanaPrivateKey(key);
    if (bytes.length !== 64 && bytes.length !== 32) {
      return {
        valid: false,
        chain: "solana",
        address: null,
        error: `Must be 32 or 64 bytes, got ${bytes.length}`,
      };
    }
    return {
      valid: true,
      chain: "solana",
      address: deriveSolanaAddress(key),
      error: null,
    };
  } catch (err) {
    return {
      valid: false,
      chain: "solana",
      address: null,
      error: `Invalid key: ${err instanceof Error ? err.message : err}`,
    };
  }
}

/** Auto-detect chain from key format and validate. */
export function validatePrivateKey(key: string): KeyValidationResult {
  const trimmed = key.trim();
  if (
    trimmed.startsWith("0x") ||
    (trimmed.length === 64 && HEX_RE.test(trimmed))
  )
    return validateEvmPrivateKey(trimmed);
  return validateSolanaPrivateKey(trimmed);
}

/** Mask a secret string for safe display (e.g. logs, UI). */
export function maskSecret(value: string): string {
  if (!value || value.length <= 8) return "****";
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

// ── Key generation ────────────────────────────────────────────────────

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

/** Validate key, store in process.env. Caller persists to config if needed. */
export function importWallet(
  chain: WalletChain,
  privateKey: string,
): WalletImportResult {
  const trimmed = privateKey.trim();
  if (chain === "evm") {
    const v = validateEvmPrivateKey(trimmed);
    if (!v.valid)
      return { success: false, chain, address: null, error: v.error };
    process.env.EVM_PRIVATE_KEY = trimmed.startsWith("0x")
      ? trimmed
      : `0x${trimmed}`;
    logger.info(`[wallet] Imported EVM wallet: ${v.address}`);
    return { success: true, chain, address: v.address, error: null };
  }
  const v = validateSolanaPrivateKey(trimmed);
  if (!v.valid) return { success: false, chain, address: null, error: v.error };
  process.env.SOLANA_PRIVATE_KEY = trimmed;
  logger.info(`[wallet] Imported Solana wallet: ${v.address}`);
  return { success: true, chain, address: v.address, error: null };
}

/** Derive addresses from env keys. Works without a running runtime. */
export function getWalletAddresses(): WalletAddresses {
  let evmAddress: string | null = null;
  let solanaAddress: string | null = null;
  const evmKey = process.env.EVM_PRIVATE_KEY;
  if (evmKey && !PLACEHOLDER_RE.test(evmKey)) {
    try {
      evmAddress = deriveEvmAddress(evmKey);
    } catch (e) {
      logger.warn(`Bad EVM key: ${e}`);
    }
  }
  const solKey = process.env.SOLANA_PRIVATE_KEY;
  if (solKey && !PLACEHOLDER_RE.test(solKey)) {
    try {
      solanaAddress = deriveSolanaAddress(solKey);
    } catch (e) {
      logger.warn(`Bad SOL key: ${e}`);
    }
  }

  if (!evmAddress) {
    const managedEvmAddress = process.env[MANAGED_EVM_ADDRESS_ENV_KEY];
    if (managedEvmAddress) {
      const trimmed = managedEvmAddress.trim();
      if (/^0x[0-9a-fA-F]{40}$/.test(trimmed)) {
        evmAddress = trimmed;
      } else {
        logger.warn("Bad managed EVM address in env");
      }
    }
  }

  if (!solanaAddress) {
    const managedSolanaAddress = process.env[MANAGED_SOLANA_ADDRESS_ENV_KEY];
    if (managedSolanaAddress) {
      const trimmed = managedSolanaAddress.trim();
      try {
        const decoded = base58Decode(trimmed);
        if (decoded.length === 32) {
          solanaAddress = trimmed;
        } else {
          logger.warn("Bad managed Solana address in env");
        }
      } catch {
        logger.warn("Bad managed Solana address in env");
      }
    }
  }

  return { evmAddress, solanaAddress };
}

// ── Helius API (Solana tokens + NFTs) ─────────────────────────────────

interface HeliusAsset {
  id: string;
  interface: string;
  content?: {
    metadata?: { name?: string; symbol?: string; description?: string };
    links?: { image?: string };
  };
  token_info?: {
    balance?: number;
    decimals?: number;
    price_info?: { total_price?: number };
    symbol?: string;
  };
  grouping?: Array<{
    group_key?: string;
    collection_metadata?: { name?: string };
  }>;
}

function rpcJsonRequest(body: string): RequestInit {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    body,
  };
}

function describeRpcEndpoint(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "rpc";
  }
}

/** Parse JSON from a fetch response. If the body isn't JSON, throw with the raw text. */
async function jsonOrThrow<T>(res: Response): Promise<T> {
  const text = await res.text();
  if (!res.ok) throw new Error(text.slice(0, 200) || `HTTP ${res.status}`);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(text.slice(0, 200) || "Invalid JSON");
  }
}

export async function fetchSolanaBalances(
  address: string,
  heliusKey: string,
): Promise<{
  solBalance: string;
  solValueUsd: string;
  tokens: SolanaTokenBalance[];
}> {
  const url = `https://mainnet.helius-rpc.com/?api-key=${heliusKey}`;
  const rpc = (body: string): RequestInit => ({
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    body,
  });

  let solBalance = "0";
  try {
    const data = await jsonOrThrow<{
      result?: { value?: number };
      error?: { message?: string };
    }>(
      await fetch(
        url,
        rpc(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "getBalance",
            params: [address],
          }),
        ),
      ),
    );
    if (data.error?.message) throw new Error(data.error.message);
    solBalance = ((data.result?.value ?? 0) / 1e9).toFixed(9);
  } catch (err) {
    logger.warn(
      `SOL balance fetch failed: ${err instanceof Error ? err.message : err}`,
    );
  }

  const tokens: SolanaTokenBalance[] = [];
  try {
    const data = await jsonOrThrow<{
      result?: { items?: HeliusAsset[] };
      error?: { message?: string };
    }>(
      await fetch(
        url,
        rpc(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 2,
            method: "getAssetsByOwner",
            params: {
              ownerAddress: address,
              displayOptions: { showFungible: true, showNativeBalance: true },
              page: 1,
              limit: 100,
            },
          }),
        ),
      ),
    );
    if (data.error?.message) throw new Error(data.error.message);
    for (const item of data.result?.items ?? []) {
      if (
        item.interface !== "FungibleToken" &&
        item.interface !== "FungibleAsset"
      )
        continue;
      const dec = item.token_info?.decimals ?? 0;
      const raw = item.token_info?.balance ?? 0;
      tokens.push({
        symbol:
          item.token_info?.symbol ?? item.content?.metadata?.symbol ?? "???",
        name: item.content?.metadata?.name ?? "Unknown",
        mint: item.id,
        balance: dec > 0 ? (raw / 10 ** dec).toString() : raw.toString(),
        decimals: dec,
        valueUsd: item.token_info?.price_info?.total_price?.toFixed(2) ?? "0",
        logoUrl: item.content?.links?.image ?? "",
      });
    }
  } catch (err) {
    logger.warn(
      `Solana token fetch failed: ${err instanceof Error ? err.message : err}`,
    );
  }

  return { solBalance, solValueUsd: "0", tokens };
}

export async function fetchSolanaNativeBalanceViaRpc(
  address: string,
  rpcUrls: string[],
): Promise<{
  solBalance: string;
  solValueUsd: string;
  tokens: SolanaTokenBalance[];
}> {
  const urls = [...new Set(rpcUrls)].filter((u) => Boolean(u?.trim()));
  const errors: string[] = [];

  for (const rpcUrl of urls) {
    try {
      const data = await jsonOrThrow<{
        result?: { value?: number };
        error?: { message?: string };
      }>(
        await fetch(
          rpcUrl,
          rpcJsonRequest(
            JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: "getBalance",
              params: [address],
            }),
          ),
        ),
      );
      if (data.error?.message) throw new Error(data.error.message);

      const solBalance = ((data.result?.value ?? 0) / 1e9).toFixed(9);
      return { solBalance, solValueUsd: "0", tokens: [] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`${describeRpcEndpoint(rpcUrl)}: ${msg}`);
    }
  }

  throw new Error(errors.join(" | ").slice(0, 400) || "Solana RPC unavailable");
}

export async function fetchSolanaNfts(
  address: string,
  heliusKey: string,
): Promise<SolanaNft[]> {
  const url = `https://mainnet.helius-rpc.com/?api-key=${heliusKey}`;
  try {
    const data = await jsonOrThrow<{
      result?: { items?: HeliusAsset[] };
      error?: { message?: string };
    }>(
      await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "getAssetsByOwner",
          params: {
            ownerAddress: address,
            displayOptions: { showFungible: false },
            page: 1,
            limit: 100,
          },
        }),
      }),
    );
    if (data.error?.message) throw new Error(data.error.message);
    const items = data.result?.items ?? [];
    return items
      .filter(
        (i) =>
          i.interface === "V1_NFT" ||
          i.interface === "ProgrammableNFT" ||
          i.interface === "V2_NFT",
      )
      .map((i) => ({
        mint: i.id,
        name: i.content?.metadata?.name ?? "Untitled",
        description: (i.content?.metadata?.description ?? "").slice(0, 200),
        imageUrl: i.content?.links?.image ?? "",
        collectionName:
          i.grouping?.find((g) => g.group_key === "collection")
            ?.collection_metadata?.name ?? "",
      }));
  } catch (err) {
    logger.warn(`Solana NFT fetch failed: ${err}`);
    return [];
  }
}
