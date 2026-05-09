/**
 * Wallet key generation, address derivation, and balance/NFT fetching.
 * Uses Node crypto primitives + ethers (keccak-256 / checksum).
 * Balance data from Alchemy/Ankr (EVM), NodeReal/QuickNode (BSC RPC),
 * and Helius (Solana) REST APIs.
 *
 * DEX price oracle logic lives in ./wallet-dex-prices.ts
 * EVM balance + NFT fetching lives in ./wallet-evm-balance.ts
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { logger, resolveStateDir } from "@elizaos/core";
import type {
  KeyValidationResult,
  SolanaTokenBalance,
  WalletAddresses,
  WalletChain,
  WalletGenerateResult,
  WalletImportResult,
  WalletKeys,
} from "@elizaos/core";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { ethers } from "ethers";

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
  EvmTokenBalance,
  KeyValidationResult,
  SolanaTokenBalance,
  TradePermissionMode,
  WalletAddresses,
  WalletBalancesResponse,
  WalletChain,
  WalletConfigStatus,
  WalletGenerateResult,
  WalletImportResult,
  WalletKeys,
  WalletTradeLedgerEntry,
  WalletTradeSource,
  WalletTradingProfileResponse,
  WalletTradingProfileSourceFilter,
  WalletTradingProfileWindow,
} from "@elizaos/core";

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
  resolveEvmProviderKeys,
} from "./wallet-evm-balance";

// ── Constants ─────────────────────────────────────────────────────────

const FETCH_TIMEOUT_MS = 15_000;
export const MANAGED_EVM_ADDRESS_ENV_KEY = "ELIZA_MANAGED_EVM_ADDRESS";
export const MANAGED_SOLANA_ADDRESS_ENV_KEY = "ELIZA_MANAGED_SOLANA_ADDRESS";

/** Module-level cache for steward wallet addresses (avoids process.env mutation). */
let stewardAddressCache: { evm: string | null; solana: string | null } | null =
  null;

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
  const hash = ethers.keccak256(pubNoPrefix);
  const raw = hash.slice(26); // drop '0x' + first 24 hex chars (12 bytes)
  return ethers.getAddress(`0x${raw}`);
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
  /^\[?\s*(REDACTED|PLACEHOLDER|T(?:O)D(?:O)|CHANGEME|EMPTY)\s*]?$/i;

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
      error: `Derivation failed: ${String(err)}`,
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
      error: `Invalid key: ${String(err)}`,
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

export function setSolanaWalletEnv(privateKey: string): string | null {
  const trimmed = privateKey.trim();
  process.env.SOLANA_PRIVATE_KEY = trimmed;
  return syncSolanaPublicKeyEnv(trimmed);
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
  setSolanaWalletEnv(trimmed);
  logger.info(`[wallet] Imported Solana wallet: ${v.address}`);
  return { success: true, chain, address: v.address, error: null };
}

// ── Steward wallet cache env keys ─────────────────────────────────────

export const STEWARD_EVM_ADDRESS_ENV_KEY = "STEWARD_EVM_ADDRESS";
export const STEWARD_SOLANA_ADDRESS_ENV_KEY = "STEWARD_SOLANA_ADDRESS";

function resolveStewardCredentialsPath(): string {
  return path.join(resolveStateDir(), "steward-credentials.json");
}

type PersistedStewardCredentials = {
  apiUrl?: string;
  tenantId?: string;
  agentId?: string;
  apiKey?: string;
  agentToken?: string;
};

function normalizeOptionalString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readPersistedStewardCredentials(): {
  apiUrl: string | null;
  tenantId: string | null;
  agentId: string | null;
  apiKey: string | null;
  agentToken: string | null;
} | null {
  const credentialsPath = resolveStewardCredentialsPath();
  try {
    if (!fs.existsSync(credentialsPath)) {
      return null;
    }
    const parsed = JSON.parse(
      fs.readFileSync(credentialsPath, "utf8"),
    ) as PersistedStewardCredentials;
    return {
      apiUrl: normalizeOptionalString(parsed.apiUrl),
      tenantId: normalizeOptionalString(parsed.tenantId),
      agentId: normalizeOptionalString(parsed.agentId),
      apiKey: normalizeOptionalString(parsed.apiKey),
      agentToken: normalizeOptionalString(parsed.agentToken),
    };
  } catch {
    return null;
  }
}

/**
 * Initialise the steward wallet address cache.
 *
 * Call once during server startup.  Fetches addresses from the steward API
 * and writes them to `process.env.STEWARD_EVM_ADDRESS` /
 * `process.env.STEWARD_SOLANA_ADDRESS` so the synchronous
 * `getWalletAddresses()` can use them without hitting the network.
 */
export async function initStewardWalletCache(): Promise<void> {
  const persisted = readPersistedStewardCredentials();
  const stewardApiUrl =
    normalizeOptionalString(process.env.STEWARD_API_URL) ?? persisted?.apiUrl;
  if (!stewardApiUrl) return;

  const agentId =
    normalizeOptionalString(process.env.STEWARD_AGENT_ID) ||
    normalizeOptionalString(process.env.ELIZA_STEWARD_AGENT_ID) ||
    persisted?.agentId ||
    null;

  if (!agentId) return;

  try {
    const headers: Record<string, string> = { Accept: "application/json" };
    const bearerToken =
      normalizeOptionalString(process.env.STEWARD_AGENT_TOKEN) ??
      persisted?.agentToken;
    const apiKey =
      normalizeOptionalString(process.env.STEWARD_API_KEY) ?? persisted?.apiKey;
    const tenantId =
      normalizeOptionalString(process.env.STEWARD_TENANT_ID) ??
      persisted?.tenantId;

    if (bearerToken) {
      headers.Authorization = `Bearer ${bearerToken}`;
    } else if (apiKey) {
      headers["X-Steward-Key"] = apiKey;
    }
    if (tenantId) {
      headers["X-Steward-Tenant"] = tenantId;
    }

    const res = await fetch(
      `${stewardApiUrl}/agents/${encodeURIComponent(agentId)}`,
      { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) },
    );

    if (!res.ok) {
      logger.warn(
        `[wallet] Steward wallet cache init: agent lookup returned ${res.status}`,
      );
      return;
    }

    const body = (await res.json()) as {
      ok?: boolean;
      data?: {
        walletAddress?: string;
        walletAddresses?: { evm?: string; solana?: string };
      };
    };

    const agent =
      body.data ?? (body as unknown as NonNullable<typeof body.data>);
    const stewardEvm =
      agent?.walletAddresses?.evm?.trim() ||
      agent?.walletAddress?.trim() ||
      null;
    const stewardSolana = agent?.walletAddresses?.solana?.trim() || null;

    stewardAddressCache = { evm: stewardEvm, solana: stewardSolana };
    if (stewardEvm) {
      process.env[STEWARD_EVM_ADDRESS_ENV_KEY] = stewardEvm;
    } else {
      delete process.env[STEWARD_EVM_ADDRESS_ENV_KEY];
    }
    if (stewardSolana) {
      process.env[STEWARD_SOLANA_ADDRESS_ENV_KEY] = stewardSolana;
      if (!process.env.SOLANA_PUBLIC_KEY?.trim()) {
        process.env.SOLANA_PUBLIC_KEY = stewardSolana;
      }
      if (!process.env.WALLET_PUBLIC_KEY?.trim()) {
        process.env.WALLET_PUBLIC_KEY = stewardSolana;
      }
    } else {
      delete process.env[STEWARD_SOLANA_ADDRESS_ENV_KEY];
    }

    if (stewardEvm) {
      logger.info(`[wallet] Steward EVM address cached: ${stewardEvm}`);
    }
    if (stewardSolana) {
      logger.info(`[wallet] Steward Solana address cached: ${stewardSolana}`);
    }
  } catch (err) {
    logger.debug(`[wallet] Steward wallet cache init unavailable: ${err}`);
  }
}

/**
 * Derive addresses from env keys.  Works without a running runtime.
 *
 * Resolution order (steward-first):
 *   1. Steward cached addresses  (`STEWARD_EVM_ADDRESS` / `STEWARD_SOLANA_ADDRESS`)
 *   2. Local private key derivation  (`EVM_PRIVATE_KEY` / `SOLANA_PRIVATE_KEY`)
 *   3. Managed address env vars  (`ELIZA_MANAGED_EVM_ADDRESS` / `ELIZA_MANAGED_SOLANA_ADDRESS`)
 */
export function getWalletAddresses(): WalletAddresses {
  let evmAddress: string | null = null;
  let solanaAddress: string | null = null;

  // ── 1. Steward cached addresses (primary) ──────────────────────────
  const stewardEvm =
    stewardAddressCache?.evm?.trim() ??
    process.env[STEWARD_EVM_ADDRESS_ENV_KEY]?.trim();
  if (stewardEvm && /^0x[0-9a-fA-F]{40}$/.test(stewardEvm)) {
    evmAddress = stewardEvm;
  }

  const stewardSolana =
    stewardAddressCache?.solana?.trim() ??
    process.env[STEWARD_SOLANA_ADDRESS_ENV_KEY]?.trim();
  if (stewardSolana) {
    try {
      const decoded = base58Decode(stewardSolana);
      if (decoded.length === 32) {
        solanaAddress = stewardSolana;
      }
    } catch {
      // invalid — skip
    }
  }

  // ── 2. Local private key derivation (fallback) ─────────────────────
  if (!evmAddress) {
    const evmKey = process.env.EVM_PRIVATE_KEY;
    if (evmKey && !PLACEHOLDER_RE.test(evmKey)) {
      try {
        evmAddress = deriveEvmAddress(evmKey);
      } catch (e) {
        logger.warn(`Bad EVM key: ${e}`);
      }
    }
  }

  if (!solanaAddress) {
    const solKey = process.env.SOLANA_PRIVATE_KEY;
    if (solKey && !PLACEHOLDER_RE.test(solKey)) {
      try {
        solanaAddress = deriveSolanaAddress(solKey);
      } catch (e) {
        logger.warn(`Bad SOL key: ${e}`);
      }
    }
  }

  // ── 3. Managed address env vars (last resort) ──────────────────────
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

/**
 * Extended wallet addresses including steward-managed wallets.
 * Calls steward API (async) to discover additional addresses.
 * Key-derived addresses are always preferred; steward addresses fill gaps.
 */
export async function getWalletAddressesWithSteward(): Promise<
  WalletAddresses & {
    stewardEvmAddress?: string | null;
    stewardSolanaAddress?: string | null;
  }
> {
  const base = getWalletAddresses();

  // Only augment when steward is configured
  const stewardApiUrl = process.env.STEWARD_API_URL?.trim();
  if (!stewardApiUrl) {
    return base;
  }

  const agentId =
    process.env.STEWARD_AGENT_ID?.trim() ||
    process.env.ELIZA_STEWARD_AGENT_ID?.trim() ||
    base.evmAddress?.trim() ||
    null;

  if (!agentId) {
    return base;
  }

  try {
    const headers: Record<string, string> = {
      Accept: "application/json",
    };
    const bearerToken = process.env.STEWARD_AGENT_TOKEN?.trim();
    const apiKey = process.env.STEWARD_API_KEY?.trim();
    const tenantId = process.env.STEWARD_TENANT_ID?.trim();

    if (bearerToken) {
      headers.Authorization = `Bearer ${bearerToken}`;
    } else if (apiKey) {
      headers["X-Steward-Key"] = apiKey;
    }
    if (tenantId) {
      headers["X-Steward-Tenant"] = tenantId;
    }

    const res = await fetch(
      `${stewardApiUrl}/agents/${encodeURIComponent(agentId)}`,
      { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) },
    );

    if (!res.ok) {
      logger.warn(`Steward agent lookup returned ${res.status}`);
      return base;
    }

    const body = (await res.json()) as {
      ok?: boolean;
      data?: {
        walletAddress?: string;
        walletAddresses?: { evm?: string; solana?: string };
      };
    };

    const agent =
      body.data ?? (body as unknown as NonNullable<typeof body.data>);
    const stewardEvm =
      agent?.walletAddresses?.evm?.trim() ||
      agent?.walletAddress?.trim() ||
      null;
    const stewardSolana = agent?.walletAddresses?.solana?.trim() || null;

    return {
      evmAddress: base.evmAddress ?? stewardEvm,
      solanaAddress: base.solanaAddress ?? stewardSolana,
      stewardEvmAddress: stewardEvm,
      stewardSolanaAddress: stewardSolana,
    };
  } catch (err) {
    logger.warn(`Steward wallet address lookup failed: ${err}`);
    return base;
  }
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
    logger.warn(`SOL balance fetch failed: ${String(err)}`);
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
    logger.warn(`Solana token fetch failed: ${String(err)}`);
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
      const msg = String(err);
      errors.push(`${describeRpcEndpoint(rpcUrl)}: ${msg}`);
    }
  }

  throw new Error(errors.join(" | ").slice(0, 400) || "Solana RPC unavailable");
}
